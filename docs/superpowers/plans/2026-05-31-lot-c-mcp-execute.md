# Lot C — MCP exécuté — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Faire tourner de vrais serveurs MCP (stdio + HTTP/SSE), découvrir leurs outils et les rendre appelables par le LLM dans le chat ET les agents, avec activation explicite par serveur.

**Architecture:** Un module Rust `commands/mcp.rs` gère config (`.mcp.json`), connexions (crate `rmcp`, singleton par serveur calqué sur `codex_app_server::ensure`), découverte d'outils namespacés `mcp__server__tool`, et dispatch `call_tool`. Les boucles d'outils existantes (chat `run_chat_tool_loop`, agent `tool_use_loop`) concatènent les outils MCP des serveurs activés à leur schéma et routent les `mcp__*` vers `mcp::mcp_execute`. Une section Settings gère les serveurs.

**Tech Stack:** Rust (`rmcp` 0.8 — client + transport-child-process + transport-sse-client/streamable-http, `tokio`), Tauri 2, React 18 + TanStack, SQLite (`settings`), `.mcp.json`. Build: `cargo check`/`cargo test` headless via vcvars64 ; `pnpm typecheck`/`pnpm test`.

**Spec:** `docs/superpowers/specs/2026-05-31-lot-c-mcp-execute-design.md`

---

## File Structure

**Nouveaux fichiers**
- `src-tauri/src/commands/mcp.rs` — config `.mcp.json`, `McpManager`, connexions `rmcp` (stdio+SSE), `tools/list` namespacé, `call_tool` dispatch, commandes Tauri. (Si trop gros >500 l., scinder `mcp/config.rs` + `mcp/mod.rs` au plan-time — décidé en Task 1.)
- `src/features/mcp/queries.ts` — hooks TanStack : `useMcpServers`, `useMcpToggle`, `useMcpTest`, mutations add/remove.
- `src/features/mcp/McpServersSection.tsx` — UI Settings (liste, toggle, Tester, ajouter/supprimer).

**Fichiers modifiés**
- `src-tauri/Cargo.toml` — dépendance `rmcp`.
- `src-tauri/src/commands/mod.rs` — `pub mod mcp;`.
- `src-tauri/src/lib.rs` — enregistrer les commandes Tauri MCP + `.manage(McpManager)`.
- `src-tauri/src/commands/chat.rs` — `run_chat_tool_loop` : concaténer outils MCP + router `mcp__*`.
- `src-tauri/src/commands/agents/tools.rs` + `agents/runner.rs` — idem pour la boucle agent.
- `src/features/connections/Connections.tsx` — monter `McpServersSection`.

---

## Phase 1 — Client MCP + config + commandes (validable EN VOYANT)

### Task 1 : Dépendance rmcp + squelette module + parsing `.mcp.json` (TDD)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/commands/mcp.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1 : Ajouter la dépendance rmcp**

Dans `src-tauri/Cargo.toml`, sous `[dependencies]`, ajouter :

```toml
# Lot C — client MCP (Model Context Protocol). SDK Rust officiel. Features :
#   client : rôle client (on consomme des serveurs MCP, on n'en est pas un).
#   transport-child-process : lance un serveur MCP local en sous-process (stdio).
#   transport-streamable-http-client : serveurs MCP distants (HTTP/SSE).
rmcp = { version = "0.8", features = ["client", "transport-child-process", "transport-streamable-http-client"] }
```

> Note plan : si `cargo` résout une version/feature différente (le nom de feature
> SSE a bougé entre versions de rmcp : `transport-sse-client` vs
> `transport-streamable-http-client`), ajuster d'après l'erreur `cargo` réelle —
> NE PAS deviner, lire le message. Repli documenté dans le spec (hand-roll stdio).

- [ ] **Step 2 : Écrire les tests de parsing config (échec attendu)**

Créer `src-tauri/src/commands/mcp.rs` avec, en bas, le module de tests :

```rust
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
        if self.command.is_some() { "stdio" }
        else if self.url.is_some() { "http" }
        else { "invalid" }
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
```

Déclarer le module : dans `src-tauri/src/commands/mod.rs`, ajouter `pub mod mcp;`
(au même style que les autres `pub mod`).

- [ ] **Step 3 : Lancer les tests (échec attendu : rmcp pas encore résolu ou module neuf)**

Run: `cmd /d /c "F:\Dev\shugu_code\src-tauri\_t.bat"` où `_t.bat` contient (créer puis supprimer après) :
```
@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
cargo test --manifest-path "%~dp0Cargo.toml" mcp:: 2>&1
echo EXIT=%ERRORLEVEL%
```
Expected: d'abord la résolution de `rmcp` (téléchargement), puis tests `mcp::tests::*`.
S'ils échouent à COMPILER à cause d'une feature rmcp inexistante → corriger le nom
de feature d'après l'erreur, re-lancer.

- [ ] **Step 4 : Vérifier les 4 tests verts**

Run: même commande.
Expected: `test result: ok. 4 passed` pour les tests `mcp::`.

- [ ] **Step 5 : Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/mcp.rs src-tauri/src/commands/mod.rs
git commit -m "✨ feat(mcp): dépendance rmcp + parsing .mcp.json (config stdio/http, merge, tests)"
```
(ligne `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`)

### Task 2 : Localisation + lecture/écriture des fichiers `.mcp.json`

**Files:**
- Modify: `src-tauri/src/commands/mcp.rs`

> Réutiliser : `crate::commands::fs::restore_workspace_root(&app)` (fs.rs:231)
> pour le root projet ; `app.path().home_dir()` (Tauri) pour `~`. Accès settings
> SQLite : suivre le pattern `codex.rs:393` (`SELECT value FROM settings WHERE key=…`)
> — ouvrir une `rusqlite::Connection` sur `app_config_dir()/shugu.db` comme
> `agents/mod.rs::get_conn`, OU réutiliser un helper settings s'il existe.

- [ ] **Step 1 : Implémenter la résolution + le chargement fusionné**

Ajouter à `mcp.rs` :

```rust
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Chemin du `.mcp.json` projet (workspace ouvert) s'il existe.
pub fn project_config_path(app: &AppHandle) -> Option<PathBuf> {
    let root = crate::commands::fs::restore_workspace_root(app)?;
    let p = root.join(".mcp.json");
    Some(p)
}

/// Chemin du `.mcp.json` global (`~/.mcp.json`).
pub fn global_config_path(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    Some(home.join(".mcp.json"))
}

/// Charge global + projet, mergés (projet prioritaire). Fichiers absents = vides.
pub fn load_merged_config(app: &AppHandle) -> McpConfigFile {
    let read = |p: Option<PathBuf>| -> McpConfigFile {
        p.and_then(|p| std::fs::read_to_string(&p).ok())
            .and_then(|t| parse_mcp_config(&t).ok())
            .unwrap_or_default()
    };
    merge_configs(read(global_config_path(app)), read(project_config_path(app)))
}

/// Écrit un serveur dans un `.mcp.json` (projet par défaut, global si `global`),
/// en préservant les autres serveurs. Crée le fichier s'il n'existe pas.
pub fn write_server(
    app: &AppHandle,
    name: &str,
    cfg: &McpServerConfig,
    global: bool,
) -> Result<(), String> {
    let path = if global { global_config_path(app) } else { project_config_path(app) }
        .ok_or_else(|| "aucun emplacement de config (workspace fermé ?)".to_string())?;
    let mut file: McpConfigFile = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| parse_mcp_config(&t).ok())
        .unwrap_or_default();
    file.mcp_servers.insert(name.to_string(), cfg.clone());
    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("écriture {}: {e}", path.display()))
}

/// Supprime un serveur des deux fichiers (best-effort par fichier).
pub fn remove_server(app: &AppHandle, name: &str) -> Result<(), String> {
    for path in [project_config_path(app), global_config_path(app)].into_iter().flatten() {
        if let Ok(t) = std::fs::read_to_string(&path) {
            if let Ok(mut file) = parse_mcp_config(&t) {
                if file.mcp_servers.remove(name).is_some() {
                    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
                    std::fs::write(&path, text).map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}
```

- [ ] **Step 2 : Helper settings enabled (défaut OFF)**

```rust
/// Lit `mcp.<server>.enabled` dans la table settings. Défaut OFF (absent = false).
pub fn is_enabled(app: &AppHandle, name: &str) -> bool {
    read_setting(app, &format!("mcp.{name}.enabled"))
        .map(|v| v == "true")
        .unwrap_or(false)
}

/// Écrit `mcp.<server>.enabled`.
pub fn set_enabled_setting(app: &AppHandle, name: &str, enabled: bool) -> Result<(), String> {
    write_setting(app, &format!("mcp.{name}.enabled"), if enabled { "true" } else { "false" })
}
```
Implémenter `read_setting`/`write_setting` via une `rusqlite::Connection` sur
`app_config_dir()/shugu.db` (calquer `agents/mod.rs::get_conn` — `INSERT OR REPLACE
INTO settings (key,value,updated_at)` pour write ; `SELECT value FROM settings
WHERE key=?1` pour read). Si un helper settings partagé existe déjà côté Rust,
l'utiliser plutôt que dupliquer.

- [ ] **Step 3 : `cargo check`**

Run: vcvars64 + `cargo check --manifest-path src-tauri/Cargo.toml`.
Expected: compile (warnings dead_code OK, consommé en Task 3+).

- [ ] **Step 4 : Commit**

```bash
git add src-tauri/src/commands/mcp.rs
git commit -m "✨ feat(mcp): localisation/lecture/écriture .mcp.json + flag enabled (settings)"
```

### Task 3 : Connexions rmcp (stdio + http) + list_tools + call_tool

**Files:**
- Modify: `src-tauri/src/commands/mcp.rs`

> API rmcp confirmée (Context7) : `().serve(transport).await?` → client ;
> `client.list_all_tools().await?` ; `client.call_tool(CallToolRequestParams::new(name).with_arguments(obj)).await?`.
> stdio : `TokioChildProcess::new(Command::new(cmd).configure(|c| { c.args(...); }))?`.
> http : `StreamableHttpClientTransport` (cf. doc — `with_uri(url)`). Lire la
> version résolue de rmcp pour les chemins exacts d'import.

- [ ] **Step 1 : Manager + type de connexion**

```rust
use std::sync::{Arc, Mutex, OnceLock};

/// Une connexion vive à un serveur MCP + le cache de ses outils (tools/list au
/// handshake). Le type exact du client rmcp dépend de la version ; on stocke un
/// `RunningService<RoleClient, ()>` (alias rmcp) derrière un Arc.
pub struct McpConn {
    pub client: Arc<rmcp::service::RunningService<rmcp::RoleClient, ()>>,
    /// Outils bruts (rmcp `Tool`) du serveur, capturés au connect.
    pub tools: Vec<rmcp::model::Tool>,
}

#[derive(Default)]
pub struct McpManager(pub Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<McpConn>>>>);
```
> ⚠ Les chemins `rmcp::service::RunningService` / `rmcp::RoleClient` / `rmcp::model::Tool`
> sont à confirmer contre la version résolue (Task 1) — `cargo doc --open` ou lire
> `~/.cargo/registry/.../rmcp-*/src/lib.rs`. Ajuster les imports si besoin (NE PAS deviner).

- [ ] **Step 2 : Connexion (lazy) selon le transport**

```rust
use rmcp::ServiceExt;
use rmcp::transport::{ConfigureCommandExt, TokioChildProcess};

/// Ouvre (ou renvoie depuis le cache) la connexion à `name`. Erreur si le
/// serveur n'est pas dans la config fusionnée. NE vérifie PAS `enabled` ici —
/// l'appelant décide (test = ignore enabled ; exécution = exige enabled).
pub async fn connect(
    app: &AppHandle,
    mgr: &McpManager,
    name: &str,
) -> Result<Arc<McpConn>, String> {
    {
        let map = mgr.0.lock().await;
        if let Some(c) = map.get(name) {
            return Ok(c.clone());
        }
    }
    let cfg = load_merged_config(app)
        .mcp_servers
        .remove(name)
        .ok_or_else(|| format!("serveur MCP inconnu : {name}"))?;

    let client = match cfg.transport() {
        "stdio" => {
            let command = cfg.command.clone().unwrap();
            let args = cfg.args.clone();
            let env = cfg.env.clone();
            let mut tcmd = tokio::process::Command::new(&command);
            tcmd.configure(|c| {
                c.args(&args);
                for (k, v) in &env { c.env(k, v); }
            });
            // Windows : pas de fenêtre console parasite (réutilise codex helper).
            crate::commands::codex::apply_no_window_pub(&mut tcmd);
            let transport = TokioChildProcess::new(tcmd)
                .map_err(|e| format!("spawn MCP {name}: {e}"))?;
            ().serve(transport).await.map_err(|e| format!("handshake MCP {name}: {e}"))?
        }
        "http" => {
            let url = cfg.url.clone().unwrap();
            let transport = rmcp::transport::StreamableHttpClientTransport::from_uri(url.as_str());
            ().serve(transport).await.map_err(|e| format!("connexion MCP {name}: {e}"))?
        }
        _ => return Err(format!("config MCP {name} invalide (ni command ni url)")),
    };

    let tools = client
        .list_all_tools()
        .await
        .map_err(|e| format!("tools/list {name}: {e}"))?;

    let conn = Arc::new(McpConn { client: Arc::new(client), tools });
    mgr.0.lock().await.insert(name.to_string(), conn.clone());
    Ok(conn)
}
```
> Les noms exacts (`StreamableHttpClientTransport::from_uri` vs `::new(config)`,
> `list_all_tools` vs `list_tools`) sont à valider contre la version rmcp.
> Adapter d'après `cargo check` + la doc de la version. Documente l'API réelle
> utilisée dans un commentaire.

- [ ] **Step 3 : Namespacing + rendu schéma provider**

```rust
/// Préfixe un nom d'outil serveur → `mcp__<server>__<tool>`.
pub fn namespaced(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{tool}")
}

/// Décompose `mcp__<server>__<tool>` → (server, tool). None si pas un nom MCP.
pub fn split_namespaced(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    Some((rest[..idx].to_string(), rest[idx + 2..].to_string()))
}

/// Rend les outils MCP de TOUS les serveurs activés au format `tools` du provider.
/// `protocol`: "anthropic" → {name, description, input_schema} ; sinon OpenAI
/// {type:function, function:{name, description, parameters}}.
pub async fn enabled_tools_json(
    app: &AppHandle,
    mgr: &McpManager,
    protocol: &str,
) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let cfg = load_merged_config(app);
    for (server, _) in cfg.mcp_servers.iter() {
        if !is_enabled(app, server) { continue; }
        let conn = match connect(app, mgr, server).await {
            Ok(c) => c,
            Err(_) => continue, // serveur en erreur : on l'ignore, pas de crash
        };
        for t in &conn.tools {
            let full = namespaced(server, &t.name);
            let schema = serde_json::to_value(&t.input_schema).unwrap_or_else(|_| serde_json::json!({"type":"object"}));
            let desc = t.description.clone().unwrap_or_default();
            if protocol == "anthropic" {
                out.push(serde_json::json!({ "name": full, "description": desc, "input_schema": schema }));
            } else {
                out.push(serde_json::json!({ "type":"function", "function": { "name": full, "description": desc, "parameters": schema } }));
            }
        }
    }
    out
}
```
> `t.name` / `t.description` / `t.input_schema` : champs du `rmcp::model::Tool` —
> confirmer les noms/typages exacts contre la version (input_schema peut être un
> `Arc<Map>`). Adapter la sérialisation en conséquence.

- [ ] **Step 4 : Exécution d'un outil MCP**

```rust
use rmcp::model::CallToolRequestParam;

/// Exécute `mcp__server__tool` avec `args` JSON. NE retourne jamais Err :
/// échec ⇒ (message, is_error=true). Aplati le résultat MCP en texte pour le LLM.
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
    let arguments = args.as_object().cloned();
    let call = CallToolRequestParam { name: tool.into(), arguments };
    let fut = conn.client.call_tool(call);
    match tokio::time::timeout(std::time::Duration::from_secs(60), fut).await {
        Ok(Ok(res)) => (flatten_tool_result(&res), res.is_error.unwrap_or(false)),
        Ok(Err(e)) => (format!("appel MCP {full_name}: {e}"), true),
        Err(_) => (format!("appel MCP {full_name}: délai dépassé (60s)"), true),
    }
}

/// Aplati les content-blocks d'un CallToolResult en texte (le LLM lit du texte).
fn flatten_tool_result(res: &rmcp::model::CallToolResult) -> String {
    res.content.iter().filter_map(|c| {
        // rmcp `Content` est un enum ; on extrait le texte. Les images/blobs
        // deviennent un marqueur (le chat ne les rend pas inline pour l'instant).
        serde_json::to_value(c).ok().and_then(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
    }).collect::<Vec<_>>().join("\n")
}
```
> `CallToolRequestParam` (singulier) vs `CallToolRequestParams`, et la forme de
> `CallToolResult.content` / `is_error` : à confirmer contre la version. La
> sérialisation défensive (`to_value` puis `["text"]`) évite de coder en dur la
> variante d'enum si elle diffère ; si l'API expose `c.as_text()` proprement,
> préférer ça. Adapter au plan-time.

- [ ] **Step 5 : `cargo check`**

Run: vcvars64 + `cargo check`. Expected: compile.

- [ ] **Step 6 : Commit**

```bash
git add src-tauri/src/commands/mcp.rs
git commit -m "✨ feat(mcp): connexions rmcp (stdio+http), list_tools namespacé, call_tool"
```

### Task 4 : Commandes Tauri MCP + enregistrement

**Files:**
- Modify: `src-tauri/src/commands/mcp.rs`, `src-tauri/src/lib.rs`

- [ ] **Step 1 : Structs de sortie + commandes**

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub transport: String,   // "stdio" | "http" | "invalid"
    pub enabled: bool,
    pub connected: bool,
    pub tool_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo { pub name: String, pub description: String }

#[tauri::command]
pub async fn mcp_list_servers(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
) -> Result<Vec<McpServerStatus>, String> {
    let cfg = load_merged_config(&app);
    let mut out = Vec::new();
    for (name, c) in cfg.mcp_servers.iter() {
        let enabled = is_enabled(&app, name);
        let connected = mgr.0.lock().await.contains_key(name);
        let tool_count = if connected {
            mgr.0.lock().await.get(name).map(|c| c.tools.len()).unwrap_or(0)
        } else { 0 };
        out.push(McpServerStatus {
            name: name.clone(), transport: c.transport().to_string(),
            enabled, connected, tool_count, error: None,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn mcp_test_server(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
) -> Result<Vec<McpToolInfo>, String> {
    let conn = connect(&app, &mgr, &name).await?;
    Ok(conn.tools.iter().map(|t| McpToolInfo {
        name: t.name.to_string(),
        description: t.description.clone().unwrap_or_default(),
    }).collect())
}

#[tauri::command]
pub async fn mcp_set_enabled(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    set_enabled_setting(&app, &name, enabled)?;
    if !enabled {
        // Déconnecte : drop le client (le sous-process s'arrête).
        mgr.0.lock().await.remove(&name);
    }
    Ok(())
}

#[tauri::command]
pub async fn mcp_add_server(
    app: AppHandle,
    name: String,
    config: McpServerConfig,
    global: bool,
) -> Result<(), String> {
    write_server(&app, &name, &config, global)
}

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

#[tauri::command]
pub async fn mcp_call_tool(
    app: AppHandle,
    mgr: tauri::State<'_, McpManager>,
    name: String,
    args: serde_json::Value,
) -> Result<String, String> {
    let (content, is_error) = mcp_execute(&app, &mgr, &name, &args).await;
    if is_error { Err(content) } else { Ok(content) }
}
```

- [ ] **Step 2 : Enregistrer dans lib.rs**

Dans `src-tauri/src/lib.rs` : `.manage(commands::mcp::McpManager::default())` à côté
des autres `.manage(...)`, et dans `invoke_handler![...]` ajouter :
```rust
commands::mcp::mcp_list_servers,
commands::mcp::mcp_test_server,
commands::mcp::mcp_set_enabled,
commands::mcp::mcp_add_server,
commands::mcp::mcp_remove_server,
commands::mcp::mcp_call_tool,
```

- [ ] **Step 3 : `cargo check` + cargo test**

Run: vcvars64 + `cargo check` puis `cargo test mcp::`.
Expected: compile ; les 4 tests de parsing toujours verts.

- [ ] **Step 4 : Commit**

```bash
git add src-tauri/src/commands/mcp.rs src-tauri/src/lib.rs
git commit -m "✨ feat(mcp): commandes Tauri (list/test/set_enabled/add/remove/call) + manage"
```

### Task 5 : Vérif EN VOYANT Phase 1 (manuel, pas de commit)

- [ ] **Step 1** : Créer un `.mcp.json` à la racine d'un workspace de test :
```json
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","."] } } }
```
- [ ] **Step 2** : Lancer `tauri-dev.cmd`. Dans la console JS (ou un bouton debug),
  `invoke("mcp_list_servers")` → voir `fs` (transport stdio, enabled=false).
- [ ] **Step 3** : `invoke("mcp_test_server",{name:"fs"})` → voir la liste des
  outils du serveur filesystem (`read_file`, `list_directory`, …).
- [ ] **Step 4** : `invoke("mcp_set_enabled",{name:"fs",enabled:true})` puis
  `invoke("mcp_call_tool",{name:"mcp__fs__list_directory",args:{path:"."}})` →
  voir un vrai résultat. Smoke-test Windows (npx sans fenêtre console parasite).

---

## Phase 2 — Injection chat + agents

### Task 6 : Outils MCP dans la boucle chat

**Files:**
- Modify: `src-tauri/src/commands/chat.rs` (`run_chat_tool_loop`)

> Contexte (Lot A) : `run_chat_tool_loop` construit `tools_json` =
> `chat_tools_json_*(write_enabled)`. La fonction `chat_send` a accès à `app`.
> `run_chat_tool_loop` reçoit `app: &tauri::AppHandle`. Le `McpManager` est en
> `app.state::<McpManager>()`.

- [ ] **Step 1 : Concaténer les outils MCP au schéma**

Dans `run_chat_tool_loop`, là où `tools_json` est construit (chat.rs ~815), après
avoir obtenu le tableau de base, fusionner les outils MCP des serveurs activés :

```rust
let tools_json: Option<serde_json::Value> = if with_tools {
    let mut arr = match protocol {
        "anthropic" => chat_tools_json_anthropic(write_enabled),
        _ => chat_tools_json_openai(write_enabled),
    };
    // Lot C — ajouter les outils MCP des serveurs activés.
    let mgr = app.state::<crate::commands::mcp::McpManager>();
    let mcp_tools = crate::commands::mcp::enabled_tools_json(app, &mgr, protocol).await;
    if let Some(a) = arr.as_array_mut() { a.extend(mcp_tools); }
    Some(arr)
} else {
    None
};
```
> `chat_tools_json_*` renvoie un `serde_json::Value::Array` — vérifier que c'est
> bien le cas et qu'`as_array_mut` marche (sinon construire le Vec puis json!()).

- [ ] **Step 2 : Router les `mcp__*` au dispatch**

Là où chaque tool-call est exécuté (chat.rs ~900, `execute_chat_tool`), router :

```rust
let (content, is_error) = if tc.name.starts_with("mcp__") {
    let mgr = app.state::<crate::commands::mcp::McpManager>();
    crate::commands::mcp::mcp_execute(app, &mgr, &tc.name, &args).await
} else {
    match &root {
        Some(r) => execute_chat_tool(&tc.name, &args, r, write_enabled, journal),
        None => ("aucun workspace ouvert — impossible d'exécuter l'outil".to_string(), true),
    }
};
```
La visibilité `chat://delta kind:"tool"` reste : ajouter un libellé MCP dans
`chat_tool_label` (`mcp__server__tool` → `🔌 server__tool`). Le journal d'annulation
ne concerne PAS les outils MCP (ils agissent hors workspace ; pas de revert local).

- [ ] **Step 3 : `cargo check`**

Run: vcvars64 + `cargo check`. Expected: compile.

- [ ] **Step 4 : Commit**

```bash
git add src-tauri/src/commands/chat.rs
git commit -m "✨ feat(mcp): outils MCP injectés + routés dans la boucle d'outils du chat"
```

### Task 7 : Outils MCP dans la boucle agent

**Files:**
- Modify: `src-tauri/src/commands/agents/tools.rs`, `src-tauri/src/commands/agents/runner.rs`

> Contexte : `runner.rs::call_agent_llm_with_tools` injecte `tools_json_anthropic()`
> / `tools_json_openai()` (de `agents/tools.rs`) dans le body. `execute_tool`
> (tools.rs:394) dispatche par nom. Le runner a `app: &AppHandle`.

- [ ] **Step 1 : Concaténer les outils MCP au body agent**

Dans `runner.rs`, là où les tools sont passés à `call_anthropic_structured` /
`call_openai_compat_structured` (via le param `tools` Lot A), construire le tableau
fusionné natif + MCP (serveurs activés) — même technique que Task 6 step 1, en
réutilisant `mcp::enabled_tools_json(app, &mgr, protocol)`.

- [ ] **Step 2 : Router `mcp__*` dans le dispatch agent**

Dans la boucle `tool_use_loop` (runner.rs ~604, là où `execute_tool` est appelé via
`spawn_blocking`), traiter les `mcp__*` AVANT le dispatch fs : comme `mcp_execute`
est async (et `execute_tool` est sync dans `spawn_blocking`), router en amont —
si `tc.name.starts_with("mcp__")`, faire `mcp::mcp_execute(...).await` directement
(hors `spawn_blocking`) et construire le `ToolResult` ; sinon garder le chemin
`spawn_blocking(execute_tool)` actuel. Émettre `AgentEvent::ToolCall`/`ToolResult`
comme pour les outils natifs (déjà fait autour).

- [ ] **Step 3 : `cargo check` + cargo test**

Run: vcvars64 + `cargo check` puis `cargo test`.
Expected: compile ; tests agents existants verts.

- [ ] **Step 4 : Commit**

```bash
git add src-tauri/src/commands/agents/tools.rs src-tauri/src/commands/agents/runner.rs
git commit -m "✨ feat(mcp): outils MCP injectés + routés dans la boucle d'agent"
```

### Task 8 : Vérif EN VOYANT Phase 2 (manuel, pas de commit)

- [ ] Activer le serveur `fs` (Task 5). Dans le chat (modèle anthropic/openai),
  demander « liste les fichiers du dossier courant via MCP » → tool-call
  `🔌 fs__list_directory` visible + résultat réel.
- [ ] Déléguer une tâche à un agent qui utilise un outil MCP → `AgentEvent` MCP
  visible dans le transcript. Smoke-test Windows.

---

## Phase 3 — UI Settings « Serveurs MCP »

### Task 9 : Hooks TanStack MCP

**Files:**
- Create: `src/features/mcp/queries.ts`

- [ ] **Step 1 : Implémenter les hooks**

```ts
// src/features/mcp/queries.ts — hooks TanStack pour les serveurs MCP.
import { useQuery, useMutation } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";

export interface McpServerStatus {
  name: string; transport: string; enabled: boolean;
  connected: boolean; toolCount: number; error?: string;
}
export interface McpToolInfo { name: string; description: string }
export interface McpServerConfig {
  command?: string; args?: string[]; env?: Record<string,string>; url?: string;
}

const KEY = ["mcp", "servers"] as const;

export function useMcpServers() {
  return useQuery<McpServerStatus[]>({
    queryKey: KEY,
    queryFn: () => invoke<McpServerStatus[]>("mcp_list_servers"),
    staleTime: 5_000,
  });
}

export function useMcpToggle() {
  return useMutation({
    mutationFn: (p: { name: string; enabled: boolean }) =>
      invoke("mcp_set_enabled", { name: p.name, enabled: p.enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMcpTest() {
  return useMutation<McpToolInfo[], unknown, string>({
    mutationFn: (name: string) => invoke<McpToolInfo[]>("mcp_test_server", { name }),
  });
}

export function useMcpAdd() {
  return useMutation({
    mutationFn: (p: { name: string; config: McpServerConfig; global: boolean }) =>
      invoke("mcp_add_server", { name: p.name, config: p.config, global: p.global }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMcpRemove() {
  return useMutation({
    mutationFn: (name: string) => invoke("mcp_remove_server", { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
```

- [ ] **Step 2 : Typecheck + commit**

Run: `pnpm typecheck`. Expected: PASS.
```bash
git add src/features/mcp/queries.ts
git commit -m "✨ feat(mcp): hooks TanStack (list/toggle/test/add/remove)"
```

### Task 10 : Section UI « Serveurs MCP »

**Files:**
- Create: `src/features/mcp/McpServersSection.tsx`
- Modify: `src/features/connections/Connections.tsx`

> Lire `Connections.tsx` d'abord pour le pattern de carte/section + les primitives
> (`SettingRow`, `Switch`) et la charte glass. Réutiliser, ne pas réinventer.

- [ ] **Step 1 : Composant section**

Créer `McpServersSection.tsx` : liste `useMcpServers()` avec, par serveur, le nom,
un badge transport (stdio/http), un `Switch` lié à `useMcpToggle()`, un bouton
« Tester » qui appelle `useMcpTest()` et affiche les outils (ou l'erreur) en
dessous, et un bouton supprimer (`useMcpRemove()`). En tête, un bouton « Ajouter
un serveur » ouvrant un petit formulaire (nom ; type stdio→command+args+env, ou
http→url ; scope projet/global) qui appelle `useMcpAdd()`. États vides pédagogiques
(mémoire « UI auto-explicative ») : si aucun serveur, expliquer ce qu'est MCP +
pointer `.mcp.json`. Secrets `env` : champ marqué sensible (cf. spec — keychain
optionnel ; v1 peut écrire en clair dans `.mcp.json` AVEC un avertissement visible).

- [ ] **Step 2 : Monter dans Connections**

Dans `Connections.tsx`, ajouter la section/onglet « Serveurs MCP » qui rend
`<McpServersSection/>`.

- [ ] **Step 3 : Typecheck + commit**

Run: `pnpm typecheck`. Expected: PASS.
```bash
git add src/features/mcp/McpServersSection.tsx src/features/connections/Connections.tsx
git commit -m "✨ feat(mcp): section Settings « Serveurs MCP » (liste, toggle, test, add/remove)"
```

### Task 11 : Vérif EN VOYANT Phase 3 + revue + merge (manuel)

- [ ] Settings → Connections → Serveurs MCP : ajouter un serveur via le formulaire,
  le tester (voir ses outils), l'activer, l'utiliser dans le chat — tout via l'UI.
- [ ] Gates : `cargo check`/`cargo test` (vcvars64) verts, `pnpm typecheck`/`pnpm test` verts.
- [ ] Revue par agent SANS contexte sur le diff `main..HEAD`.
- [ ] Merge `feat/lot-c-mcp-execute-20260531` → `main` + suppression branche (politique git auto-merge), une fois revue OK + vérif en voyant validée par l'utilisateur.

---

## Notes de risque (à figer en cours d'implémentation)
- **rmcp API/features** : version + noms exacts (`StreamableHttpClientTransport`,
  `list_all_tools`, `CallToolRequestParam`, `Tool.input_schema`,
  `CallToolResult.content`/`is_error`) — confirmer contre la version résolue, ne
  pas deviner ; repli hand-roll stdio si blocage majeur.
- **Windows spawn npx/uvx** : `apply_no_window_pub` + résolution binaire ; tester
  tôt (mémoire « pas de sous-cmd »). Si `npx` n'est pas trouvable directement,
  voir comment codex résout son binaire (`which`).
- **mcp_execute async dans la boucle agent** sync (`spawn_blocking`) : router en
  amont (await direct) plutôt que dans le closure bloquant.
- **Secrets `env`** : v1 clair dans `.mcp.json` + avertissement ; keychain en
  amélioration (réutilise `cred_*`).
- **call_tool borné 60 s** : un serveur lent ne gèle pas la boucle.

## Self-review (couverture spec)
- Config `.mcp.json` lecture + écriture : Tasks 1-2, 4, 10 ✓
- Transport stdio + http : Task 3 ✓
- Activation explicite (défaut OFF) : Tasks 2 (is_enabled), 4 (set_enabled), 10 (toggle) ✓
- Injection chat : Task 6 ✓ ; agents : Task 7 ✓
- Découverte + namespacing + dispatch : Task 3 ✓
- UI Settings (liste/toggle/test/add/remove) : Tasks 9-10 ✓
- Visibilité tool-calls : Task 6 (label) + Task 7 (AgentEvent) ✓
- Sûreté (timeout, isolation erreur, pas de revert MCP) : Tasks 3-4, 6 ✓
- Vérif en voyant par phase : Tasks 5, 8, 11 ✓
