//! Définitions d'agents portables (compatibilité Claude Code / Codex / Pi).
//!
//! Source de vérité = fichiers `.md` avec frontmatter YAML, stockés aux
//! emplacements standards Claude Code :
//!
//!   - Projet  : `<workspace>/.claude/agents/*.md`
//!   - Global  : `~/.claude/agents/*.md`
//!
//! Shugu ne possède PAS son propre format : il lit et écrit le format Claude
//! Code, en ajoutant quelques champs de frontmatter optionnels (icon, color,
//! origin, enabled, base_role) que les autres outils ignorent silencieusement.
//! Un agent défini dans Shugu marche dans Claude Code, et inversement.
//!
//! Pour préserver l'identité Shugu sans dupliquer les fichiers, on crée un
//! lien (junction NTFS sur Windows, symlink ailleurs) :
//!
//!   - `<ws>/.shugu/agents`  →  `<ws>/.claude/agents`
//!   - `~/.shugu/agents`     →  `~/.claude/agents`
//!
//! Édition unique du fichier physique, deux portes d'accès.
//!
//! Au premier boot, on seed 5 `.md` builtin dans `~/.claude/agents/` (un par
//! rôle moteur : mascot / orchestrator / coder / researcher / tester), avec
//! `origin: builtin`. Le body est `seed_prompt(role)` — source unique, pas
//! de duplication entre Rust et fichiers.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use gray_matter::{engine::YAML, Matter};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands::agents::{runner::seed_prompt, ALLOWED_ROLES};

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/// Frontmatter tel que sérialisé dans l'en-tête YAML du `.md`. `tools` reste
/// en CSV brut (format Claude Code) ; la conversion vers `Vec<String>` se
/// fait dans [`AgentDef`] pour faciliter le rendu côté JS sans re-parsing.
#[derive(Debug, Clone, Deserialize, Serialize)]
struct Frontmatter {
    name: String,
    description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    /// Liste d'outils CSV (format Claude Code), p.ex. "read, grep, edit".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tools: Option<String>,
    // ── champs Shugu (ignorés par Claude Code / Pi) ───────────────────
    #[serde(default, skip_serializing_if = "Option::is_none")]
    icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(default = "default_origin")]
    origin: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default = "default_base_role")]
    base_role: String,
}

fn default_origin() -> String {
    "user".into()
}
fn default_enabled() -> bool {
    true
}
fn default_base_role() -> String {
    "coder".into()
}

/// Vue de l'agent exposée au frontend. `path` et `scope` sont calculés par
/// le backend (jamais présents dans le frontmatter écrit sur disque).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDef {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub origin: String,
    pub enabled: bool,
    pub base_role: String,
    /// Chemin absolu canonique du `.md` (toujours côté `.claude/agents/`).
    pub path: String,
    /// "workspace" | "global"
    pub scope: String,
    /// System prompt — corps du `.md` après le frontmatter.
    pub body: String,
}

// ─────────────────────────────────────────────────────────────────────────
// Parsing / sérialisation
// ─────────────────────────────────────────────────────────────────────────

fn tools_from_csv(csv: &Option<String>) -> Vec<String> {
    csv.as_deref()
        .map(|s| {
            s.split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn tools_to_csv(tools: &[String]) -> Option<String> {
    if tools.is_empty() {
        None
    } else {
        Some(tools.join(", "))
    }
}

fn parse_md(content: &str, path: &Path, scope: &str) -> Result<AgentDef, String> {
    // Essai 1 : gray_matter (YAML strict). Marche pour les `.md` écrits par
    // Shugu (frontmatter propre) ou par des éditeurs qui quotent les valeurs.
    let matter: Matter<YAML> = Matter::new();
    if let Some(parsed) = matter.parse_with_struct::<Frontmatter>(content) {
        let fm = parsed.data;
        let body = parsed.content.trim_start().to_string();
        return Ok(AgentDef {
            name: fm.name,
            description: fm.description,
            model: fm.model,
            tools: tools_from_csv(&fm.tools),
            icon: fm.icon,
            color: fm.color,
            origin: fm.origin,
            enabled: fm.enabled,
            base_role: fm.base_role,
            path: path.to_string_lossy().into_owned(),
            scope: scope.into(),
            body,
        });
    }
    // Essai 2 : parseur lenient. Les agents générés par Claude Code (CLI) ont
    // une `description:` non quotée pouvant contenir des `<example>…</example>`
    // avec des `:` internes et des guillemets — YAML strict refuse. On parse
    // ligne par ligne (split sur le PREMIER `:`), permissif, KISS. C'est
    // exactement ce que Claude Code fait lui-même côté CLI.
    parse_md_lenient(content, path, scope)
}

fn parse_md_lenient(content: &str, path: &Path, scope: &str) -> Result<AgentDef, String> {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return Err(format!("pas de frontmatter dans {}", path.display()));
    }
    let after_first = trimmed[3..].trim_start_matches('\n');
    let end = after_first
        .find("\n---")
        .ok_or_else(|| format!("frontmatter non fermé dans {}", path.display()))?;
    let yaml_block = &after_first[..end];
    let body = after_first[end + 4..].trim_start().to_string();

    let mut name: Option<String> = None;
    let mut description = String::new();
    let mut model: Option<String> = None;
    let mut tools_str: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut color: Option<String> = None;
    let mut origin = "user".to_string();
    let mut enabled = true;
    let mut base_role = "coder".to_string();

    for line in yaml_block.lines() {
        let line = line.trim_end();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(idx) = line.find(':') else { continue };
        let key = line[..idx].trim();
        let mut value = line[idx + 1..].trim().to_string();
        // Strip des guillemets YAML extérieurs si présents.
        if value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')))
        {
            value = value[1..value.len() - 1].to_string();
        }
        match key {
            "name" => name = Some(value),
            "description" => description = value,
            "model" => model = (!value.is_empty()).then_some(value),
            "tools" => tools_str = (!value.is_empty()).then_some(value),
            "icon" => icon = (!value.is_empty()).then_some(value),
            "color" => color = (!value.is_empty()).then_some(value),
            "origin" => origin = value,
            "enabled" => enabled = matches!(value.as_str(), "true" | "1" | "yes"),
            "base_role" => base_role = value,
            _ => {}
        }
    }

    let name = name.ok_or_else(|| {
        format!("champ `name` manquant dans frontmatter de {}", path.display())
    })?;

    Ok(AgentDef {
        name,
        description,
        model,
        tools: tools_from_csv(&tools_str),
        icon,
        color,
        origin,
        enabled,
        base_role,
        path: path.to_string_lossy().into_owned(),
        scope: scope.into(),
        body,
    })
}

fn serialize_md(def: &AgentDef) -> Result<String, String> {
    let fm = Frontmatter {
        name: def.name.clone(),
        description: def.description.clone(),
        model: def.model.clone(),
        tools: tools_to_csv(&def.tools),
        icon: def.icon.clone(),
        color: def.color.clone(),
        origin: def.origin.clone(),
        enabled: def.enabled,
        base_role: def.base_role.clone(),
    };
    let yaml = serde_yaml::to_string(&fm).map_err(|e| format!("serialize yaml: {e}"))?;
    Ok(format!("---\n{yaml}---\n\n{}\n", def.body.trim_end()))
}

// ─────────────────────────────────────────────────────────────────────────
// Résolution de chemins
// ─────────────────────────────────────────────────────────────────────────

fn workspace_root(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<Mutex<Option<PathBuf>>>();
    let guard = state.lock().ok()?;
    guard.clone()
}

fn claude_agents_dir(app: &AppHandle, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "global" => {
            let home = app
                .path()
                .home_dir()
                .map_err(|e| format!("home_dir: {e}"))?;
            Ok(home.join(".claude").join("agents"))
        }
        "workspace" => {
            let root =
                workspace_root(app).ok_or_else(|| "aucun workspace ouvert".to_string())?;
            Ok(root.join(".claude").join("agents"))
        }
        other => Err(format!("scope invalide: {other}")),
    }
}

fn shugu_agents_alias(app: &AppHandle, scope: &str) -> Result<PathBuf, String> {
    match scope {
        "global" => {
            let home = app
                .path()
                .home_dir()
                .map_err(|e| format!("home_dir: {e}"))?;
            Ok(home.join(".shugu").join("agents"))
        }
        "workspace" => {
            let root =
                workspace_root(app).ok_or_else(|| "aucun workspace ouvert".to_string())?;
            Ok(root.join(".shugu").join("agents"))
        }
        other => Err(format!("scope invalide: {other}")),
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Junction (Windows) / symlink (Unix)
// ─────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn make_dir_link(target: &Path, link: &Path) -> Result<(), String> {
    junction::create(target, link).map_err(|e| format!("junction: {e}"))
}

#[cfg(unix)]
fn make_dir_link(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|e| format!("symlink: {e}"))
}

#[cfg(not(any(windows, unix)))]
fn make_dir_link(_target: &Path, _link: &Path) -> Result<(), String> {
    Err("plateforme non supportée pour le lien de dossier".into())
}

// ─────────────────────────────────────────────────────────────────────────
// Setup : dossiers + lien Shugu + seed builtin (idempotent)
// ─────────────────────────────────────────────────────────────────────────

/// S'assure que `.claude/agents/` existe et que `.shugu/agents` est un lien
/// vers lui. Si `.shugu/agents` existe déjà (lien ou dossier indépendant) on
/// n'y touche pas — l'utilisateur tranchera en cas de conflit (vérifier
/// qu'un dossier "alias" est bien un lien vers le canonique ouvre une boîte
/// de Pandore multi-OS qu'on évite pour V1).
fn ensure_dirs_and_link(app: &AppHandle, scope: &str) -> Result<(), String> {
    let canonical = claude_agents_dir(app, scope)?;
    let alias = shugu_agents_alias(app, scope)?;

    if !canonical.exists() {
        std::fs::create_dir_all(&canonical)
            .map_err(|e| format!("create {}: {e}", canonical.display()))?;
    }

    if alias.exists() {
        return Ok(());
    }
    if let Some(parent) = alias.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
    }
    make_dir_link(&canonical, &alias)?;
    Ok(())
}

fn seed_builtin_if_missing(app: &AppHandle) -> Result<(), String> {
    let dir = claude_agents_dir(app, "global")?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    for role in ALLOWED_ROLES {
        let path = dir.join(format!("{role}.md"));
        if path.exists() {
            continue;
        }
        let def = builtin_def_for(role, &path);
        let content = serialize_md(&def)?;
        std::fs::write(&path, content)
            .map_err(|e| format!("write {}: {e}", path.display()))?;
    }
    Ok(())
}

fn builtin_def_for(role: &str, path: &Path) -> AgentDef {
    AgentDef {
        name: role.to_string(),
        description: builtin_description(role).into(),
        model: None,
        tools: vec![
            "read".into(),
            "write".into(),
            "edit".into(),
            "bash".into(),
        ],
        icon: None,
        color: None,
        origin: "builtin".into(),
        enabled: true,
        base_role: role.into(),
        path: path.to_string_lossy().into_owned(),
        scope: "global".into(),
        body: seed_prompt(role),
    }
}

fn builtin_description(role: &str) -> &'static str {
    match role {
        "orchestrator" => "Coordinateur : décide quoi faire et délègue aux autres agents",
        "coder" => "Spécialiste implémentation : écrit et modifie du code",
        "researcher" => "Explore et résume le code/projet pour récolter du contexte",
        "tester" => "Écrit, exécute et vérifie les tests",
        "mascot" => "Persona conversationnelle de Shugu (chibi)",
        _ => "Agent Shugu",
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Commandes Tauri
// ─────────────────────────────────────────────────────────────────────────

/// Liste les agents `.md` d'un scope, ou des deux si scope = "all".
/// Idempotent : s'assure que les dossiers/liens existent à chaque appel.
#[tauri::command]
pub async fn agent_def_list(app: AppHandle, scope: String) -> Result<Vec<AgentDef>, String> {
    let mut out = Vec::new();
    let scopes: Vec<&str> = match scope.as_str() {
        "all" => vec!["global", "workspace"],
        s @ ("global" | "workspace") => vec![s],
        other => return Err(format!("scope invalide: {other}")),
    };
    for s in scopes {
        // workspace peut ne pas exister (aucun workspace ouvert) : on saute.
        let dir = match claude_agents_dir(&app, s) {
            Ok(p) => p,
            Err(_) if s == "workspace" => continue,
            Err(e) => return Err(e),
        };
        let _ = ensure_dirs_and_link(&app, s); // best-effort
        if !dir.exists() {
            continue;
        }
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            match parse_md(&content, &path, s) {
                Ok(def) => out.push(def),
                Err(e) => eprintln!("[agent_defs] skip {} ({e})", path.display()),
            }
        }
    }
    Ok(out)
}

/// Lit un agent par chemin absolu. Le frontend conserve `path` tel que renvoyé
/// par `agent_def_list` — pas de re-résolution côté JS.
#[tauri::command]
pub async fn agent_def_read(path: String) -> Result<AgentDef, String> {
    let p = PathBuf::from(&path);
    let scope = if path_under_home(&p) {
        "global"
    } else {
        "workspace"
    };
    let content =
        std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    parse_md(&content, &p, scope)
}

fn path_under_home(p: &Path) -> bool {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    match home {
        Some(h) => p.starts_with(h),
        None => false,
    }
}

/// Écrit/met à jour un agent. Atomique (tmp + rename) pour éviter qu'un crash
/// laisse un fichier tronqué (Claude Code refuserait un frontmatter incomplet).
#[tauri::command]
pub async fn agent_def_write(app: AppHandle, def: AgentDef) -> Result<String, String> {
    ensure_dirs_and_link(&app, &def.scope)?;
    let dir = claude_agents_dir(&app, &def.scope)?;
    let safe_name: String = def
        .name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(*c, '-' | '_'))
        .collect();
    if safe_name.is_empty() {
        return Err(
            "nom d'agent invalide (caractères alphanumériques, '-' ou '_' uniquement)".into(),
        );
    }
    let final_path = if def.path.is_empty() {
        dir.join(format!("{safe_name}.md"))
    } else {
        PathBuf::from(&def.path)
    };
    let mut def_to_write = def.clone();
    def_to_write.path = final_path.to_string_lossy().into_owned();
    let content = serialize_md(&def_to_write)?;
    let tmp = final_path.with_extension("md.tmp");
    std::fs::write(&tmp, &content).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| format!("rename {}: {e}", final_path.display()))?;
    Ok(final_path.to_string_lossy().into_owned())
}

/// Supprime un agent. Garde-fou : refuse tout path qui n'est pas dans un
/// dossier `agents/` (anti-frontend-corrompu).
#[tauri::command]
pub async fn agent_def_delete(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let parent_name = p
        .parent()
        .and_then(|x| x.file_name())
        .and_then(|x| x.to_str())
        .unwrap_or_default();
    if parent_name != "agents" {
        return Err("refus : le path n'est pas dans un dossier `agents/`".into());
    }
    std::fs::remove_file(&p).map_err(|e| format!("remove {}: {e}", p.display()))
}

// ─────────────────────────────────────────────────────────────────────────
// Raw `.md` read / write — utilisés par l'onglet "Source `.md`" du drawer
// AgentDefsManager (pont IDE pour les devs : édition raw du frontmatter YAML
// + body markdown via CodeMirror, sans passer par le formulaire structuré).
// Même garde-chemin que delete (parent dir `agents/`) + check extension `.md`.
// ─────────────────────────────────────────────────────────────────────────

fn guard_md_in_agents_dir(p: &Path) -> Result<(), String> {
    let parent_name = p
        .parent()
        .and_then(|x| x.file_name())
        .and_then(|x| x.to_str())
        .unwrap_or_default();
    if parent_name != "agents" {
        return Err("refus : le path n'est pas dans un dossier `agents/`".into());
    }
    if p.extension().and_then(|x| x.to_str()) != Some("md") {
        return Err("refus : extension `.md` requise".into());
    }
    Ok(())
}

/// Lit le contenu BRUT d'un `.md` agent (frontmatter YAML + body markdown) —
/// pour l'onglet "Source `.md`" qui expose l'édition raw aux devs.
#[tauri::command]
pub async fn agent_def_read_raw(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    guard_md_in_agents_dir(&p)?;
    std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

/// Écrit le contenu BRUT d'un `.md` agent (édition raw). Atomique (tmp+rename)
/// pour qu'un crash ne laisse pas un fichier tronqué. Si le frontmatter YAML
/// devient invalide après l'édition, `agent_def_list` skippera ce fichier au
/// prochain refetch (best-effort) jusqu'à ce que le dev corrige.
#[tauri::command]
pub async fn agent_def_write_raw(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    guard_md_in_agents_dir(&p)?;
    let tmp = p.with_extension("md.tmp");
    std::fs::write(&tmp, &content).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("rename {}: {e}", p.display()))?;
    Ok(())
}

/// Charge une définition d'agent depuis un path absolu — helper sync utilisé
/// par `agent_spawn` quand `agent_def_path` est fourni. Pas `#[tauri::command]`
/// (pas exposé directement à JS — `agent_def_read` joue ce rôle côté UI).
pub(crate) fn load_def(path: &str) -> Result<AgentDef, String> {
    let p = PathBuf::from(path);
    let scope = if path_under_home(&p) {
        "global"
    } else {
        "workspace"
    };
    let content =
        std::fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))?;
    parse_md(&content, &p, scope)
}

/// Setup au boot : crée `~/.claude/agents/`, le lien `~/.shugu/agents`, et
/// seed les 5 `.md` builtin si absents. Best-effort : un échec ne bloque
/// pas le boot ; les commandes futures échoueront proprement.
pub fn setup_links_and_seed(app: &AppHandle) {
    if let Err(e) = ensure_dirs_and_link(app, "global") {
        eprintln!("[agent_defs] setup global link: {e}");
    }
    if let Err(e) = seed_builtin_if_missing(app) {
        eprintln!("[agent_defs] seed builtin: {e}");
    }
}
