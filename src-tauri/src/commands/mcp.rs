//! Lot C — client MCP (Model Context Protocol).
//!
//! Lance de vrais serveurs MCP (stdio local ou HTTP/SSE distant) via le SDK
//! `rmcp`, découvre leurs outils (`tools/list`) renommés `mcp__<server>__<tool>`,
//! et les exécute (`tools/call`). Les boucles d'outils du chat et des agents
//! concatènent ces outils (pour les serveurs ACTIVÉS) à leur schéma natif.
//!
//! Sûreté : un serveur n'est lancé ni exposé que s'il est explicitement activé
//! (`mcp.<server>.enabled` ≠ "false" dans la table settings ; défaut OFF).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Un serveur MCP tel que déclaré dans `.mcp.json`. `command`(+args/env) ⇒
/// transport stdio ; `url` ⇒ transport HTTP/SSE. Les deux sont mutuellement
/// exclusifs (un serveur est local OU distant).
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct McpServerConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl McpServerConfig {
    /// "stdio" si `command` présent, "http" si `url`, sinon "invalid".
    pub fn transport(&self) -> &'static str {
        if self.command.is_some() {
            "stdio"
        } else if self.url.is_some() {
            "http"
        } else {
            "invalid"
        }
    }
}

/// Le fichier `.mcp.json` : `{ "mcpServers": { "name": {…} } }`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct McpConfigFile {
    #[serde(rename = "mcpServers", default)]
    pub mcp_servers: BTreeMap<String, McpServerConfig>,
}

/// Parse un `.mcp.json` (texte). Tolère un fichier vide/absent → config vide.
pub fn parse_mcp_config(text: &str) -> Result<McpConfigFile, String> {
    let t = text.trim();
    if t.is_empty() {
        return Ok(McpConfigFile::default());
    }
    serde_json::from_str::<McpConfigFile>(t).map_err(|e| format!("`.mcp.json` invalide : {e}"))
}

/// Merge projet (prioritaire) sur global : un serveur de même nom côté projet
/// écrase celui du global.
pub fn merge_configs(global: McpConfigFile, project: McpConfigFile) -> McpConfigFile {
    let mut out = global;
    for (name, cfg) in project.mcp_servers {
        out.mcp_servers.insert(name, cfg);
    }
    out
}

// ---------------------------------------------------------------------------
// Task 2 — localisation + lecture/écriture des fichiers `.mcp.json`
// ---------------------------------------------------------------------------

/// Chemin du `.mcp.json` projet (`<workspace>/.mcp.json`). `None` si aucun
/// workspace n'est ouvert. On NE vérifie PAS l'existence du fichier ici : la
/// lecture tolère l'absence, l'écriture le crée.
pub fn project_config_path(app: &AppHandle) -> Option<PathBuf> {
    let root = crate::commands::fs::restore_workspace_root(app)?;
    Some(root.join(".mcp.json"))
}

/// Chemin du `.mcp.json` global (`~/.mcp.json`). `None` si le home dir est
/// introuvable.
pub fn global_config_path(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    Some(home.join(".mcp.json"))
}

/// Charge global + projet, mergés (projet prioritaire). Fichiers absents ou
/// illisibles ⇒ config vide (jamais d'erreur : un `.mcp.json` cassé ne doit pas
/// empêcher l'app de tourner — il sera simplement ignoré).
pub fn load_merged_config(app: &AppHandle) -> McpConfigFile {
    let read = |p: Option<PathBuf>| -> McpConfigFile {
        p.and_then(|p| std::fs::read_to_string(&p).ok())
            .and_then(|t| parse_mcp_config(&t).ok())
            .unwrap_or_default()
    };
    merge_configs(read(global_config_path(app)), read(project_config_path(app)))
}

/// Écrit (upsert) un serveur dans un `.mcp.json` — projet par défaut, global si
/// `global == true` — en préservant les autres serveurs. Crée le fichier s'il
/// n'existe pas (ou s'il est illisible : on repart d'une config vide plutôt que
/// d'échouer). Sérialise en JSON indenté.
pub fn write_server(
    app: &AppHandle,
    name: &str,
    cfg: &McpServerConfig,
    global: bool,
) -> Result<(), String> {
    let path = if global {
        global_config_path(app)
    } else {
        project_config_path(app)
    }
    .ok_or_else(|| "aucun emplacement de config (workspace fermé ?)".to_string())?;

    let mut file: McpConfigFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| parse_mcp_config(&t).ok())
        .unwrap_or_default();
    file.mcp_servers.insert(name.to_string(), cfg.clone());

    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("écriture {}: {e}", path.display()))
}

/// Supprime un serveur des DEUX fichiers (projet + global). Best-effort par
/// fichier : un fichier absent/illisible est ignoré, et seul un fichier qui
/// contenait réellement le serveur est réécrit.
pub fn remove_server(app: &AppHandle, name: &str) -> Result<(), String> {
    for path in [project_config_path(app), global_config_path(app)]
        .into_iter()
        .flatten()
    {
        if let Ok(t) = std::fs::read_to_string(&path) {
            if let Ok(mut file) = parse_mcp_config(&t) {
                if file.mcp_servers.remove(name).is_some() {
                    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
                    std::fs::write(&path, text)
                        .map_err(|e| format!("écriture {}: {e}", path.display()))?;
                }
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Task 2 — flag `enabled` par serveur (table `settings` ; défaut OFF)
// ---------------------------------------------------------------------------

/// Lit une clé de la table `settings`. Réutilise la connexion partagée des
/// agents (`agents::get_conn`) — même fichier `shugu.db` que tauri-plugin-sql,
/// sérialisé via WAL. `None` si la clé est absente OU si l'accès DB échoue (la
/// lecture d'un flag ne doit jamais faire planter l'app).
fn read_setting(app: &AppHandle, key: &str) -> Option<String> {
    let conn_mutex = crate::commands::agents::get_conn(app).ok()?;
    let conn = conn_mutex.lock().ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// Écrit une clé dans la table `settings` (upsert). `updated_at` = epoch ms,
/// comme le store de settings côté JS. La table `settings`
/// (`key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL`)
/// est créée au démarrage par le store JS ; on s'aligne sur son schéma.
fn write_setting(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let conn_mutex = crate::commands::agents::get_conn(app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
        rusqlite::params![key, value, now],
    )
    .map_err(|e| format!("écriture settings {key}: {e}"))?;
    Ok(())
}

/// Lit `mcp.<server>.enabled` dans la table `settings`. Défaut OFF : `true`
/// UNIQUEMENT si la valeur stockée vaut exactement `"true"` (absent, illisible,
/// `"false"` ou toute autre valeur ⇒ `false`). Sûreté : un serveur n'est lancé
/// ni exposé que s'il est explicitement activé.
pub fn is_enabled(app: &AppHandle, name: &str) -> bool {
    read_setting(app, &format!("mcp.{name}.enabled"))
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// Écrit `mcp.<server>.enabled` (`"true"` / `"false"`).
pub fn set_enabled_setting(app: &AppHandle, name: &str, enabled: bool) -> Result<(), String> {
    write_setting(
        app,
        &format!("mcp.{name}.enabled"),
        if enabled { "true" } else { "false" },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_empty_is_empty() {
        assert!(parse_mcp_config("").unwrap().mcp_servers.is_empty());
        assert!(parse_mcp_config("   \n").unwrap().mcp_servers.is_empty());
    }

    #[test]
    fn parse_stdio_and_http() {
        let json = r#"{
          "mcpServers": {
            "fs":     { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/tmp"] },
            "remote": { "url": "https://example.com/mcp" }
          }
        }"#;
        let c = parse_mcp_config(json).unwrap();
        assert_eq!(c.mcp_servers.len(), 2);
        assert_eq!(c.mcp_servers["fs"].transport(), "stdio");
        assert_eq!(c.mcp_servers["fs"].command.as_deref(), Some("npx"));
        assert_eq!(c.mcp_servers["remote"].transport(), "http");
    }

    #[test]
    fn parse_invalid_errors() {
        assert!(parse_mcp_config("{ not json").is_err());
    }

    #[test]
    fn merge_project_overrides_global() {
        let global = parse_mcp_config(r#"{"mcpServers":{"a":{"command":"old"},"b":{"command":"keep"}}}"#).unwrap();
        let project = parse_mcp_config(r#"{"mcpServers":{"a":{"command":"new"}}}"#).unwrap();
        let m = merge_configs(global, project);
        assert_eq!(m.mcp_servers.len(), 2);
        assert_eq!(m.mcp_servers["a"].command.as_deref(), Some("new"));
        assert_eq!(m.mcp_servers["b"].command.as_deref(), Some("keep"));
    }
}
