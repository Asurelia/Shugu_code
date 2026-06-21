//! Lane 6 — inventaire + import MCP multi-source.
//!
//! Lit (EN LECTURE SEULE) les configurations MCP des outils déjà installés sur
//! la machine, les normalise dans une forme commune, les déduplique, classe leur
//! risque, repère les secrets en clair, et expose le tout à l'UI inventaire.
//!
//! Sources lues (aucune n'est modifiée par ce module) :
//!   - `ClaudeDesktopMcpSource` : `%APPDATA%\Claude\claude_desktop_config.json`
//!       (champ `mcpServers` — même schéma que `.mcp.json`, plus un `type`).
//!   - `CodexTomlMcpSource`     : `~/.codex/config.toml` (`CODEX_HOME` si défini),
//!       tables `[mcp_servers.<name>]` (`command`/`args`/`env`/`url`).
//!   - `OpenCodeMcpSource`      : `~/.config/opencode/opencode.json`
//!       (champ `mcp` — `type: "local"` avec `command` ARRAY + `environment`,
//!        ou `type: "remote"` avec `url` ; flag `enabled`).
//!   - `ShuguMcpSource`         : les `.mcp.json` projet+global de Shugu lui-même.
//!
//! Migration des secrets : à l'import (`mcp.rs::mcp_import_server`), toute valeur
//! d'`env` repérée comme secrète est déplacée dans le keychain OS sous un compte
//! `cred_*` et remplacée dans `.mcp.json` par le sentinel `${cred:<account>}` ;
//! `mcp.rs::connect` ré-hydrate ce sentinel au lancement du serveur.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::AppHandle;

use super::mcp::McpServerConfig;

// ---------------------------------------------------------------------------
// Forme normalisée d'une entrée d'inventaire
// ---------------------------------------------------------------------------

/// Provenance d'une entrée : d'où vient la déclaration MCP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpSourceKind {
    /// Déjà déclaré dans le `.mcp.json` de Shugu (projet ou global).
    Shugu,
    /// Importable depuis Claude Desktop.
    ClaudeDesktop,
    /// Importable depuis Codex (`~/.codex/config.toml`).
    Codex,
    /// Importable depuis OpenCode Desktop.
    OpenCode,
}

impl McpSourceKind {
    /// Étiquette lisible (affichée comme badge de provenance dans l'UI).
    pub fn label(self) -> &'static str {
        match self {
            McpSourceKind::Shugu => "Shugu",
            McpSourceKind::ClaudeDesktop => "Claude Desktop",
            McpSourceKind::Codex => "Codex",
            McpSourceKind::OpenCode => "OpenCode",
        }
    }
}

/// Niveau de risque déduit STATIQUEMENT de la déclaration (sans lancer le
/// serveur). Sert à attirer l'œil de l'utilisateur sur ce qu'il s'apprête à
/// activer — un transport distant ou une commande shell brute sont plus
/// sensibles qu'un binaire npx connu.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpRisk {
    /// Serveur local lancé via un runner de paquets connu (npx/uvx/bunx/pnpm…),
    /// sans secret en clair.
    Low,
    /// Local mais lance un binaire arbitraire, OU passe par un shell
    /// (`cmd /c`, `sh -c`…), OU embarque des secrets en clair.
    Medium,
    /// Transport distant (HTTP/SSE) : la confiance porte sur un tiers réseau,
    /// et la description d'outil distante est une entrée non fiable (injection
    /// indirecte). On le signale comme le risque le plus élevé de l'inventaire.
    High,
}

impl McpRisk {
    pub fn label(self) -> &'static str {
        match self {
            McpRisk::Low => "low",
            McpRisk::Medium => "medium",
            McpRisk::High => "high",
        }
    }
}

/// Une entrée d'inventaire normalisée, prête pour l'UI et pour l'import.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryEntry {
    /// Nom du serveur (clé dans la config d'origine).
    pub name: String,
    /// Provenance.
    pub source: McpSourceKind,
    /// Étiquette lisible de la source (`source.label()`), pré-calculée pour l'UI.
    pub source_label: String,
    /// "stdio" | "http" | "invalid".
    pub transport: String,
    /// Le serveur est-il déjà présent dans le `.mcp.json` de Shugu ? Pour une
    /// entrée `source == Shugu` c'est toujours vrai ; pour une source externe
    /// c'est vrai si un serveur de MÊME signature (dedup) existe déjà côté Shugu.
    pub already_imported: bool,
    /// Activé côté Shugu (`mcp.<name>.enabled`). Pertinent surtout pour Shugu ;
    /// pour une source externe non importée c'est `false`.
    pub enabled: bool,
    /// Flag `enabled` tel que déclaré DANS la source externe (OpenCode/Codex en
    /// exposent un). `None` si la source ne porte pas l'info.
    pub source_enabled: Option<bool>,
    /// Noms des variables d'environnement repérées comme secrètes (tokens, clés).
    /// Vide si aucun secret. L'UI affiche le compte + la liste au survol.
    pub secret_env_keys: Vec<String>,
    /// Risque statique.
    pub risk: String,
    /// La config normalisée, telle qu'elle sera écrite dans `.mcp.json` à
    /// l'import (les secrets y sont encore EN CLAIR ici ; la migration keychain
    /// se fait dans `mcp.rs::mcp_import_server`).
    pub config: McpServerConfig,
}

/// Une erreur de parsing d'une source — rendue VISIBLE dans l'UI (jamais
/// avalée silencieusement). `path` est `None` si la source n'a pas de fichier
/// localisable (home dir introuvable).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceError {
    pub source: McpSourceKind,
    pub source_label: String,
    pub path: Option<String>,
    pub message: String,
}

/// Résultat complet d'un scan d'inventaire : les entrées normalisées + les
/// erreurs de parsing rencontrées (les deux sont rendus côté UI).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventory {
    pub entries: Vec<InventoryEntry>,
    pub errors: Vec<SourceError>,
}

// ---------------------------------------------------------------------------
// Localisation des fichiers de config externes
// ---------------------------------------------------------------------------

/// Home dir de l'utilisateur (via l'API Tauri, cohérent avec `mcp.rs`).
fn home_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().home_dir().ok()
}

/// `%APPDATA%\Claude\claude_desktop_config.json` (Windows) /
/// `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) /
/// `~/.config/Claude/claude_desktop_config.json` (Linux).
pub fn claude_desktop_config_path(app: &AppHandle) -> Option<PathBuf> {
    let home = home_dir(app)?;
    let dir = if cfg!(target_os = "windows") {
        // APPDATA = %USERPROFILE%\AppData\Roaming
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("Claude")
    } else if cfg!(target_os = "macos") {
        home.join("Library")
            .join("Application Support")
            .join("Claude")
    } else {
        home.join(".config").join("Claude")
    };
    Some(dir.join("claude_desktop_config.json"))
}

/// `~/.codex/config.toml`, en respectant `CODEX_HOME` s'il est défini (même
/// règle que le binaire Codex et que `codex.rs`).
pub fn codex_config_path(app: &AppHandle) -> Option<PathBuf> {
    let codex_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir(app).map(|h| h.join(".codex")))?;
    Some(codex_home.join("config.toml"))
}

/// `~/.config/opencode/opencode.json`.
pub fn opencode_config_path(app: &AppHandle) -> Option<PathBuf> {
    Some(home_dir(app)?.join(".config").join("opencode").join("opencode.json"))
}

// ---------------------------------------------------------------------------
// Détection des secrets
// ---------------------------------------------------------------------------

/// Mots-clés « longs » (en MAJUSCULES), peu ambigus : un segment qui les
/// contient en préfixe OU suffixe est tenu pour secret. `APIKEY` couvre la forme
/// collée du couple API+KEY.
const SUBSTRING_NEEDLES: [&str; 8] = [
    "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "BEARER", "APIKEY", "PRIVATEKEY",
];

/// Mots-clés courts/ambigus admis UNIQUEMENT comme segment exact (un segment
/// entier qui leur est égal). Évite `MONKEY`→`KEY`, `NODE_PATH`→`PATH`(PAT),
/// `AUTHOR`→`AUTH`.
const EXACT_NEEDLES: [&str; 4] = ["KEY", "PAT", "AUTH", "APIKEY"];

/// Une variable d'env est-elle (probablement) secrète, d'après son NOM ? On ne
/// se base QUE sur la clé (pas la valeur) pour éviter les faux négatifs sur une
/// valeur vide à compléter. Heuristique : on découpe le nom en segments sur les
/// séparateurs (`_`, `-`, `.`, espace), puis pour chaque segment :
///   - segment EXACTEMENT égal à un mot court (`KEY`, `PAT`, `AUTH`) → secret ;
///   - segment qui COMMENCE ou TERMINE par un mot long (`*_TOKEN`, `SECRET_*`,
///     `OPENAI_APIKEY`) → secret.
///
/// Inclut : `API_KEY`, `APIKEY`, `NOTION_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`,
/// `PASSWORD`, `BEARER_AUTH`, `OPENAI_API_KEY`.
/// Exclut : `NODE_PATH`, `API_BASE`, `PORT`, `MONKEY`, `NODE_REPL_NODE_PATH`.
pub fn is_secret_env_key(key: &str) -> bool {
    key.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .any(|seg| segment_is_secret(&seg.to_ascii_uppercase()))
}

fn segment_is_secret(seg: &str) -> bool {
    if EXACT_NEEDLES.contains(&seg) {
        return true;
    }
    SUBSTRING_NEEDLES
        .iter()
        .any(|n| seg.starts_with(n) || seg.ends_with(n))
}

/// Liste triée des clés d'env secrètes d'une config (déjà valorisées en clair).
/// Un sentinel `${cred:…}` n'est PAS recompté comme secret (déjà migré).
fn secret_keys_of(cfg: &McpServerConfig) -> Vec<String> {
    let mut keys: Vec<String> = cfg
        .env
        .iter()
        .filter(|(k, v)| is_secret_env_key(k) && !is_cred_sentinel(v))
        .map(|(k, _)| k.clone())
        .collect();
    keys.sort();
    keys
}

/// Une valeur d'env est-elle déjà un sentinel keychain `${cred:<account>}` ?
pub fn is_cred_sentinel(value: &str) -> bool {
    extract_cred_account(value).is_some()
}

/// Extrait `<account>` d'un sentinel `${cred:<account>}`. `None` si la valeur
/// n'est pas un sentinel.
pub fn extract_cred_account(value: &str) -> Option<&str> {
    value
        .strip_prefix("${cred:")
        .and_then(|rest| rest.strip_suffix('}'))
}

/// Construit le compte keychain d'un secret d'env MCP : `mcp.<server>.env.<KEY>`.
/// Aligné sur la convention `provider.<id>.<field>` de `credentials.rs`.
pub fn cred_account_for(server: &str, env_key: &str) -> String {
    format!("mcp.{server}.env.{env_key}")
}

/// Sentinel à écrire dans `.mcp.json` pour un secret migré au keychain.
pub fn cred_sentinel_for(account: &str) -> String {
    format!("${{cred:{account}}}")
}

// ---------------------------------------------------------------------------
// Classification de risque
// ---------------------------------------------------------------------------

/// Runners de paquets connus → un serveur lancé via eux est considéré low-risk
/// (le binaire est résolu par le runner depuis un registre public, pas un exe
/// arbitraire sur disque).
const KNOWN_RUNNERS: [&str; 7] = ["npx", "npx.cmd", "uvx", "bunx", "pnpm", "pnpm.cmd", "uv"];

/// Shells bruts → un serveur lancé via eux exécute une ligne de commande
/// arbitraire (risque d'injection / d'effets de bord) → medium.
const SHELL_BINS: [&str; 6] = ["cmd", "cmd.exe", "sh", "bash", "powershell", "pwsh"];

/// Classe le risque statique d'une config + la présence de secrets en clair.
pub fn classify_risk(cfg: &McpServerConfig, has_plain_secret: bool) -> McpRisk {
    // Transport distant : toujours High (tiers réseau + description d'outil non
    // fiable). Prime sur tout le reste.
    if cfg.url.is_some() && cfg.command.is_none() {
        return McpRisk::High;
    }
    let Some(command) = cfg.command.as_deref() else {
        // Ni command ni url → config invalide ; on la signale en Medium pour
        // qu'elle ressorte (plutôt que Low qui la banaliserait).
        return McpRisk::Medium;
    };
    // Nom de binaire seul, sans chemin, en minuscules (pour comparer aux listes).
    let bin = std::path::Path::new(command)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase();

    let via_shell = SHELL_BINS.contains(&bin.as_str());
    let via_known_runner = KNOWN_RUNNERS.contains(&bin.as_str());

    if via_shell || has_plain_secret {
        return McpRisk::Medium;
    }
    if via_known_runner {
        return McpRisk::Low;
    }
    // Binaire arbitraire (chemin absolu vers un .exe, etc.) → medium : ce n'est
    // pas distant, mais ce n'est pas non plus un runner public connu.
    McpRisk::Medium
}

// ---------------------------------------------------------------------------
// Adapters — chacun lit UNE source et renvoie ses serveurs normalisés.
//
// Convention : `Ok(map)` = parsing réussi (map possiblement vide) ; `Err(msg)`
// = fichier présent mais illisible/malformé → remonté comme `SourceError`.
// Un fichier ABSENT n'est PAS une erreur (la source est simplement vide).
// ---------------------------------------------------------------------------

/// Lit un fichier ; `Ok(None)` si absent, `Ok(Some(texte))` si lu, `Err` si une
/// vraie erreur I/O survient (permissions, etc.).
fn read_optional(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("lecture {} : {e}", path.display())),
    }
}

/// Adapter Claude Desktop. `claude_desktop_config.json` partage le schéma
/// `mcpServers` de `.mcp.json` ; on réutilise donc le parseur de `mcp.rs`, mais
/// en tolérant les autres champs (globalShortcut, preferences…) qui l'entourent.
pub fn claude_desktop_servers(text: &str) -> Result<BTreeMap<String, McpServerConfig>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(BTreeMap::new());
    }
    let root: serde_json::Value =
        serde_json::from_str(t).map_err(|e| format!("JSON invalide : {e}"))?;
    let Some(servers) = root.get("mcpServers") else {
        return Ok(BTreeMap::new());
    };
    let map: BTreeMap<String, McpServerConfig> = serde_json::from_value(servers.clone())
        .map_err(|e| format!("champ `mcpServers` invalide : {e}"))?;
    Ok(map)
}

/// Adapter Codex. Parse `~/.codex/config.toml` et extrait `[mcp_servers.<name>]`.
/// Chaque table accepte `command` (string), `args` (array de strings), `url`
/// (string, transport distant), et `env` (sous-table string→string). Les autres
/// clés (startup_timeout_sec, etc.) sont ignorées.
pub fn codex_servers(text: &str) -> Result<BTreeMap<String, McpServerConfig>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(BTreeMap::new());
    }
    let root: toml::Value = toml::from_str(t).map_err(|e| format!("TOML invalide : {e}"))?;
    let mut out = BTreeMap::new();
    let Some(servers) = root.get("mcp_servers").and_then(|v| v.as_table()) else {
        return Ok(out);
    };
    for (name, val) in servers {
        let Some(tbl) = val.as_table() else { continue };
        let command = tbl
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let url = tbl.get("url").and_then(|v| v.as_str()).map(|s| s.to_string());
        let args = tbl
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let env = tbl
            .get("env")
            .and_then(|v| v.as_table())
            .map(|et| {
                et.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        out.insert(
            name.clone(),
            McpServerConfig {
                command,
                args,
                env,
                url,
            },
        );
    }
    Ok(out)
}

/// Adapter OpenCode. `opencode.json` → champ `mcp` : map nom→entrée. Chaque
/// entrée a un `type` ("local" | "remote"), un flag `enabled`, et soit
/// `command` (ARRAY : binaire + args) + `environment` (local), soit `url`
/// (remote). On renvoie aussi le flag `enabled` par serveur.
pub fn opencode_servers(
    text: &str,
) -> Result<BTreeMap<String, (McpServerConfig, Option<bool>)>, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(BTreeMap::new());
    }
    let root: serde_json::Value =
        serde_json::from_str(t).map_err(|e| format!("JSON invalide : {e}"))?;
    let mut out = BTreeMap::new();
    let Some(mcp) = root.get("mcp").and_then(|v| v.as_object()) else {
        return Ok(out);
    };
    for (name, val) in mcp {
        let enabled = val.get("enabled").and_then(|v| v.as_bool());
        let kind = val.get("type").and_then(|v| v.as_str()).unwrap_or("local");
        let cfg = if kind == "remote" {
            let url = val
                .get("url")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            McpServerConfig {
                command: None,
                args: Vec::new(),
                env: BTreeMap::new(),
                url,
            }
        } else {
            // local : `command` est un ARRAY [bin, ...args] ; `environment` est
            // une map string→string.
            let mut iter = val
                .get("command")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|a| a.as_str()).map(String::from))
                .into_iter()
                .flatten();
            let command = iter.next();
            let args: Vec<String> = iter.collect();
            let env = val
                .get("environment")
                .and_then(|v| v.as_object())
                .map(|o| {
                    o.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default();
            McpServerConfig {
                command,
                args,
                env,
                url: None,
            }
        };
        out.insert(name.clone(), (cfg, enabled));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/// Signature de dedup d'un serveur : (nom, transport, command, args, url). Deux
/// déclarations de même signature sont « le même serveur » et ne sont comptées
/// qu'une fois (l'occurrence Shugu prime, puis l'ordre des sources). L'`env`
/// n'entre PAS dans la signature : deux configs identiques dont seul un token
/// diffère restent le même serveur logique.
pub fn dedup_signature(name: &str, cfg: &McpServerConfig) -> String {
    let args = cfg.args.join("\u{1f}");
    format!(
        "{name}\u{1e}{transport}\u{1e}{cmd}\u{1e}{args}\u{1e}{url}",
        transport = cfg.transport(),
        cmd = cfg.command.as_deref().unwrap_or(""),
        url = cfg.url.as_deref().unwrap_or(""),
    )
}

// ---------------------------------------------------------------------------
// Agrégation : scan complet de l'inventaire
// ---------------------------------------------------------------------------

/// Construit l'inventaire complet : Shugu d'abord (toujours « importé »), puis
/// les sources externes, en dédupliquant par signature. Les erreurs de parsing
/// sont collectées et renvoyées (jamais avalées).
pub fn scan_inventory(app: &AppHandle) -> McpInventory {
    let mut inv = McpInventory::default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    // 1) Shugu (.mcp.json projet+global mergés) — toujours en tête, toujours
    //    `already_imported = true`. C'est la référence de dedup.
    let shugu = super::mcp::load_merged_config(app);
    for (name, cfg) in &shugu.mcp_servers {
        let sig = dedup_signature(name, cfg);
        seen.insert(sig);
        let secret_keys = secret_keys_of(cfg);
        let has_secret = !secret_keys.is_empty();
        let enabled = super::mcp::is_enabled(app, name);
        inv.entries.push(InventoryEntry {
            name: name.clone(),
            source: McpSourceKind::Shugu,
            source_label: McpSourceKind::Shugu.label().to_string(),
            transport: cfg.transport().to_string(),
            already_imported: true,
            enabled,
            source_enabled: None,
            risk: classify_risk(cfg, has_secret).label().to_string(),
            secret_env_keys: secret_keys,
            config: cfg.clone(),
        });
    }

    // 2) Sources externes, dans un ordre stable. Une entrée dont la signature
    //    existe déjà côté Shugu est marquée `already_imported = true` MAIS reste
    //    listée (sa provenance enrichit l'inventaire) ; une entrée déjà vue chez
    //    une source externe précédente est, elle, omise (vrai doublon).
    push_external(
        app,
        &mut inv,
        &mut seen,
        McpSourceKind::ClaudeDesktop,
        claude_desktop_config_path(app),
        |text| {
            claude_desktop_servers(text)
                .map(|m| m.into_iter().map(|(n, c)| (n, c, None)).collect())
        },
    );
    push_external(
        app,
        &mut inv,
        &mut seen,
        McpSourceKind::Codex,
        codex_config_path(app),
        |text| codex_servers(text).map(|m| m.into_iter().map(|(n, c)| (n, c, None)).collect()),
    );
    push_external(
        app,
        &mut inv,
        &mut seen,
        McpSourceKind::OpenCode,
        opencode_config_path(app),
        |text| {
            opencode_servers(text)
                .map(|m| m.into_iter().map(|(n, (c, en))| (n, c, en)).collect())
        },
    );

    inv
}

/// Helper générique pour une source externe : localise+lit le fichier, parse via
/// `parser`, et pousse les serveurs non-déjà-vus dans l'inventaire. Les erreurs
/// (fichier illisible / parsing) deviennent des `SourceError` visibles.
fn push_external<F>(
    app: &AppHandle,
    inv: &mut McpInventory,
    seen: &mut std::collections::HashSet<String>,
    source: McpSourceKind,
    path: Option<PathBuf>,
    parser: F,
) where
    F: Fn(&str) -> Result<Vec<(String, McpServerConfig, Option<bool>)>, String>,
{
    let Some(path) = path else {
        inv.errors.push(SourceError {
            source,
            source_label: source.label().to_string(),
            path: None,
            message: "emplacement introuvable (home dir indisponible)".to_string(),
        });
        return;
    };
    let text = match read_optional(&path) {
        Ok(Some(t)) => t,
        Ok(None) => return, // fichier absent → source vide, pas une erreur.
        Err(message) => {
            inv.errors.push(SourceError {
                source,
                source_label: source.label().to_string(),
                path: Some(path.display().to_string()),
                message,
            });
            return;
        }
    };
    let servers = match parser(&text) {
        Ok(s) => s,
        Err(message) => {
            inv.errors.push(SourceError {
                source,
                source_label: source.label().to_string(),
                path: Some(path.display().to_string()),
                message,
            });
            return;
        }
    };
    // Dedup déterministe : trie par nom pour un ordre d'affichage stable.
    let mut servers = servers;
    servers.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, cfg, source_enabled) in servers {
        let sig = dedup_signature(&name, &cfg);
        let already = seen.contains(&sig);
        // Un vrai doublon inter-sources externes (même signature, déjà poussé
        // par une source externe précédente OU par Shugu) : on l'ignore, SAUF si
        // c'est un match Shugu — auquel cas on le saute aussi car l'entrée Shugu
        // le représente déjà (et porte `already_imported = true`).
        if already {
            continue;
        }
        seen.insert(sig);
        let secret_keys = secret_keys_of(&cfg);
        let has_secret = !secret_keys.is_empty();
        inv.entries.push(InventoryEntry {
            name,
            source,
            source_label: source.label().to_string(),
            transport: cfg.transport().to_string(),
            already_imported: false,
            enabled: false,
            source_enabled,
            risk: classify_risk(&cfg, has_secret).label().to_string(),
            secret_env_keys: secret_keys,
            config: cfg,
        });
    }
    let _ = app; // app conservé pour symétrie/évolutivité (lecture future de settings).
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_key_detection() {
        assert!(is_secret_env_key("GITHUB_PERSONAL_ACCESS_TOKEN"));
        assert!(is_secret_env_key("API_KEY"));
        assert!(is_secret_env_key("APIKEY"));
        assert!(is_secret_env_key("NOTION_TOKEN"));
        assert!(is_secret_env_key("OPENAI_API_KEY"));
        assert!(is_secret_env_key("password"));
        assert!(is_secret_env_key("BEARER_AUTH"));
        // Non-secrets.
        assert!(!is_secret_env_key("NODE_PATH"));
        assert!(!is_secret_env_key("MONKEY")); // KEY ne doit pas matcher MONKEY
        assert!(!is_secret_env_key("API_BASE"));
        assert!(!is_secret_env_key("PORT"));
    }

    #[test]
    fn cred_sentinel_roundtrip() {
        let acct = cred_account_for("github", "GITHUB_PERSONAL_ACCESS_TOKEN");
        assert_eq!(acct, "mcp.github.env.GITHUB_PERSONAL_ACCESS_TOKEN");
        let sentinel = cred_sentinel_for(&acct);
        assert_eq!(sentinel, "${cred:mcp.github.env.GITHUB_PERSONAL_ACCESS_TOKEN}");
        assert!(is_cred_sentinel(&sentinel));
        assert_eq!(extract_cred_account(&sentinel), Some(acct.as_str()));
        assert!(!is_cred_sentinel("ghp_realtoken"));
        assert_eq!(extract_cred_account("plain"), None);
    }

    #[test]
    fn claude_desktop_parsing() {
        let json = r#"{
          "globalShortcut": "Ctrl+Space",
          "mcpServers": {
            "fs": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/tmp"] },
            "remote": { "url": "https://example.com/mcp" }
          },
          "preferences": { "x": 1 }
        }"#;
        let m = claude_desktop_servers(json).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m["fs"].transport(), "stdio");
        assert_eq!(m["fs"].command.as_deref(), Some("npx"));
        assert_eq!(m["remote"].transport(), "http");
    }

    #[test]
    fn claude_desktop_empty_mcp() {
        // Le vrai config sur la machine a `"mcpServers": {}`.
        let json = r#"{ "globalShortcut": "x", "mcpServers": {} }"#;
        assert!(claude_desktop_servers(json).unwrap().is_empty());
        // Pas de champ mcpServers du tout → vide, pas une erreur.
        assert!(claude_desktop_servers(r#"{"foo":1}"#).unwrap().is_empty());
    }

    #[test]
    fn claude_desktop_invalid_errors() {
        assert!(claude_desktop_servers("{ not json").is_err());
    }

    #[test]
    fn codex_toml_parsing() {
        let toml_src = r#"
model = "gpt-5.5"

[mcp_servers.node_repl]
command = 'C:\path\node_repl.exe'
args = []
startup_timeout_sec = 120

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = 'C:\path\node.exe'
GITHUB_TOKEN = "ghp_xxx"

[mcp_servers.lsmcp]
command = "cmd"
args = ["/c", "npx -y @mizchi/lsmcp"]

[mcp_servers.remote_one]
url = "https://example.com/mcp"

[projects.'f:\dev\shugu_code']
trust_level = "trusted"
"#;
        let m = codex_servers(toml_src).unwrap();
        assert_eq!(m.len(), 3);
        assert_eq!(m["node_repl"].transport(), "stdio");
        assert_eq!(m["node_repl"].command.as_deref(), Some(r"C:\path\node_repl.exe"));
        assert_eq!(m["node_repl"].env.get("GITHUB_TOKEN").map(String::as_str), Some("ghp_xxx"));
        assert_eq!(m["node_repl"].env.get("NODE_REPL_NODE_PATH").map(String::as_str), Some(r"C:\path\node.exe"));
        assert_eq!(m["lsmcp"].command.as_deref(), Some("cmd"));
        assert_eq!(m["lsmcp"].args, vec!["/c", "npx -y @mizchi/lsmcp"]);
        assert_eq!(m["remote_one"].transport(), "http");
    }

    #[test]
    fn codex_toml_empty_and_invalid() {
        assert!(codex_servers("").unwrap().is_empty());
        // TOML valide mais sans table mcp_servers.
        assert!(codex_servers("model = \"x\"").unwrap().is_empty());
        // TOML cassé.
        assert!(codex_servers("[mcp_servers.x\nbroken").is_err());
    }

    #[test]
    fn opencode_parsing_remote_and_local() {
        let json = r#"{
          "$schema": "https://opencode.ai/config.json",
          "mcp": {
            "unityMCP": { "type": "remote", "url": "http://localhost:8080/mcp", "enabled": true },
            "fsLocal": {
              "type": "local",
              "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
              "environment": { "API_TOKEN": "secret" },
              "enabled": false
            }
          }
        }"#;
        let m = opencode_servers(json).unwrap();
        assert_eq!(m.len(), 2);
        let (unity, unity_en) = &m["unityMCP"];
        assert_eq!(unity.transport(), "http");
        assert_eq!(unity.url.as_deref(), Some("http://localhost:8080/mcp"));
        assert_eq!(*unity_en, Some(true));
        let (fs, fs_en) = &m["fsLocal"];
        assert_eq!(fs.transport(), "stdio");
        assert_eq!(fs.command.as_deref(), Some("npx"));
        assert_eq!(fs.args, vec!["-y", "@modelcontextprotocol/server-filesystem", "."]);
        assert_eq!(fs.env.get("API_TOKEN").map(String::as_str), Some("secret"));
        assert_eq!(*fs_en, Some(false));
    }

    #[test]
    fn opencode_empty_and_invalid() {
        assert!(opencode_servers("").unwrap().is_empty());
        assert!(opencode_servers(r#"{"foo":1}"#).unwrap().is_empty());
        assert!(opencode_servers("{ bad").is_err());
    }

    #[test]
    fn risk_classification() {
        let npx = McpServerConfig {
            command: Some("npx".into()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
        };
        assert_eq!(classify_risk(&npx, false), McpRisk::Low);
        // npx + secret en clair → medium.
        assert_eq!(classify_risk(&npx, true), McpRisk::Medium);

        let remote = McpServerConfig {
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://x/mcp".into()),
        };
        assert_eq!(classify_risk(&remote, false), McpRisk::High);

        let shell = McpServerConfig {
            command: Some("cmd".into()),
            args: vec!["/c".into(), "do stuff".into()],
            env: BTreeMap::new(),
            url: None,
        };
        assert_eq!(classify_risk(&shell, false), McpRisk::Medium);

        let arbitrary = McpServerConfig {
            command: Some(r"C:\bin\thing.exe".into()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
        };
        assert_eq!(classify_risk(&arbitrary, false), McpRisk::Medium);

        let invalid = McpServerConfig {
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: None,
        };
        assert_eq!(classify_risk(&invalid, false), McpRisk::Medium);
    }

    #[test]
    fn dedup_signature_ignores_env() {
        let a = McpServerConfig {
            command: Some("npx".into()),
            args: vec!["-y".into(), "pkg".into()],
            env: BTreeMap::from([("TOKEN".into(), "aaa".into())]),
            url: None,
        };
        let b = McpServerConfig {
            command: Some("npx".into()),
            args: vec!["-y".into(), "pkg".into()],
            env: BTreeMap::from([("TOKEN".into(), "bbb".into())]),
            url: None,
        };
        assert_eq!(dedup_signature("x", &a), dedup_signature("x", &b));
        // Args différents → signature différente.
        let c = McpServerConfig {
            args: vec!["-y".into(), "other".into()],
            ..a.clone()
        };
        assert_ne!(dedup_signature("x", &a), dedup_signature("x", &c));
        // Nom différent → signature différente.
        assert_ne!(dedup_signature("x", &a), dedup_signature("y", &a));
    }
}
