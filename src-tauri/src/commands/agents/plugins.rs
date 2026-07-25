//! Plugins par convention de répertoires (P6.7 — format compatible Claude Code).
//!
//! ## Racines de découverte
//!
//!   * utilisateur : `~/.shugu/plugins/<name>/`
//!   * projet      : `<workspace>/.shugu/plugins/<name>/`
//!   * cache Claude Code (LECTURE SEULE — Shugu n'écrit JAMAIS dans
//!     `~/.claude`) : `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`
//!     — la dernière version par plugin, et seulement les plugins installés
//!     (`installed_plugins.json`) et activés (`settings.json.enabledPlugins`)
//!     quand ces fichiers existent (parsing tolérant, documenté plus bas).
//!
//! ## Manifeste
//!
//! `<root>/plugin.json` ou `<root>/.claude-plugin/plugin.json` (les deux sont
//! acceptés) — `{ name, version?, description?, author? }`. Un dossier sans
//! manifeste mais avec du contenu conventionnel est découvert quand même
//! (name = nom du dossier).
//!
//! ## Contributions conventionnelles
//!
//!   * `commands/*.md`     → slash commands (frontmatter `description`,
//!     `allowed-tools`), namespacés `plugin:command` en cas de collision ;
//!   * `agents/*.md`       → agent defs via le pipeline `agent_defs` existant
//!     (même parseur, scope "plugin:<name>") ;
//!   * `skills/*/SKILL.md` → skills fichiers (cf. `file_skills.rs`, P6.8) ;
//!   * `hooks/hooks.json`  → mergés dans le moteur hooks (P6.4) avec source
//!     "plugin:<name>" — un plugin désactivé retire ses hooks atomiquement ;
//!   * `.mcp.json`         → serveurs MCP **en attente d'approbation** : jamais
//!     démarrés sans geste explicite ; approbation persistée en SQLite settings
//!     (clé = plugin + serveur + empreinte de la configuration — si elle change,
//!     l'approbation est caduque).
//!
//! ## Enable/disable
//!
//! Persisté dans `settings.plugins_disabled` (JSON array d'ids
//! "source:name") — on ne réécrit JAMAIS les fichiers de l'utilisateur. Un
//! plugin désactivé = ZÉRO contribution (commands, agents, skills, hooks,
//! MCP en attente masqués).

use rusqlite::Connection;
use serde::Serialize;
use sha2::Digest;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::commands::agent_defs::{parse_agent_md, AgentDef};
use crate::commands::mcp::{parse_mcp_config, McpServerConfig};

use super::hooks::{self, HookDef, HookSource};

// ────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PluginSource {
    /// `~/.shugu/plugins/<name>/`
    User,
    /// `<workspace>/.shugu/plugins/<name>/`
    Project,
    /// `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` (read-only).
    ClaudeCache,
}

impl PluginSource {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
            Self::ClaudeCache => "claude-cache",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Plugin {
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub source: PluginSource,
    pub root: PathBuf,
}

impl Plugin {
    /// Id stable "source:name" — clé de l'enable/disable Settings.
    pub(crate) fn id(&self) -> String {
        format!("{}:{}", self.source.as_str(), self.name)
    }
}

/// Une slash command fournie par un plugin (`commands/*.md`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub plugin: String,
    /// Nom du fichier (sans .md).
    pub name: String,
    /// Nom effectif : `plugin:command` en cas de collision avec une commande
    /// d'un AUTRE plugin (le frontend applique la même règle pour les agents).
    pub namespaced_name: String,
    pub description: String,
    pub allowed_tools: Vec<String>,
    pub body: String,
}

/// Un serveur MCP déclaré par un plugin (`.mcp.json`) avec son statut
/// d'approbation courant.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServerInfo {
    pub plugin: String,
    pub server: String,
    /// "stdio" | "http" | "invalid".
    pub transport: String,
    /// Aperçu non secret de la commande/url (tronqué).
    pub command_preview: String,
    /// Empreinte de la configuration ACTUELLE — l'approbation est caduque si
    /// commande, arguments, environnement ou URL changent.
    pub command_hash: String,
    /// "pending" | "approved" | "rejected".
    pub status: String,
}

/// Résumé d'un plugin pour le gestionnaire Settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub source: String,
    pub enabled: bool,
    pub commands: usize,
    pub agents: usize,
    pub skills: usize,
    pub hooks: usize,
    pub mcp_pending: usize,
}

// ────────────────────────────────────────────────────────────────────────
// Découverte
// ────────────────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Manifeste : `plugin.json` à la racine ou `.claude-plugin/plugin.json`.
/// Absent/invalide ⇒ champs par défaut (name = nom du dossier).
fn read_manifest(
    root: &Path,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    for candidate in [
        root.join("plugin.json"),
        root.join(".claude-plugin").join("plugin.json"),
    ] {
        let Ok(raw) = std::fs::read_to_string(&candidate) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let get = |k: &str| {
            v[k].as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        return (
            get("name"),
            get("version"),
            get("description"),
            get("author"),
        );
    }
    (None, None, None, None)
}

fn plugin_at(root: PathBuf, source: PluginSource) -> Plugin {
    let (name, version, description, author) = read_manifest(&root);
    let dir_name = root
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "plugin".to_string());
    Plugin {
        name: name.unwrap_or(dir_name),
        version,
        description,
        author,
        source,
        root,
    }
}

/// Découverte d'un dossier de plugins (`<root>/<name>/`), chaque sous-dossier
/// = un plugin (avec ou sans manifeste).
fn discover_in(root: &Path, source: PluginSource, out: &mut Vec<Plugin>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return; // racine absente = cas nominal
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            out.push(plugin_at(path, source));
        }
    }
}

/// Compare deux noms de version de façon naïve-semver (numérique par segment,
/// lexical en repli) pour choisir la DERNIÈRE version d'un plugin du cache.
fn version_key(v: &str) -> Vec<u64> {
    v.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<u64>().ok())
        .collect()
}

/// Le dossier `~/.claude/plugins/installed_plugins.json` existe-t-il et liste-t-il
/// ce plugin ? Claude Code utilise aujourd'hui un objet indexé par
/// `"name@marketplace"` ; les anciens tableaux d'objets/strings restent tolérés.
/// Fichier absent/illisible ⇒ pas de filtre.
fn claude_installed(claude_plugins_root: &Path, marketplace: &str, plugin: &str) -> bool {
    let path = claude_plugins_root.join("installed_plugins.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return true; // pas de fichier → pas de filtre
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    let wanted_qualified = format!("{plugin}@{marketplace}");
    if let Some(entries) = v["plugins"].as_object() {
        return entries.contains_key(&wanted_qualified) || entries.contains_key(plugin);
    }
    let entries: Option<Vec<&serde_json::Value>> = v["plugins"]
        .as_array()
        .or_else(|| v.as_array())
        .map(|a| a.iter().collect());
    let Some(entries) = entries else {
        return true;
    };
    entries.iter().any(|e| {
        if let Some(s) = e.as_str() {
            s == plugin || s == wanted_qualified
        } else {
            let name = e["name"]
                .as_str()
                .or_else(|| e["plugin"].as_str())
                .or_else(|| e["id"].as_str());
            name == Some(plugin) || name == Some(wanted_qualified.as_str())
        }
    })
}

/// `~/.claude/settings.json` `enabledPlugins` : objet
/// `{ "name@marketplace": true|false }` dans les versions actuelles, ou ancien
/// tableau de strings. Absent/invalide ⇒ tout est activé.
fn claude_enabled(home: &Path, marketplace: &str, plugin: &str) -> bool {
    let path = home.join(".claude").join("settings.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return true;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return true;
    };
    let wanted_qualified = format!("{plugin}@{marketplace}");
    if let Some(entries) = v["enabledPlugins"].as_object() {
        return entries
            .get(&wanted_qualified)
            .or_else(|| entries.get(plugin))
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
    }
    if let Some(list) = v["enabledPlugins"].as_array() {
        return list
            .iter()
            .filter_map(|e| e.as_str())
            .any(|s| s == plugin || s == wanted_qualified);
    }
    true
}

/// Cache Claude Code : `<cache>/<marketplace>/<plugin>/<version>/` — dernière
/// version par plugin, installés + activés seulement quand les fichiers de
/// gating existent. LECTURE SEULE.
/// Variante à racine explicite (testable sans toucher les variables d'env).
fn discover_claude_cache_in(home: &Path, out: &mut Vec<Plugin>) {
    let cache = home.join(".claude").join("plugins").join("cache");
    let Ok(marketplaces) = std::fs::read_dir(&cache) else {
        return;
    };
    for mp in marketplaces.flatten() {
        let mp_path = mp.path();
        if !mp_path.is_dir() {
            continue;
        }
        let marketplace = mp.file_name().to_string_lossy().to_string();
        let Ok(plugins) = std::fs::read_dir(&mp_path) else {
            continue;
        };
        for pl in plugins.flatten() {
            let pl_path = pl.path();
            if !pl_path.is_dir() {
                continue;
            }
            let plugin_name = pl.file_name().to_string_lossy().to_string();
            if !claude_installed(
                &home.join(".claude").join("plugins"),
                &marketplace,
                &plugin_name,
            ) {
                continue;
            }
            if !claude_enabled(home, &marketplace, &plugin_name) {
                continue;
            }
            // Dernière version (naïve-semver décroissant, lexical en repli).
            let Ok(versions) = std::fs::read_dir(&pl_path) else {
                continue;
            };
            let mut version_dirs: Vec<PathBuf> = versions
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            let dir_name = |p: &PathBuf| {
                p.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default()
            };
            version_dirs.sort_by(|a, b| {
                let (na, nb) = (dir_name(a), dir_name(b));
                version_key(&nb)
                    .cmp(&version_key(&na))
                    .then_with(|| nb.cmp(&na))
            });
            if let Some(latest) = version_dirs.into_iter().next() {
                out.push(plugin_at(latest, PluginSource::ClaudeCache));
            }
        }
    }
}

/// Tous les plugins découverts (y compris désactivés — le Settings a besoin
/// de la liste complète annotée).
pub(crate) fn discover_plugins(workspace: Option<&Path>) -> Vec<Plugin> {
    discover_plugins_in(home_dir().as_deref(), workspace)
}

/// Variante à racine home explicite (testable sans toucher le vrai home).
pub(crate) fn discover_plugins_in(home: Option<&Path>, workspace: Option<&Path>) -> Vec<Plugin> {
    let mut out = Vec::new();
    if let Some(home) = home {
        discover_in(
            &home.join(".shugu").join("plugins"),
            PluginSource::User,
            &mut out,
        );
    }
    if let Some(ws) = workspace {
        discover_in(
            &ws.join(".shugu").join("plugins"),
            PluginSource::Project,
            &mut out,
        );
    }
    if let Some(home) = home {
        discover_claude_cache_in(home, &mut out);
    }
    out
}

/// Ids des plugins désactivés (`settings.plugins_disabled` = JSON array).
pub(crate) fn disabled_plugin_ids(app: &AppHandle) -> Vec<String> {
    crate::commands::mcp::read_setting(app, "plugins.disabled")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

/// Filtre pur : retire les plugins désactivés (testable sans AppHandle).
pub(crate) fn filter_disabled(plugins: Vec<Plugin>, disabled: &[String]) -> Vec<Plugin> {
    plugins
        .into_iter()
        .filter(|p| !disabled.contains(&p.id()))
        .collect()
}

/// Plugins ACTIFS (pour les contributions en boucle).
pub(crate) fn enabled_plugins(app: &AppHandle, workspace: Option<&Path>) -> Vec<Plugin> {
    filter_disabled(discover_plugins(workspace), &disabled_plugin_ids(app))
}

// ────────────────────────────────────────────────────────────────────────
// Contributions : commands / agents / skills / hooks / mcp
// ────────────────────────────────────────────────────────────────────────

fn md_files(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
                .collect()
        })
        .unwrap_or_default()
}

/// Frontmatter minimal d'une commande (`description`, `allowed-tools`).
/// Parseur lenient ligne à ligne (même philosophie que `parse_md_lenient`
/// d'agent_defs — tolère le YAML non quoté de Claude Code).
fn parse_command_md(content: &str, fallback_name: &str) -> (String, String, Vec<String>, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (
            fallback_name.to_string(),
            String::new(),
            Vec::new(),
            trimmed.to_string(),
        );
    }
    let after = &trimmed[3..];
    let after = after.trim_start_matches('\n');
    let Some(end) = after.find("\n---") else {
        return (
            fallback_name.to_string(),
            String::new(),
            Vec::new(),
            trimmed.to_string(),
        );
    };
    let yaml = &after[..end];
    let body = after[end + 4..].trim_start().to_string();
    let mut description = String::new();
    let mut allowed: Vec<String> = Vec::new();
    for line in yaml.lines() {
        let line = line.trim_end();
        let Some(idx) = line.find(':') else { continue };
        let key = line[..idx].trim();
        let mut value = line[idx + 1..].trim().to_string();
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_string();
        }
        match key {
            "description" => description = value,
            "allowed-tools" | "allowed_tools" => {
                allowed = value
                    .split(',')
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .collect();
            }
            _ => {}
        }
    }
    (fallback_name.to_string(), description, allowed, body)
}

/// Slash commands d'un plugin (`commands/*.md`).
pub(crate) fn plugin_commands(plugin: &Plugin) -> Vec<PluginCommand> {
    md_files(&plugin.root.join("commands"))
        .into_iter()
        .filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().to_string();
            let content = std::fs::read_to_string(&path).ok()?;
            let (name, description, allowed_tools, body) = parse_command_md(&content, &name);
            Some(PluginCommand {
                plugin: plugin.name.clone(),
                namespaced_name: format!("{}:{name}", plugin.name),
                name,
                description,
                allowed_tools,
                body,
            })
        })
        .collect()
}

/// Agent defs d'un plugin (`agents/*.md`) — MÊME parseur que le pipeline
/// `agent_defs` (scope "plugin:<name>").
pub(crate) fn plugin_agents(plugin: &Plugin) -> Vec<AgentDef> {
    md_files(&plugin.root.join("agents"))
        .into_iter()
        .filter_map(|path| {
            let content = std::fs::read_to_string(&path).ok()?;
            let scope = format!("plugin:{}", plugin.name);
            match parse_agent_md(&content, &path, &scope) {
                Ok(def) => Some(def),
                Err(e) => {
                    eprintln!("[plugins] skip agent {} ({e})", path.display());
                    None
                }
            }
        })
        .collect()
}

/// Dossiers `skills/<name>/SKILL.md` d'un plugin (chemins seulement —
/// le parsing vit dans `file_skills.rs`, P6.8).
pub(crate) fn plugin_skill_files(plugin: &Plugin) -> Vec<PathBuf> {
    let skills_dir = plugin.root.join("skills");
    std::fs::read_dir(&skills_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .map(|d| d.join("SKILL.md"))
                .filter(|f| f.exists())
                .collect()
        })
        .unwrap_or_default()
}

/// Hooks d'un plugin (`hooks/hooks.json`) — mergés dans le moteur P6.4 avec
/// source "plugin:<name>".
pub(crate) fn plugin_hooks(plugin: &Plugin) -> Vec<HookDef> {
    hooks::parse_hooks_file_scoped(
        &plugin.root.join("hooks").join("hooks.json"),
        HookSource::Plugin(plugin.name.clone()),
    )
}

/// Hooks de TOUS les plugins actifs (pour le merge dans `load_all_hooks`).
pub(crate) fn enabled_plugins_hooks(app: &AppHandle, workspace: Option<&Path>) -> Vec<HookDef> {
    enabled_plugins(app, workspace)
        .iter()
        .flat_map(plugin_hooks)
        .collect()
}

/// Empreinte de la configuration MCP complète : commande, frontières des
/// arguments, environnement et URL. Toute modification invalide l'approbation.
pub(crate) fn mcp_command_hash(cfg: &McpServerConfig) -> String {
    fn field(h: &mut sha2::Sha256, value: &str) {
        h.update((value.len() as u64).to_le_bytes());
        h.update(value.as_bytes());
    }

    let mut h = sha2::Sha256::new();
    field(&mut h, cfg.command.as_deref().unwrap_or(""));
    h.update((cfg.args.len() as u64).to_le_bytes());
    for arg in &cfg.args {
        field(&mut h, arg);
    }
    // McpServerConfig utilise un BTreeMap : ordre stable entre les exécutions.
    h.update((cfg.env.len() as u64).to_le_bytes());
    for (key, value) in &cfg.env {
        field(&mut h, key);
        field(&mut h, value);
    }
    field(&mut h, cfg.url.as_deref().unwrap_or(""));
    let digest = h.finalize();
    digest[..16].iter().map(|b| format!("{b:02x}")).collect()
}

fn mcp_command_preview(cfg: &McpServerConfig) -> String {
    let preview = if let Some(command) = cfg.command.as_deref() {
        std::iter::once(command)
            .chain(cfg.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        cfg.url
            .clone()
            .unwrap_or_else(|| "(config invalide)".to_string())
    };
    if preview.chars().count() > 120 {
        format!("{}…", preview.chars().take(120).collect::<String>())
    } else {
        preview
    }
}

/// Serveurs `.mcp.json` de TOUS les plugins actifs : (plugin, server, config).
pub(crate) fn enabled_plugins_mcp_servers(
    app: &AppHandle,
    workspace: Option<&Path>,
) -> Vec<(String, String, McpServerConfig)> {
    let mut out = Vec::new();
    for plugin in enabled_plugins(app, workspace) {
        let path = plugin.root.join(".mcp.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(cfg) = parse_mcp_config(&raw) else {
            eprintln!("[plugins] .mcp.json invalide dans {}", plugin.name);
            continue;
        };
        for (server, server_cfg) in cfg.mcp_servers {
            out.push((plugin.name.clone(), server, server_cfg));
        }
    }
    out
}

fn approved_mcp_keys(app: &AppHandle) -> Vec<String> {
    crate::commands::mcp::read_setting(app, "plugins.mcp.approved")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn rejected_mcp_keys(app: &AppHandle) -> Vec<String> {
    crate::commands::mcp::read_setting(app, "plugins.mcp.rejected")
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn mcp_key(plugin: &str, server: &str, hash: &str) -> String {
    format!("{}:{plugin}|{}:{server}|{hash}", plugin.len(), server.len())
}

fn mcp_key_prefix(plugin: &str, server: &str) -> String {
    format!("{}:{plugin}|{}:{server}|", plugin.len(), server.len())
}

/// Sélection pure des serveurs approuvés (clé structurée plugin+serveur+hash) parmi
/// les serveurs découverts — le hash est REVÉRIFIÉ à chaque appel : une
/// commande modifiée rend l'approbation caduque. Testable sans AppHandle.
pub(crate) fn select_approved(
    servers: Vec<(String, String, McpServerConfig)>,
    approved: &[String],
) -> Vec<(String, McpServerConfig)> {
    servers
        .into_iter()
        .filter(|(plugin, server, cfg)| {
            approved.contains(&mcp_key(plugin, server, &mcp_command_hash(cfg)))
        })
        .map(|(plugin, server, cfg)| (format!("{plugin}-{server}"), cfg))
        .collect()
}

/// Serveurs MCP de plugins APPROUVÉS (et dont la commande n'a pas changé),
/// prêts à être fusionnés dans la config MCP effective sous le nom
/// `<plugin>-<server>`. Appelé par `mcp::load_merged_config` — jamais avant
/// l'approbation explicite.
pub(crate) fn approved_plugin_mcp_servers(
    app: &AppHandle,
    workspace: Option<&Path>,
) -> Vec<(String, McpServerConfig)> {
    select_approved(
        enabled_plugins_mcp_servers(app, workspace),
        &approved_mcp_keys(app),
    )
}

fn write_setting_json_on_conn(
    conn: &Connection,
    key: &str,
    value: &serde_json::Value,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![key, value.to_string(), now],
    )
    .map_err(|e| format!("write setting {key}: {e}"))?;
    Ok(())
}

fn write_setting_json(app: &AppHandle, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let conn_mutex = super::get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    write_setting_json_on_conn(&conn, key, value, super::now_ms())
}

// ────────────────────────────────────────────────────────────────────────
// Commandes Tauri
// ────────────────────────────────────────────────────────────────────────

/// Liste tous les plugins (y compris désactivés) avec leurs compteurs de
/// contributions — pour le gestionnaire Settings.
#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> Result<Vec<PluginSummary>, String> {
    let ws = super::runner::get_workspace_root(&app);
    let disabled = disabled_plugin_ids(&app);
    let plugins = discover_plugins(ws.as_deref());
    let approved = approved_mcp_keys(&app);
    Ok(plugins
        .into_iter()
        .map(|p| {
            let enabled = !disabled.contains(&p.id());
            let (commands, agents, skills, hooks_n, mcp_pending) = if enabled {
                let cmds = plugin_commands(&p).len();
                let agts = plugin_agents(&p).len();
                let sks = plugin_skill_files(&p).len();
                let hks = plugin_hooks(&p).len();
                let pending = {
                    let path = p.root.join(".mcp.json");
                    std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|raw| parse_mcp_config(&raw).ok())
                        .map(|cfg| {
                            cfg.mcp_servers
                                .iter()
                                .filter(|(server, server_cfg)| {
                                    !approved.contains(&mcp_key(
                                        &p.name,
                                        server,
                                        &mcp_command_hash(server_cfg),
                                    ))
                                })
                                .count()
                        })
                        .unwrap_or(0)
                };
                (cmds, agts, sks, hks, pending)
            } else {
                (0, 0, 0, 0, 0)
            };
            PluginSummary {
                id: p.id(),
                name: p.name,
                version: p.version,
                description: p.description,
                author: p.author,
                source: p.source.as_str().to_string(),
                enabled,
                commands,
                agents,
                skills,
                hooks: hooks_n,
                mcp_pending,
            }
        })
        .collect())
}

/// Active/désactive un plugin (persisté en settings — jamais dans les
/// fichiers de l'utilisateur). Un plugin désactivé = zéro contribution.
#[tauri::command]
pub async fn plugins_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<Vec<String>, String> {
    let mut ids = disabled_plugin_ids(&app);
    if enabled {
        ids.retain(|x| x != &id);
    } else if !ids.contains(&id) {
        ids.push(id.clone());
    }
    write_setting_json(&app, "plugins.disabled", &serde_json::json!(ids))?;
    Ok(ids)
}

/// Slash commands de tous les plugins actifs (pour l'autocomplete du composer).
#[tauri::command]
pub async fn plugins_commands(app: AppHandle) -> Result<Vec<PluginCommand>, String> {
    let ws = super::runner::get_workspace_root(&app);
    Ok(enabled_plugins(&app, ws.as_deref())
        .iter()
        .flat_map(plugin_commands)
        .collect())
}

/// Serveurs MCP des plugins actifs avec leur statut d'approbation — pour la
/// section MCP (approve/reject). Jamais démarrés ici.
#[tauri::command]
pub async fn plugins_mcp_list(app: AppHandle) -> Result<Vec<PluginMcpServerInfo>, String> {
    let ws = super::runner::get_workspace_root(&app);
    let approved = approved_mcp_keys(&app);
    let rejected = rejected_mcp_keys(&app);
    Ok(enabled_plugins_mcp_servers(&app, ws.as_deref())
        .into_iter()
        .map(|(plugin, server, cfg)| {
            let hash = mcp_command_hash(&cfg);
            let key = mcp_key(&plugin, &server, &hash);
            let status = if approved.contains(&key) {
                "approved"
            } else if rejected.contains(&key) {
                "rejected"
            } else {
                "pending"
            };
            PluginMcpServerInfo {
                plugin,
                server,
                transport: cfg.transport().to_string(),
                command_preview: mcp_command_preview(&cfg),
                command_hash: hash,
                status: status.to_string(),
            }
        })
        .collect())
}

/// Approuve un serveur MCP de plugin : persiste l'approbation (clée sur le
/// hash de la configuration ACTUELLE) et active le nom fusionné `<plugin>-<server>`
/// — il sera alors démarré par le pipeline MCP normal au prochain run.
#[tauri::command]
pub async fn plugins_mcp_approve(
    app: AppHandle,
    plugin: String,
    server: String,
) -> Result<(), String> {
    let ws = super::runner::get_workspace_root(&app);
    let (_, _, cfg) = enabled_plugins_mcp_servers(&app, ws.as_deref())
        .into_iter()
        .find(|(p, s, _)| p == &plugin && s == &server)
        .ok_or_else(|| format!("serveur MCP de plugin introuvable : {plugin}/{server}"))?;
    let hash = mcp_command_hash(&cfg);
    let key = mcp_key(&plugin, &server, &hash);
    let mut approved = approved_mcp_keys(&app);
    // Une approbation antérieure du même couple (hash différent) est remplacée.
    let prefix = mcp_key_prefix(&plugin, &server);
    approved.retain(|k| !k.starts_with(&prefix));
    approved.push(key.clone());
    write_setting_json(&app, "plugins.mcp.approved", &serde_json::json!(approved))?;
    let mut rejected = rejected_mcp_keys(&app);
    rejected.retain(|k| !k.starts_with(&prefix));
    write_setting_json(&app, "plugins.mcp.rejected", &serde_json::json!(rejected))?;
    // Active le nom fusionné dans le pipeline MCP existant (démarrage réel au
    // prochain run, via enabled_tools_json — pas de démarrage ICI).
    crate::commands::mcp::set_enabled_setting(&app, &format!("{plugin}-{server}"), true)?;
    Ok(())
}

/// Rejette un serveur MCP de plugin : persiste le rejet (clée sur le hash
/// courant — si la commande change, il redevient « pending ») et désactive le
/// nom fusionné s'il était actif.
#[tauri::command]
pub async fn plugins_mcp_reject(
    app: AppHandle,
    plugin: String,
    server: String,
) -> Result<(), String> {
    let ws = super::runner::get_workspace_root(&app);
    let (_, _, cfg) = enabled_plugins_mcp_servers(&app, ws.as_deref())
        .into_iter()
        .find(|(p, s, _)| p == &plugin && s == &server)
        .ok_or_else(|| format!("serveur MCP de plugin introuvable : {plugin}/{server}"))?;
    let hash = mcp_command_hash(&cfg);
    let mut rejected = rejected_mcp_keys(&app);
    let prefix = mcp_key_prefix(&plugin, &server);
    rejected.retain(|k| !k.starts_with(&prefix));
    rejected.push(mcp_key(&plugin, &server, &hash));
    write_setting_json(&app, "plugins.mcp.rejected", &serde_json::json!(rejected))?;
    let mut approved = approved_mcp_keys(&app);
    approved.retain(|k| !k.starts_with(&prefix));
    write_setting_json(&app, "plugins.mcp.approved", &serde_json::json!(approved))?;
    crate::commands::mcp::set_enabled_setting(&app, &format!("{plugin}-{server}"), false)?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Tests — fixture plugin avec les 5 contributions + gates pures.
// ────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_root(tag: &str) -> PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "shugu-plugins-test-{tag}-{}-{seq}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    /// Plugin complet : manifeste + commande + agent + skill + hooks + mcp.
    /// Créé sous `<root>/.shugu/plugins/<name>` (convention de découverte).
    fn seed_full_plugin(root: &Path, name: &str) -> PathBuf {
        let p = root.join(".shugu").join("plugins").join(name);
        std::fs::create_dir_all(p.join("commands")).unwrap();
        std::fs::create_dir_all(p.join("agents")).unwrap();
        std::fs::create_dir_all(p.join("hooks")).unwrap();
        std::fs::create_dir_all(p.join("skills").join("pdf")).unwrap();
        std::fs::write(
            p.join("plugin.json"),
            r#"{"name":"super-plugin","version":"1.2.0","description":"Plugin de test","author":"t@t.t"}"#,
        )
        .unwrap();
        std::fs::write(
            p.join("commands").join("deploy.md"),
            "---\ndescription: Déploie l'app\nallowed-tools: run_command, fs_read_file\n---\n\nDéploie avec soin : $ARGUMENTS\n",
        )
        .unwrap();
        std::fs::write(
            p.join("agents").join("reviewer.md"),
            "---\nname: plugin-reviewer\ndescription: Revue de code du plugin\n---\n\nTu relis le code.\n",
        )
        .unwrap();
        std::fs::write(
            p.join("hooks").join("hooks.json"),
            r#"{"hooks":[{"event":"PostToolUse","command":"echo hook-plugin"}]}"#,
        )
        .unwrap();
        std::fs::write(
            p.join(".mcp.json"),
            r#"{"mcpServers":{"filesystem":{"command":"npx","args":["-y","@mcp/fs","."]}}}"#,
        )
        .unwrap();
        std::fs::write(
            p.join("skills").join("pdf").join("SKILL.md"),
            "---\nname: pdf\ndescription: Traiter les PDF\n---\n\nCorps de la skill pdf.\n",
        )
        .unwrap();
        p
    }

    #[test]
    fn full_plugin_all_contributions_discovered_and_parsed() {
        let root = temp_root("full");
        let plugin_root = seed_full_plugin(&root, "super-plugin");
        let plugins = discover_plugins_in(None, Some(&root));
        assert_eq!(plugins.len(), 1);
        let p = &plugins[0];
        assert_eq!(p.root, plugin_root);
        assert_eq!(p.name, "super-plugin");
        assert_eq!(p.version.as_deref(), Some("1.2.0"));
        assert_eq!(p.description.as_deref(), Some("Plugin de test"));
        assert_eq!(p.author.as_deref(), Some("t@t.t"));
        assert_eq!(p.source, PluginSource::Project);
        assert_eq!(p.id(), "project:super-plugin");

        // commands/*.md — frontmatter + namespacing.
        let cmds = plugin_commands(p);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].name, "deploy");
        assert_eq!(cmds[0].namespaced_name, "super-plugin:deploy");
        assert_eq!(cmds[0].description, "Déploie l'app");
        assert_eq!(cmds[0].allowed_tools, vec!["run_command", "fs_read_file"]);
        assert!(cmds[0].body.contains("$ARGUMENTS"));

        // agents/*.md — même pipeline agent_defs, scope plugin.
        let agents = plugin_agents(p);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].name, "plugin-reviewer");
        assert_eq!(agents[0].scope, "plugin:super-plugin");

        // skills/*/SKILL.md — chemins découverts.
        assert_eq!(plugin_skill_files(p).len(), 1);

        // hooks/hooks.json — source plugin:<name>.
        let hooks = plugin_hooks(p);
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].source.as_str(), "plugin:super-plugin");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_optional_dirname_fallback() {
        let root = temp_root("nomanifest");
        let p = root.join(".shugu").join("plugins").join("bare-plugin");
        std::fs::create_dir_all(p.join("commands")).unwrap();
        std::fs::write(p.join("commands").join("hello.md"), "Fais bonjour.\n").unwrap();
        let plugins = discover_plugins_in(None, Some(&root));
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].name, "bare-plugin", "name = nom du dossier");
        assert_eq!(plugins[0].version, None);
        let cmds = plugin_commands(&plugins[0]);
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].description.is_empty(), "sans frontmatter = toléré");
        assert_eq!(cmds[0].body.trim(), "Fais bonjour.");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn disabled_plugin_contributes_nothing() {
        let root = temp_root("disabled");
        seed_full_plugin(&root, "super-plugin");
        let all = discover_plugins_in(None, Some(&root));
        assert_eq!(all.len(), 1);
        let active = filter_disabled(all, &["project:super-plugin".to_string()]);
        assert!(active.is_empty(), "plugin désactivé = zéro contribution");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_pending_not_started_until_approved_and_approval_voided_on_change() {
        let cfg = McpServerConfig {
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "@mcp/fs".to_string()],
            env: Default::default(),
            url: None,
        };
        let servers = vec![(
            "super-plugin".to_string(),
            "filesystem".to_string(),
            cfg.clone(),
        )];

        // Aucune approbation → rien n'est fusionné (jamais démarré).
        assert!(select_approved(servers.clone(), &[]).is_empty());

        // Approbation clé plugin/serveur/hash → fusionné sous <plugin>-<server>.
        let key = mcp_key("super-plugin", "filesystem", &mcp_command_hash(&cfg));
        let approved = select_approved(servers.clone(), std::slice::from_ref(&key));
        assert_eq!(approved.len(), 1);
        assert_eq!(approved[0].0, "super-plugin-filesystem");

        // La commande CHANGE → hash différent → approbation caduque.
        let changed = McpServerConfig {
            command: Some("npx".to_string()),
            args: vec![
                "-y".to_string(),
                "@mcp/fs".to_string(),
                "--evil".to_string(),
            ],
            env: Default::default(),
            url: None,
        };
        let servers_changed = vec![(
            "super-plugin".to_string(),
            "filesystem".to_string(),
            changed,
        )];
        assert!(select_approved(servers_changed, &[key]).is_empty());

        // L'environnement fait partie du comportement du process : sa
        // modification invalide aussi l'approbation.
        let mut env_changed = cfg.clone();
        env_changed
            .env
            .insert("MCP_MODE".to_string(), "unsafe".to_string());
        assert_ne!(mcp_command_hash(&cfg), mcp_command_hash(&env_changed));

        // Les frontières d'arguments sont conservées dans l'empreinte.
        let mut joined_arg = cfg.clone();
        joined_arg.args = vec!["-y @mcp/fs".to_string()];
        assert_ne!(mcp_command_hash(&cfg), mcp_command_hash(&joined_arg));
        assert_eq!(mcp_command_preview(&cfg), "npx -y @mcp/fs");
    }

    #[test]
    fn claude_cache_latest_version_per_plugin() {
        let home = temp_root("claudehome");
        let cache = home.join(".claude").join("plugins").join("cache");
        for v in ["0.9.0", "1.10.0", "1.2.0"] {
            let dir = cache.join("mp").join("cool").join(v);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("plugin.json"), r#"{"name":"cool"}"#).unwrap();
        }
        // Sans installed_plugins.json ni settings.json → pas de filtre.
        let mut out = Vec::new();
        discover_claude_cache_in(&home, &mut out);
        assert_eq!(out.len(), 1);
        assert!(
            out[0].root.ends_with("1.10.0"),
            "dernière version semver (1.10.0 > 1.2.0 > 0.9.0), pas lexicale : {}",
            out[0].root.display()
        );
        assert_eq!(out[0].source, PluginSource::ClaudeCache);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn claude_cache_supports_current_object_gating_format() {
        let home = temp_root("claude-object-gating");
        let plugin_root = home
            .join(".claude")
            .join("plugins")
            .join("cache")
            .join("official")
            .join("reviewer")
            .join("2.0.0");
        std::fs::create_dir_all(&plugin_root).unwrap();
        std::fs::write(plugin_root.join("plugin.json"), r#"{"name":"reviewer"}"#).unwrap();
        std::fs::write(
            home.join(".claude")
                .join("plugins")
                .join("installed_plugins.json"),
            r#"{"plugins":{"reviewer@official":[{"version":"2.0.0"}]}}"#,
        )
        .unwrap();
        std::fs::write(
            home.join(".claude").join("settings.json"),
            r#"{"enabledPlugins":{"reviewer@official":true}}"#,
        )
        .unwrap();

        let mut enabled = Vec::new();
        discover_claude_cache_in(&home, &mut enabled);
        assert_eq!(enabled.len(), 1);

        std::fs::write(
            home.join(".claude").join("settings.json"),
            r#"{"enabledPlugins":{"reviewer@official":false}}"#,
        )
        .unwrap();
        let mut disabled = Vec::new();
        discover_claude_cache_in(&home, &mut disabled);
        assert!(disabled.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn setting_json_binds_key_value_and_timestamp() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        write_setting_json_on_conn(
            &conn,
            "plugins.disabled",
            &serde_json::json!(["project:reviewer"]),
            42,
        )
        .unwrap();

        let row: (String, String, i64) = conn
            .query_row("SELECT key, value, updated_at FROM settings", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(row.0, "plugins.disabled");
        assert_eq!(row.1, r#"["project:reviewer"]"#);
        assert_eq!(row.2, 42);
    }
}
