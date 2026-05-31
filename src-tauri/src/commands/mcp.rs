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

// ---------------------------------------------------------------------------
// Task 3 — connexions rmcp (stdio + http), découverte d'outils, exécution.
//
// API rmcp 1.7.0 RÉELLEMENT utilisée (vérifiée contre la SOURCE de la crate,
// `~/.cargo/.../rmcp-1.7.0/src/`) :
//   - `rmcp::ServiceExt` ajoute `.serve(transport)` à `()` (le handler client
//     par défaut : `()` implémente `ClientHandler`/`Service<RoleClient>`).
//     `().serve(transport).await` → `RunningService<RoleClient, ()>`.
//   - `list_all_tools` / `call_tool` sont des méthodes INHÉRENTES de
//     `Peer<RoleClient>` (service/client.rs). `RunningService` Deref vers
//     `Peer` (service.rs:512), MAIS le compilateur 1.7 ne les résout pas par
//     coercion sur `RunningService` → on les appelle via `client.peer()`.
//   - `list_all_tools(&self) -> Result<Vec<Tool>, ServiceError>` (client.rs:378)
//     pagine `list_tools` jusqu'au bout. Capturé au handshake.
//   - `call_tool` prend un `CallToolRequestParams` (PLURIEL en 1.7 ;
//     `CallToolRequestParam` au singulier = alias déprécié) et renvoie
//     `Result<CallToolResult, ServiceError>`. `CallToolRequestParams` est
//     `#[non_exhaustive]` (model.rs:2955) → `::new(name)` puis `.arguments`.
//   - `rmcp::model::Tool` (model/tool.rs:17) : `name: Cow<'static, str>`,
//     `description: Option<Cow<'static, str>>`, `input_schema: Arc<JsonObject>`.
//   - `CallToolResult` (model.rs:2774) : `content: Vec<Content>`,
//     `is_error: Option<bool>` ; serde `rename_all = "camelCase"` → `isError`.
//     On NE code PAS contre la variante d'enum `Content` : on sérialise le
//     résultat en JSON et on extrait les blocs `text` + le drapeau `isError`.
//   - stdio : `TokioChildProcess::new(command)` où `command: impl Into<CommandWrap>`,
//     satisfait par un `tokio::process::Command` (conversion via process-wrap).
//   - http  : `StreamableHttpClientTransport::from_uri(&str)`, gardé par la
//     feature rmcp `transport-streamable-http-client-reqwest` (voir Cargo.toml).
// ---------------------------------------------------------------------------

use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::ServiceExt;
use std::collections::HashMap;
use std::sync::Arc;

/// Type concret du client rmcp obtenu après `().serve(transport)`.
type McpClient = rmcp::service::RunningService<rmcp::RoleClient, ()>;

/// Une connexion vive à un serveur MCP + le cache de ses outils (capturés au
/// handshake via `tools/list`). Le client (sous-process stdio ou session HTTP)
/// reste ouvert tant que le `McpConn` est en vie ; le drop coupe la connexion.
pub struct McpConn {
    /// Client rmcp nu. `McpConn` est toujours partagé derrière `Arc<McpConn>`.
    pub client: McpClient,
    /// Outils bruts (rmcp `Tool`) du serveur, capturés au connect.
    pub tools: Vec<rmcp::model::Tool>,
}

/// Singleton de connexions MCP, une par serveur (calqué sur le pattern Codex
/// app-server). `tokio::sync::Mutex` car `connect` est async et tient le lock
/// au-dessus d'`await`.
#[derive(Default)]
pub struct McpManager(pub Arc<tokio::sync::Mutex<HashMap<String, Arc<McpConn>>>>);

/// Ouvre (ou renvoie depuis le cache) la connexion à `name`. Erreur si le
/// serveur n'est pas dans la config fusionnée. NE vérifie PAS `enabled` ici —
/// l'appelant décide (test = ignore enabled ; exécution = exige enabled).
pub async fn connect(app: &AppHandle, mgr: &McpManager, name: &str) -> Result<Arc<McpConn>, String> {
    // Cache-hit : connexion déjà ouverte.
    {
        let map = mgr.0.lock().await;
        if let Some(c) = map.get(name) {
            return Ok(c.clone());
        }
    }

    // Résout la config du serveur (projet > global).
    let cfg = load_merged_config(app)
        .mcp_servers
        .remove(name)
        .ok_or_else(|| format!("serveur MCP inconnu : {name}"))?;

    let client: McpClient = match cfg.transport() {
        "stdio" => {
            let command = cfg
                .command
                .clone()
                .ok_or_else(|| format!("config MCP {name} : `command` manquant"))?;
            // `tokio::process::Command` se configure via ses méthodes inhérentes
            // (`args`/`env`) — pas besoin du trait `ConfigureCommandExt` de rmcp.
            // `TokioChildProcess::new` accepte `impl Into<CommandWrap>`, satisfait
            // par `tokio::process::Command`.
            let mut tcmd = tokio::process::Command::new(&command);
            tcmd.args(&cfg.args);
            for (k, v) in &cfg.env {
                tcmd.env(k, v);
            }
            // Windows : pas de fenêtre console parasite (réutilise le helper codex).
            crate::commands::codex::apply_no_window_pub(&mut tcmd);
            let transport =
                TokioChildProcess::new(tcmd).map_err(|e| format!("spawn MCP {name} : {e}"))?;
            ().serve(transport)
                .await
                .map_err(|e| format!("handshake MCP {name} : {e}"))?
        }
        "http" => {
            let url = cfg
                .url
                .clone()
                .ok_or_else(|| format!("config MCP {name} : `url` manquant"))?;
            let transport = StreamableHttpClientTransport::from_uri(url.as_str());
            ().serve(transport)
                .await
                .map_err(|e| format!("connexion MCP {name} : {e}"))?
        }
        _ => return Err(format!("config MCP {name} invalide (ni command ni url)")),
    };

    // Découverte des outils au handshake (toutes les pages). `list_all_tools`
    // vit sur `Peer<RoleClient>` → on passe par `.peer()` (cf. `call_tool`).
    let tools = client
        .peer()
        .list_all_tools()
        .await
        .map_err(|e| format!("tools/list {name} : {e}"))?;

    let conn = Arc::new(McpConn { client, tools });
    mgr.0.lock().await.insert(name.to_string(), conn.clone());
    Ok(conn)
}

/// Préfixe un nom d'outil serveur → `mcp__<server>__<tool>`.
pub fn namespaced(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{tool}")
}

/// Décompose `mcp__<server>__<tool>` → (server, tool). `None` si pas un nom MCP.
/// Coupe au PREMIER `__` après le préfixe : un nom d'outil contenant lui-même
/// `__` reste intègre côté `tool`.
pub fn split_namespaced(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    Some((rest[..idx].to_string(), rest[idx + 2..].to_string()))
}

/// Rend les outils MCP de TOUS les serveurs ACTIVÉS au format `tools` du
/// provider. `protocol == "anthropic"` → `{name, description, input_schema}` ;
/// sinon (OpenAI/compatibles) → `{type:"function", function:{name, description,
/// parameters}}`. Un serveur en erreur de connexion est IGNORÉ (pas de crash).
pub async fn enabled_tools_json(
    app: &AppHandle,
    mgr: &McpManager,
    protocol: &str,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let cfg = load_merged_config(app);
    for server in cfg.mcp_servers.keys() {
        if !is_enabled(app, server) {
            continue;
        }
        let conn = match connect(app, mgr, server).await {
            Ok(c) => c,
            Err(_) => continue, // serveur indisponible : on l'ignore proprement.
        };
        for t in &conn.tools {
            let full = namespaced(server, &t.name);
            // `input_schema` est un `Arc<JsonObject>` → sérialisable tel quel.
            let schema = serde_json::to_value(&t.input_schema)
                .unwrap_or_else(|_| serde_json::json!({ "type": "object" }));
            let desc = t
                .description
                .as_ref()
                .map(|d| d.to_string())
                .unwrap_or_default();
            if protocol == "anthropic" {
                out.push(serde_json::json!({
                    "name": full,
                    "description": desc,
                    "input_schema": schema,
                }));
            } else {
                out.push(serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": full,
                        "description": desc,
                        "parameters": schema,
                    },
                }));
            }
        }
    }
    out
}

/// Exécute `mcp__server__tool` avec `args` JSON. NE retourne JAMAIS d'erreur
/// Rust ni ne panique : tout échec ⇒ `(message, is_error=true)`. Le résultat
/// MCP est aplati en texte (le LLM lit du texte). Appel borné à 60 s.
pub async fn mcp_execute(
    app: &AppHandle,
    mgr: &McpManager,
    full_name: &str,
    args: &serde_json::Value,
) -> (String, bool) {
    let Some((server, tool)) = split_namespaced(full_name) else {
        return (format!("nom d'outil MCP invalide : {full_name}"), true);
    };
    if !is_enabled(app, &server) {
        return (format!("serveur MCP « {server} » désactivé"), true);
    }
    let conn = match connect(app, mgr, &server).await {
        Ok(c) => c,
        Err(e) => return (e, true),
    };
    // `CallToolRequestParams` est `#[non_exhaustive]` → construction via
    // `::new(name)` puis pose de `arguments` (un `Option<JsonObject>` =
    // `Option<Map<String, Value>>`).
    let mut call = rmcp::model::CallToolRequestParams::new(tool);
    call.arguments = args.as_object().cloned();
    // `call_tool` est une méthode inhérente de `Peer<RoleClient>` → via `.peer()`.
    let fut = conn.client.peer().call_tool(call);
    match tokio::time::timeout(std::time::Duration::from_secs(60), fut).await {
        Ok(Ok(res)) => flatten_tool_result(&res),
        Ok(Err(e)) => (format!("appel MCP {full_name} : {e}"), true),
        Err(_) => (format!("appel MCP {full_name} : délai dépassé (60s)"), true),
    }
}

/// Aplati un `CallToolResult` en `(texte, is_error)`. Découplé du typage exact
/// de `content`/`is_error` : on sérialise le résultat en JSON et on en extrait
/// les blocs texte + le drapeau `isError`. Les images/blobs (sans champ `text`)
/// sont ignorés (le chat ne les rend pas inline pour l'instant) ; si AUCUN bloc
/// texte n'est trouvé, on rend le JSON brut pour ne rien perdre.
fn flatten_tool_result(res: &rmcp::model::CallToolResult) -> (String, bool) {
    let value = match serde_json::to_value(res) {
        Ok(v) => v,
        Err(e) => return (format!("résultat MCP illisible : {e}"), true),
    };
    let is_error = value
        .get("isError")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let texts: Vec<String> = value
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let text = if texts.is_empty() {
        // Pas de bloc texte : on rend le JSON du résultat (mieux que vide).
        value.to_string()
    } else {
        texts.join("\n")
    };
    (text, is_error)
}

// ---------------------------------------------------------------------------
// Task 4 — commandes Tauri MCP.
//
// REQUIS pour que l'arbre COMPILE : `src/lib.rs` (commité avant les corps, à
// 5994f0f) référence déjà `commands::mcp::{mcp_list_servers, mcp_test_server,
// mcp_set_enabled, mcp_add_server, mcp_remove_server, mcp_call_tool}` dans
// `generate_handler!` et `.manage(McpManager::default())`. Sans ces corps, le
// crate ne build pas (E0433). Ils vivent UNIQUEMENT dans mcp.rs.
// ---------------------------------------------------------------------------

/// État d'un serveur MCP pour l'UI Settings. `connected`/`tool_count` reflètent
/// le cache du `McpManager` (un serveur non encore connecté affiche 0 outil).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub transport: String, // "stdio" | "http" | "invalid"
    pub enabled: bool,
    pub connected: bool,
    pub tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Un outil découvert sur un serveur (pour le bouton « Tester »).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

/// Liste les serveurs de la config fusionnée + leur état (activé / connecté /
/// nombre d'outils). Ne connecte RIEN : reflète seulement la config + le cache.
#[tauri::command]
pub async fn mcp_list_servers(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
) -> Result<Vec<McpServerStatus>, String> {
    let cfg = load_merged_config(&app);
    let mut out = Vec::new();
    for (name, c) in cfg.mcp_servers.iter() {
        let enabled = is_enabled(&app, name);
        // Un seul lock pour connected + tool_count.
        let (connected, tool_count) = {
            let map = mgr.0.lock().await;
            match map.get(name) {
                Some(conn) => (true, conn.tools.len()),
                None => (false, 0),
            }
        };
        out.push(McpServerStatus {
            name: name.clone(),
            transport: c.transport().to_string(),
            enabled,
            connected,
            tool_count,
            error: None,
        });
    }
    Ok(out)
}

/// Connecte (sans exiger `enabled`) et renvoie la liste des outils — c'est le
/// bouton « Tester » de l'UI. Propage l'erreur de connexion telle quelle.
#[tauri::command]
pub async fn mcp_test_server(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
) -> Result<Vec<McpToolInfo>, String> {
    let conn = connect(&app, &mgr, &name).await?;
    Ok(conn
        .tools
        .iter()
        .map(|t| McpToolInfo {
            name: t.name.to_string(),
            description: t
                .description
                .as_ref()
                .map(|d| d.to_string())
                .unwrap_or_default(),
        })
        .collect())
}

/// Active/désactive un serveur (persisté en settings). À la désactivation, on
/// drop la connexion en cache → le sous-process stdio s'arrête / la session
/// HTTP se ferme (le `Drop` de `RunningService` coupe la connexion).
#[tauri::command]
pub async fn mcp_set_enabled(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    set_enabled_setting(&app, &name, enabled)?;
    if !enabled {
        mgr.0.lock().await.remove(&name);
    }
    Ok(())
}

/// Ajoute (upsert) un serveur dans `.mcp.json` (projet par défaut, global si
/// `global`). Ne connecte pas : l'activation reste un geste explicite séparé.
#[tauri::command]
pub async fn mcp_add_server(
    app: AppHandle,
    name: String,
    config: McpServerConfig,
    global: bool,
) -> Result<(), String> {
    write_server(&app, &name, &config, global)
}

/// Supprime un serveur des `.mcp.json` ET du cache de connexions.
#[tauri::command]
pub async fn mcp_remove_server(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
) -> Result<(), String> {
    remove_server(&app, &name)?;
    mgr.0.lock().await.remove(&name);
    Ok(())
}

/// Exécute un outil MCP par nom namespacé. Mappe `(content, is_error)` →
/// `Result` : `is_error` ⇒ `Err(content)`, sinon `Ok(content)`.
#[tauri::command]
pub async fn mcp_call_tool(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
    args: serde_json::Value,
) -> Result<String, String> {
    let (content, is_error) = mcp_execute(&app, &mgr, &name, &args).await;
    if is_error {
        Err(content)
    } else {
        Ok(content)
    }
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

    #[test]
    fn namespacing_roundtrip() {
        assert_eq!(namespaced("fs", "read_file"), "mcp__fs__read_file");
        // Round-trip : un nom namespacé se redécompose en (server, tool).
        assert_eq!(
            split_namespaced("mcp__fs__read_file"),
            Some(("fs".to_string(), "read_file".to_string()))
        );
        // Un outil dont le nom contient lui-même `__` : on coupe au PREMIER `__`
        // après le préfixe → server="git", tool="sub__cmd".
        assert_eq!(
            split_namespaced("mcp__git__sub__cmd"),
            Some(("git".to_string(), "sub__cmd".to_string()))
        );
        // Noms non-MCP → None.
        assert_eq!(split_namespaced("read_file"), None);
        assert_eq!(split_namespaced("mcp__noseparator"), None);
    }
}
