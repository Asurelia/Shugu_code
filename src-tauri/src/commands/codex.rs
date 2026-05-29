//! OpenAI Codex CLI bridge — shell out to the user's already-authenticated
//! `codex` binary (ChatGPT subscription via `~/.codex/auth.json`) instead of a
//! token-billed API key.
//!
//! Why a shell-out and not an HTTP provider: Codex is a *full autonomous agent*
//! (it reasons, edits files, runs commands inside its own OS-level sandbox), not
//! a chat-completion endpoint. We run `codex exec --json` and map its JSONL event
//! stream onto Shugu's existing surfaces.
//!
//! Binary resolution (Windows-first, the user's case): `npm i -g @openai/codex`
//! installs a `codex.cmd` batch shim — executing THAT would route through
//! `cmd.exe`, which we must never spawn (the user's cmd.exe AutoRun launches
//! their vault + CLI). So we resolve straight to the native Rust executable
//!   `<npm>/node_modules/@openai/codex/node_modules/@openai/codex-<plat>/vendor/<triple>/codex/codex.exe`
//! (verified present + runnable standalone, v0.125.0). No node, no cmd.exe — and
//! that native exe is also what carries the Windows sandbox.
//!
//! JSONL shape (captured live from 0.125.0, NOT from docs):
//!   {"type":"thread.started","thread_id":"…"}
//!   {"type":"turn.started"}
//!   {"type":"item.completed","item":{"id":"…","type":"agent_message","text":"…"}}
//!   {"type":"turn.completed","usage":{"input_tokens":…, "cached_input_tokens":…,
//!                                     "output_tokens":…, "reasoning_output_tokens":…}}
//!
//! Usage tracking: the per-run token counts above are EXACT (OpenAI's own numbers)
//! and we persist them. The subscription's authoritative quota (5h/weekly %, reset)
//! is NOT exposed in headless `exec` mode (verified: `rate_limits: null`, no
//! `codex status` subcommand — openai/codex issues #14728, #10233). So the UI shows
//! a LOCAL rolling-window estimate built from these real counts, clearly labelled.

use std::path::PathBuf;

use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::process::Command;

use crate::commands::agents::{get_conn, now_ms};

// ────────────────────────────────────────────────────────────────────────
// Types (camelCase over the wire to match the rest of the app)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAuth {
    /// True iff `~/.codex/auth.json` exists. We test existence only — never read
    /// the file (it holds the user's OAuth tokens).
    pub logged_in: bool,
    pub path: String,
    /// True iff a usable `codex` binary was resolved.
    pub binary_found: bool,
    pub binary: Option<String>,
    /// True iff Shugu uses a DEDICATED Codex home (CODEX_HOME) isolated from the
    /// terminal's global `~/.codex`. False = shared with the terminal login.
    pub dedicated: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    pub input_tokens: i64,
    pub cached_input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
}

/// Aggregate of one rolling time window (e.g. trailing 5h). A LOCAL estimate:
/// OpenAI does not expose the real remaining quota headless.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexWindow {
    pub window_secs: i64,
    pub runs: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRunRow {
    pub run_id: String,
    pub ts: i64,
    pub model: String,
    pub surface: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLimitEvent {
    pub ts: i64,
    pub kind: String,
    pub message: String,
}

/// A resolved command: a program plus any leading args (for the `node codex.js`
/// fallback the prefix carries the script path; for a native exe it's empty).
#[derive(Debug, Clone)]
pub struct CodexCmd {
    pub program: String,
    pub prefix_args: Vec<String>,
}

/// Public wrapper over the binary resolver, used by the app-server client.
pub fn resolve_codex_cmd() -> Result<CodexCmd, String> {
    resolve_codex()
}

/// Public wrapper so the app-server client can suppress the console window on
/// Windows without duplicating the cfg dance.
pub(crate) fn apply_no_window_pub(cmd: &mut Command) {
    apply_no_window(cmd);
}

// ────────────────────────────────────────────────────────────────────────
// Binary resolution
// ────────────────────────────────────────────────────────────────────────

/// Locate a runnable `codex`, preferring the native exe (no node, no cmd.exe).
/// Order: explicit override → real `codex.exe` on PATH (Store/standalone) →
/// the native exe nested in the npm package → `node` + `codex.js` fallback.
fn resolve_codex() -> Result<CodexCmd, String> {
    // 1. Power-user override.
    if let Some(p) = std::env::var_os("SHUGU_CODEX_BIN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Ok(CodexCmd { program: p.to_string_lossy().into_owned(), prefix_args: vec![] });
        }
    }

    // 2. A REAL `codex.exe` (or `codex` on unix) on PATH — Store / standalone
    //    installs put the native binary directly on PATH. (npm installs do NOT;
    //    they only add the .cmd/.ps1/sh shims, which `which` would also return —
    //    so we explicitly require the executable, and on Windows the shim is
    //    `codex.cmd`, not `codex.exe`, so this only matches a true native exe.)
    #[cfg(windows)]
    let path_name = "codex.exe";
    #[cfg(not(windows))]
    let path_name = "codex";
    if let Ok(p) = which::which(path_name) {
        // Guard: skip if it's actually a shim under the npm dir (defensive).
        let s = p.to_string_lossy();
        if !s.ends_with(".cmd") && !s.ends_with(".ps1") {
            return Ok(CodexCmd { program: p.to_string_lossy().into_owned(), prefix_args: vec![] });
        }
    }

    // 3. Native exe nested in the npm global package.
    if let Some(exe) = find_npm_native_exe() {
        return Ok(CodexCmd { program: exe.to_string_lossy().into_owned(), prefix_args: vec![] });
    }

    // 4. Fallback: `node <…>/@openai/codex/bin/codex.js` (node is a clean exe,
    //    never cmd.exe; codex.js does platform resolution for us).
    if let (Some(js), Ok(node)) = (find_npm_codex_js(), which::which("node")) {
        return Ok(CodexCmd {
            program: node.to_string_lossy().into_owned(),
            prefix_args: vec![js.to_string_lossy().into_owned()],
        });
    }

    Err("binaire `codex` introuvable. Installe-le (`npm i -g @openai/codex`) puis \
         connecte-toi avec `codex login`, ou définis SHUGU_CODEX_BIN."
        .into())
}

/// Default npm global prefix dir on each OS.
fn npm_global_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // npm's default global prefix on Windows is %APPDATA%\npm.
        std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("npm"))
    }
    #[cfg(not(windows))]
    {
        // Common default: $HOME/.npm-global or /usr/local. We probe a couple.
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".npm-global"))
    }
}

/// `<npm>/node_modules/@openai/codex/bin/codex.js` if present.
fn find_npm_codex_js() -> Option<PathBuf> {
    let js = npm_global_root()?
        .join("node_modules")
        .join("@openai")
        .join("codex")
        .join("bin")
        .join("codex.js");
    js.exists().then_some(js)
}

/// Walk the nested platform sub-package to the native `codex.exe`/`codex`:
/// `<npm>/node_modules/@openai/codex/node_modules/@openai/codex-<plat>/vendor/<triple>/codex/codex(.exe)`.
/// We read_dir the `vendor/` level so the target-triple folder name need not be
/// hard-coded (survives arch/version drift).
fn find_npm_native_exe() -> Option<PathBuf> {
    let root = npm_global_root()?;
    let codex_pkg = root.join("node_modules").join("@openai").join("codex");

    #[cfg(windows)]
    let (plat_glob, exe_name) = ("codex-win32", "codex.exe");
    #[cfg(target_os = "macos")]
    let (plat_glob, exe_name) = ("codex-darwin", "codex");
    #[cfg(all(unix, not(target_os = "macos")))]
    let (plat_glob, exe_name) = ("codex-linux", "codex");

    let platform_parent = codex_pkg.join("node_modules").join("@openai");
    let entries = std::fs::read_dir(&platform_parent).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(plat_glob) {
            continue;
        }
        let vendor = entry.path().join("vendor");
        let Ok(triples) = std::fs::read_dir(&vendor) else { continue };
        for triple in triples.flatten() {
            let candidate = triple.path().join("codex").join(exe_name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

// ────────────────────────────────────────────────────────────────────────
// Auth status (Tauri command)
// ────────────────────────────────────────────────────────────────────────

/// Report whether the user is logged in (auth.json exists under the ACTIVE home)
/// + whether a binary was resolved + which mode (dedicated vs shared). Never
/// reads the auth file contents.
#[tauri::command]
pub fn codex_auth_status(app: AppHandle) -> CodexAuth {
    let dedicated = codex_dedicated(&app);
    let home = active_codex_home(&app);
    let (logged_in, path) = match home {
        Some(d) => {
            let p = d.join("auth.json");
            (p.exists(), p.to_string_lossy().into_owned())
        }
        None => (false, "~/.codex/auth.json".to_string()),
    };
    let (binary_found, binary) = match resolve_codex() {
        Ok(c) => (true, Some(c.program)),
        Err(_) => (false, None),
    };
    CodexAuth { logged_in, path, binary_found, binary, dedicated }
}

/// Small extension so we don't depend on the `Manager`/`path()` trait import
/// shape at every call site.
trait PathHome {
    fn path_home(&self) -> Option<PathBuf>;
}
impl PathHome for AppHandle {
    fn path_home(&self) -> Option<PathBuf> {
        use tauri::Manager;
        self.path().home_dir().ok()
    }
}

// ────────────────────────────────────────────────────────────────────────
// Native metadata via the app-server (model list + REAL rate limits)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexModel {
    /// Stable id to pass to `turn/start`'s `model` field.
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub is_default: bool,
    pub default_reasoning_effort: String,
    /// Allowed reasoning efforts for this model (none|minimal|low|medium|high|xhigh).
    pub supported_efforts: Vec<String>,
}

/// One rate-limit window (primary = ~5h, secondary = weekly). REAL data from
/// OpenAI via the app-server — not the local estimate.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateWindow {
    pub used_percent: i64,
    pub resets_at: Option<i64>,
    pub window_duration_mins: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRateLimits {
    pub primary: Option<CodexRateWindow>,
    pub secondary: Option<CodexRateWindow>,
    pub plan_type: Option<String>,
}

/// List the models the user's account actually offers, with their supported
/// reasoning efforts — drives the chat model picker + effort selector.
#[tauri::command]
pub async fn codex_models(app: AppHandle) -> Result<Vec<CodexModel>, String> {
    let srv = crate::commands::codex_app_server::ensure(&app).await?;
    let resp = srv.request("model/list", serde_json::json!({})).await?;
    let data = resp
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("model/list: réponse sans `data`")?;
    let mut out = Vec::new();
    for m in data {
        if m.get("hidden").and_then(|h| h.as_bool()).unwrap_or(false) {
            continue;
        }
        let efforts = m
            .get("supportedReasoningEfforts")
            .and_then(|e| e.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| o.get("reasoningEffort").and_then(|r| r.as_str()))
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        out.push(CodexModel {
            model: m.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            display_name: m
                .get("displayName")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            description: m
                .get("description")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            is_default: m.get("isDefault").and_then(|x| x.as_bool()).unwrap_or(false),
            default_reasoning_effort: m
                .get("defaultReasoningEffort")
                .and_then(|x| x.as_str())
                .unwrap_or("medium")
                .to_string(),
            supported_efforts: efforts,
        });
    }
    Ok(out)
}

/// REAL account rate limits (5h primary + weekly secondary). Replaces the local
/// estimate when the app-server is reachable.
#[tauri::command]
pub async fn codex_rate_limits(app: AppHandle) -> Result<CodexRateLimits, String> {
    let srv = crate::commands::codex_app_server::ensure(&app).await?;
    let resp = srv
        .request("account/rateLimits/read", serde_json::json!({}))
        .await?;
    let snap = resp.get("rateLimits").cloned().unwrap_or(serde_json::Value::Null);
    let parse_window = |w: &serde_json::Value| -> Option<CodexRateWindow> {
        if w.is_null() {
            return None;
        }
        Some(CodexRateWindow {
            used_percent: w.get("usedPercent").and_then(|x| x.as_i64()).unwrap_or(0),
            resets_at: w.get("resetsAt").and_then(|x| x.as_i64()),
            window_duration_mins: w.get("windowDurationMins").and_then(|x| x.as_i64()),
        })
    };
    Ok(CodexRateLimits {
        primary: snap.get("primary").and_then(parse_window),
        secondary: snap.get("secondary").and_then(parse_window),
        plan_type: snap
            .get("planType")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string()),
    })
}

// ────────────────────────────────────────────────────────────────────────
// Dedicated vs shared Codex home (CODEX_HOME isolation)
// ────────────────────────────────────────────────────────────────────────

/// True iff the user opted into a Shugu-DEDICATED Codex account (setting
/// `provider.codex.dedicated == "true"`, written by the Connections card via the
/// settings table). Read directly here so EVERY codex spawn (chat, worker, login,
/// logout, status) is consistent without threading the flag through callers.
fn codex_dedicated(app: &AppHandle) -> bool {
    let Ok(conn_mutex) = get_conn(app) else { return false };
    let Ok(conn) = conn_mutex.lock() else { return false };
    conn.query_row(
        "SELECT value FROM settings WHERE key = 'provider.codex.dedicated' LIMIT 1",
        [],
        |r| r.get::<_, String>(0),
    )
    .map(|v| v == "true")
    .unwrap_or(false)
}

/// The Shugu-dedicated Codex home dir (`<app_config>/codex`), created on demand.
/// `None` when not in dedicated mode.
fn dedicated_home_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().ok()?.join("codex");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir)
}

/// The ACTIVE Codex home: the dedicated dir when isolation is on, else the
/// terminal-shared `~/.codex`. Used to locate `auth.json` and to set CODEX_HOME.
fn active_codex_home(app: &AppHandle) -> Option<PathBuf> {
    if codex_dedicated(app) {
        dedicated_home_dir(app)
    } else {
        app.path_home().map(|h| h.join(".codex"))
    }
}

/// Set `CODEX_HOME` on a spawn when (and only when) dedicated mode is on. In
/// shared mode we leave the env untouched so codex uses its default `~/.codex`
/// (the terminal login). Applied to every codex invocation.
pub(crate) fn apply_codex_home(app: &AppHandle, cmd: &mut Command) {
    if codex_dedicated(app) {
        if let Some(home) = dedicated_home_dir(app) {
            cmd.env("CODEX_HOME", home);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Streaming core
// ────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn apply_no_window(cmd: &mut Command) {
    // `creation_flags` is an inherent method on tokio's Command (Windows only) —
    // no `std::os::windows::process::CommandExt` import needed.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn apply_no_window(_cmd: &mut Command) {}

// ────────────────────────────────────────────────────────────────────────
// CHAT surface — read-only run, streamed via the caller's on_chunk (app-server)
// ────────────────────────────────────────────────────────────────────────

/// Parse a `turn/completed` usage object into our `CodexUsage`. The app-server
/// uses camelCase (`inputTokens`); we also accept the snake_case `*_tokens`
/// shape (exec JSONL) so the parser is robust across surfaces/versions.
fn parse_turn_usage(u: &serde_json::Value) -> Option<CodexUsage> {
    let get = |camel: &str, snake: &str| -> i64 {
        u.get(camel)
            .or_else(|| u.get(snake))
            .and_then(|x| x.as_i64())
            .unwrap_or(0)
    };
    let any = u.get("inputTokens").is_some()
        || u.get("input_tokens").is_some()
        || u.get("outputTokens").is_some()
        || u.get("output_tokens").is_some();
    if !any {
        return None;
    }
    Some(CodexUsage {
        input_tokens: get("inputTokens", "input_tokens"),
        cached_input_tokens: get("cachedInputTokens", "cached_input_tokens"),
        output_tokens: get("outputTokens", "output_tokens"),
        reasoning_tokens: get("reasoningOutputTokens", "reasoning_output_tokens"),
    })
}

/// Run a Codex chat turn over the native **app-server** (read-only sandbox: a
/// chat answer must never mutate files). Streams text token-by-token through
/// `on_chunk("content", …)` / `on_chunk("reasoning", …)` and records the run's
/// real token usage. `model` + `effort` are passed natively to `turn/start`
/// (this is what lets the user pick GPT-5.5 / reasoning level). Returns the full
/// assistant text.
pub async fn codex_chat_turn(
    app: &AppHandle,
    prompt: &str,
    model: Option<&str>,
    effort: Option<&str>,
    mut on_chunk: impl FnMut(&str, &str),
) -> Result<String, String> {
    let srv = crate::commands::codex_app_server::ensure(app).await?;
    let run_id = uuid::Uuid::new_v4().to_string();

    // 1. Start a thread. Read-only sandbox + never-approve so a chat answer can
    //    never mutate files or block on an approval prompt we don't surface.
    let thread_resp = srv
        .request(
            "thread/start",
            serde_json::json!({ "sandbox": "read-only", "approvalPolicy": "never" }),
        )
        .await?;
    let thread_id = thread_resp
        .get("thread")
        .and_then(|t| t.get("id"))
        .and_then(|i| i.as_str())
        .ok_or("thread/start: pas d'id de thread")?
        .to_string();

    // 2. Subscribe BEFORE turn/start so no early delta is lost.
    let mut rx = srv.subscribe(&thread_id);

    // 3. Build + fire the turn (model + effort native overrides).
    let mut params = serde_json::json!({
        "threadId": thread_id,
        "input": [{ "type": "text", "text": prompt }],
    });
    if let Some(m) = model {
        if !m.is_empty() {
            params["model"] = serde_json::json!(m);
        }
    }
    if let Some(e) = effort {
        if !e.is_empty() {
            params["effort"] = serde_json::json!(e);
        }
    }
    if let Err(e) = srv.request("turn/start", params).await {
        srv.unsubscribe(&thread_id);
        let low = e.to_lowercase();
        if low.contains("rate limit") || low.contains("usage limit") || low.contains("quota") {
            record_limit_event(app, "rate_limit", &e);
            return Err(format!("Limite Codex atteinte : {e}"));
        }
        return Err(e);
    }

    // 4. Drain notifications until the turn completes (or a 5-min backstop).
    let mut full = String::new();
    let mut usage: Option<CodexUsage> = None;
    let mut limit_hit: Option<String> = None;
    loop {
        let next = tokio::time::timeout(std::time::Duration::from_secs(300), rx.recv()).await;
        let v = match next {
            Ok(Some(v)) => v,
            Ok(None) => break,  // connection dropped
            Err(_) => break,    // overall timeout
        };
        let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let p = v.get("params").cloned().unwrap_or(serde_json::Value::Null);
        match method {
            "item/agentMessage/delta" => {
                if let Some(d) = p.get("delta").and_then(|x| x.as_str()) {
                    full.push_str(d);
                    on_chunk("content", d);
                }
            }
            "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
                if let Some(d) = p
                    .get("delta")
                    .or_else(|| p.get("text"))
                    .and_then(|x| x.as_str())
                {
                    on_chunk("reasoning", d);
                }
            }
            "turn/completed" => {
                if let Some(u) = p.get("turn").and_then(|t| t.get("usage")) {
                    usage = parse_turn_usage(u);
                }
                break;
            }
            "turn/failed" | "error" => {
                let msg = p
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .or_else(|| p.get("message").and_then(|m| m.as_str()))
                    .unwrap_or("codex turn failed")
                    .to_string();
                let low = msg.to_lowercase();
                if low.contains("rate limit")
                    || low.contains("usage limit")
                    || low.contains("quota")
                    || low.contains("limit reached")
                {
                    limit_hit = Some(msg);
                }
                break;
            }
            _ => {}
        }
    }
    srv.unsubscribe(&thread_id);

    if let Some(u) = &usage {
        record_usage(app, &run_id, model.unwrap_or(""), u, "chat");
    }
    if let Some(msg) = &limit_hit {
        record_limit_event(app, "rate_limit", msg);
        return Err(format!("Limite Codex atteinte : {msg}"));
    }
    Ok(full)
}

// ────────────────────────────────────────────────────────────────────────
// Usage persistence (rusqlite, shared shugu.db via agents::get_conn)
// ────────────────────────────────────────────────────────────────────────

fn record_usage(app: &AppHandle, run_id: &str, model: &str, u: &CodexUsage, surface: &str) {
    let Ok(conn_mutex) = get_conn(app) else { return };
    let Ok(conn) = conn_mutex.lock() else { return };
    let _ = conn.execute(
        "INSERT INTO codex_usage
            (run_id, ts, model, surface, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run_id,
            now_ms(),
            model,
            surface,
            u.input_tokens,
            u.cached_input_tokens,
            u.output_tokens,
            u.reasoning_tokens,
        ],
    );
}

fn record_limit_event(app: &AppHandle, kind: &str, message: &str) {
    let Ok(conn_mutex) = get_conn(app) else { return };
    let Ok(conn) = conn_mutex.lock() else { return };
    let _ = conn.execute(
        "INSERT INTO codex_limit_events (ts, kind, message) VALUES (?1, ?2, ?3)",
        params![now_ms(), kind, message],
    );
}

/// Sum the real token usage over a trailing window (e.g. 5h = 18000s). A LOCAL
/// estimate of consumption — not OpenAI's authoritative remaining quota.
#[tauri::command]
pub fn codex_usage_window(app: AppHandle, window_secs: i64) -> Result<CodexWindow, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let since = now_ms() - window_secs.max(0) * 1000;
    let row = conn
        .query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(input_tokens), 0),
                    COALESCE(SUM(output_tokens), 0),
                    COALESCE(SUM(input_tokens + output_tokens), 0)
               FROM codex_usage
              WHERE ts >= ?1",
            params![since],
            |r| {
                Ok(CodexWindow {
                    window_secs,
                    runs: r.get(0)?,
                    input_tokens: r.get(1)?,
                    output_tokens: r.get(2)?,
                    total_tokens: r.get(3)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    Ok(row)
}

/// Recent runs with their EXACT per-run token counts (newest first).
#[tauri::command]
pub fn codex_usage_recent(app: AppHandle, limit: i64) -> Result<Vec<CodexRunRow>, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT run_id, ts, model, surface, input_tokens, output_tokens, reasoning_tokens
               FROM codex_usage
              ORDER BY ts DESC
              LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit.max(1)], |r| {
            Ok(CodexRunRow {
                run_id: r.get(0)?,
                ts: r.get(1)?,
                model: r.get(2)?,
                surface: r.get(3)?,
                input_tokens: r.get(4)?,
                output_tokens: r.get(5)?,
                reasoning_tokens: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// The most recent "limit reached" event, if any (drives the UI banner).
#[tauri::command]
pub fn codex_limit_recent(app: AppHandle) -> Result<Option<CodexLimitEvent>, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let row = conn
        .query_row(
            "SELECT ts, kind, message FROM codex_limit_events ORDER BY ts DESC LIMIT 1",
            [],
            |r| {
                Ok(CodexLimitEvent {
                    ts: r.get(0)?,
                    kind: r.get(1)?,
                    message: r.get(2)?,
                })
            },
        )
        .ok();
    Ok(row)
}

// ────────────────────────────────────────────────────────────────────────
// Login / logout (in-app account connection)
// ────────────────────────────────────────────────────────────────────────

/// Log in to Codex natively over the app-server (`account/login/start` →
/// `account/login/completed`). No `codex login` subprocess. `device_auth=false`
/// uses the browser flow (`chatgpt`: returns an `authUrl` the user opens);
/// `true` uses the device-code flow (`chatgptDeviceCode`: returns a `userCode` +
/// `verificationUrl`). The actionable info is emitted on `codex://login` as a
/// `{phase:"prompt", …}` object so the Connections card can show it. Respects
/// the dedicated/shared CODEX_HOME (the app-server was spawned with it). Resolves
/// when the login completes (5-min backstop), or Err on failure/timeout.
#[tauri::command]
pub async fn codex_login(app: AppHandle, device_auth: bool) -> Result<(), String> {
    let srv = crate::commands::codex_app_server::ensure(&app).await?;
    let kind = if device_auth { "chatgptDeviceCode" } else { "chatgpt" };
    let resp = srv
        .request("account/login/start", serde_json::json!({ "type": kind }))
        .await?;

    let login_id = resp
        .get("loginId")
        .and_then(|x| x.as_str())
        .ok_or("account/login/start: pas de loginId")?
        .to_string();

    // Tell the card what the user must do (open a URL / enter a code).
    if device_auth {
        let _ = app.emit(
            "codex://login",
            serde_json::json!({
                "phase": "prompt",
                "kind": "device",
                "userCode": resp.get("userCode").and_then(|x| x.as_str()),
                "verificationUrl": resp.get("verificationUrl").and_then(|x| x.as_str()),
            }),
        );
    } else {
        let _ = app.emit(
            "codex://login",
            serde_json::json!({
                "phase": "prompt",
                "kind": "browser",
                "authUrl": resp.get("authUrl").and_then(|x| x.as_str()),
            }),
        );
    }

    // Await the completion notification (routed by loginId), with a 5-min backstop.
    let rx = srv.await_login(&login_id);
    match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(msg))) => {
            record_limit_event_if_quota(&app, &msg);
            Err(msg)
        }
        Ok(Err(_)) => Err("connexion annulée".into()),
        Err(_) => {
            srv.cancel_login_wait(&login_id);
            let _ = srv
                .request(
                    "account/login/cancel",
                    serde_json::json!({ "loginId": login_id }),
                )
                .await;
            Err("délai de connexion dépassé (5 min)".into())
        }
    }
}

/// Helper: flag a login failure as a quota event when the message looks like one.
fn record_limit_event_if_quota(app: &AppHandle, msg: &str) {
    let low = msg.to_lowercase();
    if low.contains("rate limit") || low.contains("usage limit") || low.contains("quota") {
        record_limit_event(app, "rate_limit", msg);
    }
}

/// Log out the active Codex account over the app-server (`account/logout`).
#[tauri::command]
pub async fn codex_logout(app: AppHandle) -> Result<(), String> {
    let srv = crate::commands::codex_app_server::ensure(&app).await?;
    srv.request("account/logout", serde_json::json!({})).await?;
    Ok(())
}
