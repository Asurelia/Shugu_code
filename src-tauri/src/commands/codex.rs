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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
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
/// Order: explicit override → spawnable standalone `codex.exe` on PATH →
/// the native exe nested in the npm package → `node` + `codex.js` fallback.
fn resolve_codex() -> Result<CodexCmd, String> {
    // 1. Power-user override.
    if let Some(p) = std::env::var_os("SHUGU_CODEX_BIN") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Ok(CodexCmd {
                program: p.to_string_lossy().into_owned(),
                prefix_args: vec![],
            });
        }
    }

    // 2. A REAL `codex.exe` (or `codex` on unix) on PATH — standalone installs
    //    put the native binary directly on PATH. (npm installs do NOT;
    //    they only add the .cmd/.ps1/sh shims, which `which` would also return —
    //    so we explicitly require the executable, and on Windows the shim is
    //    `codex.cmd`, not `codex.exe`, so this only matches a true native exe.)
    //
    //    Do NOT select the executable inside Program Files\WindowsApps. That is
    //    the packaged Codex Desktop payload, not a normal CLI installation.
    //    `which` can see it while CreateProcess from an unpackaged Tauri app is
    //    rejected with ERROR_ACCESS_DENIED. Fall through to the npm-native CLI,
    //    which uses the same ~/.codex authentication and is spawnable.
    #[cfg(windows)]
    let path_name = "codex.exe";
    #[cfg(not(windows))]
    let path_name = "codex";
    if let Ok(p) = which::which(path_name) {
        // Guard: skip if it's actually a shim under the npm dir (defensive).
        let s = p.to_string_lossy();
        if !s.ends_with(".cmd") && !s.ends_with(".ps1") && !is_windowsapps_package_path(&p) {
            return Ok(CodexCmd {
                program: p.to_string_lossy().into_owned(),
                prefix_args: vec![],
            });
        }
    }

    // 3. Native exe nested in the npm global package.
    if let Some(exe) = find_npm_native_exe() {
        return Ok(CodexCmd {
            program: exe.to_string_lossy().into_owned(),
            prefix_args: vec![],
        });
    }

    // 4. Fallback: `node <…>/@openai/codex/bin/codex.js` (node is a clean exe,
    //    never cmd.exe; codex.js does platform resolution for us).
    if let (Some(js), Ok(node)) = (find_npm_codex_js(), which::which("node")) {
        return Ok(CodexCmd {
            program: node.to_string_lossy().into_owned(),
            prefix_args: vec![js.to_string_lossy().into_owned()],
        });
    }

    Err(
        "binaire `codex` introuvable. Installe-le (`pnpm add -g @openai/codex`) puis \
         connecte-toi avec `codex login`, ou définis SHUGU_CODEX_BIN."
            .into(),
    )
}

/// True for executables exposed from an MSIX/AppX payload. Those paths may be
/// discoverable through PATH while remaining non-spawnable by this Tauri app.
fn is_windowsapps_package_path(path: &std::path::Path) -> bool {
    path.to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase()
        .contains("\\program files\\windowsapps\\")
}

/// Candidate global package roots. Smoke tests deliberately override APPDATA,
/// while PATH still points at the user's global CLI shim, so relying on APPDATA
/// alone makes the resolver lose a perfectly valid Codex installation.
fn npm_global_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let mut push = |candidate: PathBuf| {
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    };

    #[cfg(windows)]
    {
        // npm's default global prefix on Windows is %APPDATA%\npm.
        if let Some(appdata) = std::env::var_os("APPDATA") {
            push(PathBuf::from(appdata).join("npm"));
        }
        // APPDATA may be process-isolated. The shim path on PATH remains an
        // authoritative way to recover the actual global package root.
        if let Ok(shim) = which::which("codex.cmd") {
            if let Some(parent) = shim.parent() {
                push(parent.to_path_buf());
            }
        }
        // Last deterministic Windows fallback when PATHEXT/which cannot see the
        // .cmd shim but USERPROFILE is available.
        if let Some(home) = std::env::var_os("USERPROFILE") {
            push(
                PathBuf::from(home)
                    .join("AppData")
                    .join("Roaming")
                    .join("npm"),
            );
        }
    }
    #[cfg(not(windows))]
    {
        // Common default: $HOME/.npm-global or /usr/local. We probe a couple.
        if let Some(home) = std::env::var_os("HOME") {
            push(PathBuf::from(home).join(".npm-global"));
        }
        if let Ok(shim) = which::which("codex") {
            if let Some(parent) = shim.parent() {
                push(parent.to_path_buf());
            }
        }
    }

    roots
}

/// `<npm>/node_modules/@openai/codex/bin/codex.js` if present.
fn find_npm_codex_js() -> Option<PathBuf> {
    npm_global_roots().into_iter().find_map(|root| {
        let js = root
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("bin")
            .join("codex.js");
        js.is_file().then_some(js)
    })
}

/// Walk the nested platform sub-package to the native `codex.exe`/`codex`:
/// `<npm>/node_modules/@openai/codex/node_modules/@openai/codex-<plat>/vendor/<triple>/codex/codex(.exe)`.
/// We read_dir the `vendor/` level so the target-triple folder name need not be
/// hard-coded (survives arch/version drift).
fn find_npm_native_exe() -> Option<PathBuf> {
    #[cfg(windows)]
    let (plat_glob, exe_name) = ("codex-win32", "codex.exe");
    #[cfg(target_os = "macos")]
    let (plat_glob, exe_name) = ("codex-darwin", "codex");
    #[cfg(all(unix, not(target_os = "macos")))]
    let (plat_glob, exe_name) = ("codex-linux", "codex");

    for root in npm_global_roots() {
        let platform_parent = root
            .join("node_modules")
            .join("@openai")
            .join("codex")
            .join("node_modules")
            .join("@openai");
        let Ok(entries) = std::fs::read_dir(&platform_parent) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(plat_glob) {
                continue;
            }
            let vendor = entry.path().join("vendor");
            let Ok(triples) = std::fs::read_dir(&vendor) else {
                continue;
            };
            for triple in triples.flatten() {
                let candidate = triple.path().join("codex").join(exe_name);
                if candidate.is_file() {
                    return Some(candidate);
                }
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
    CodexAuth {
        logged_in,
        path,
        binary_found,
        binary,
        dedicated,
    }
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
            model: m
                .get("model")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
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
            is_default: m
                .get("isDefault")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
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
    let snap = resp
        .get("rateLimits")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
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
    let Ok(conn_mutex) = get_conn(app) else {
        return false;
    };
    let Ok(conn) = conn_mutex.lock() else {
        return false;
    };
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

// ════════════════════════════════════════════════════════════════════════
// AM-4 — Codex version isolation + tolerant `codex exec --json` parsing
// ════════════════════════════════════════════════════════════════════════
//
// Codex is a single Rust binary whose JSONL event schema has MOVED across
// closely-spaced releases (0.125 → 0.130 → 0.142 in a matter of days). The
// app-server path (`codex_chat_turn`) is the primary surface, but the headless
// `codex exec --json` stream remains a documented fallback contract — and a
// schema drift in EITHER must degrade, not crash, Shugu.
//
// This layer is the version-isolation boundary the audit (AM-4) calls for:
//   1. `codex_detect_version` — runs `codex --version`, parses + logs the
//      semver so a drift is observable instead of silent.
//   2. `CodexExecEvent` — a NORMALIZED event enum produced by a TOLERANT
//      line parser (`parse_exec_line`) that:
//        * accepts both the dotted (`thread.started`) and slashed
//          (`thread/started`) type spellings seen across versions,
//        * reads text from any of the field names different versions have used
//          (`text` / `delta` / `message`),
//        * IGNORES unknown event types and unknown fields rather than failing,
//        * never panics on malformed JSON — a bad line becomes `Unknown` and is
//          counted, not fatal.
//   3. `collect_exec_stream` — drains a full JSONL transcript into
//      `(assistant_text, usage, unknown_event_count)`, the graceful-degradation
//      entry point: if the schema drifts so far that NOTHING parses, the caller
//      gets empty text + the unknown count (a signal to surface "Codex format
//      changed") instead of a hard error or a crash.

/// A semver-ish Codex version. We keep the raw string (authoritative for
/// logging) plus the parsed major/minor/patch when extractable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexVersion {
    /// Raw `codex --version` line, trimmed (e.g. `"codex-cli 0.142.0-alpha.1"`).
    pub raw: String,
    pub major: Option<u32>,
    pub minor: Option<u32>,
    pub patch: Option<u32>,
}

/// Extract the first `MAJOR.MINOR.PATCH` triple from arbitrary version output.
/// Tolerant: `codex --version` has printed `codex-cli 0.142.0-alpha.1`,
/// `codex 0.125.0`, and bare `0.130.0` across builds — all yield (0, N, 0).
fn parse_semver_triple(raw: &str) -> (Option<u32>, Option<u32>, Option<u32>) {
    // Scan for the first run of `\d+\.\d+\.\d+`. No regex crate — hand-scan.
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        // Try to read up to three dot-separated numeric components from `i`.
        let mut nums: Vec<u32> = Vec::with_capacity(3);
        let mut j = i;
        loop {
            let start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            if start == j {
                break; // no digits — stop
            }
            // Parse this component (bounded length keeps it within u32).
            if let Ok(n) = raw[start..j].parse::<u32>() {
                nums.push(n);
            } else {
                break;
            }
            if nums.len() == 3 {
                break;
            }
            // Continue only if the next char is a dot followed by a digit.
            if j < bytes.len()
                && bytes[j] == b'.'
                && j + 1 < bytes.len()
                && bytes[j + 1].is_ascii_digit()
            {
                j += 1; // consume the dot
            } else {
                break;
            }
        }
        if nums.len() >= 2 {
            // Accept a 2- or 3-component version; missing patch ⇒ None.
            let major = nums.first().copied();
            let minor = nums.get(1).copied();
            let patch = nums.get(2).copied();
            return (major, minor, patch);
        }
        // This digit run didn't yield a version — advance past it.
        i = j.max(i + 1);
    }
    (None, None, None)
}

/// Resolve + run `codex --version` and parse the result. Logs the detected
/// version (or the failure) so a drift is visible in dev logs. Never spawns
/// cmd.exe (uses the resolved native binary + the node fallback's prefix args).
pub async fn codex_detect_version() -> Result<CodexVersion, String> {
    let cmd = resolve_codex()?;
    let mut command = Command::new(&cmd.program);
    for a in &cmd.prefix_args {
        command.arg(a);
    }
    command.arg("--version");
    apply_no_window(&mut command);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let output = command
        .output()
        .await
        .map_err(|e| format!("codex --version spawn failed: {e}"))?;

    // Some builds print the version to stderr; accept either stream.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let raw = {
        let s = stdout.trim();
        if s.is_empty() {
            stderr.trim()
        } else {
            s
        }
    }
    .to_string();

    if raw.is_empty() {
        return Err("codex --version produced no output".to_string());
    }

    let (major, minor, patch) = parse_semver_triple(&raw);
    let version = CodexVersion {
        raw: raw.clone(),
        major,
        minor,
        patch,
    };
    eprintln!(
        "[codex] detected version: {raw} (parsed {}.{}.{})",
        major.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
        minor.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
        patch.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
    );
    Ok(version)
}

/// Tauri command wrapper — surfaces the detected Codex version to the UI
/// (Connections card) so a user / log can correlate a behavior change with a
/// Codex upgrade. Returns the parsed [`CodexVersion`].
#[tauri::command]
pub async fn codex_version() -> Result<CodexVersion, String> {
    codex_detect_version().await
}

/// A NORMALIZED Codex exec event — the stable shape Shugu consumes regardless
/// of which raw JSONL spelling the installed Codex emits. Unknown events map to
/// [`CodexExecEvent::Unknown`] (carrying the raw `type` for logging) so the
/// caller can degrade gracefully instead of erroring.
#[derive(Debug, Clone, PartialEq)]
pub enum CodexExecEvent {
    /// A new thread started (`thread.started` / `thread/started`).
    ThreadStarted { thread_id: Option<String> },
    /// A turn started.
    TurnStarted,
    /// Streaming text delta from the assistant (any of `delta`/`text`).
    AgentMessageDelta { text: String },
    /// A completed assistant message item (`item.completed` with an
    /// `agent_message` item) — carries the full text.
    AgentMessage { text: String },
    /// Streaming reasoning delta (reasoning/thinking trace).
    ReasoningDelta { text: String },
    /// Turn completed, with optional usage.
    TurnCompleted { usage: Option<CodexUsage> },
    /// Turn or run failed with a message.
    Failed { message: String },
    /// A recognizably-shaped but unhandled event. `kind` is the raw `type`.
    Unknown { kind: String },
}

/// Normalize an event-type string across version spellings:
///   * lower-case,
///   * treat `/` and `.` as the same separator (`thread.started` ==
///     `thread/started`),
///   * drop `_` so `agent_message` and `agentmessage` collapse together
///     (different Codex builds have used both).
/// Example: `item/agent_message/delta` → `item.agentmessage.delta`.
fn canonical_event_type(t: &str) -> String {
    t.trim()
        .to_ascii_lowercase()
        .replace('/', ".")
        .replace('_', "")
}

/// First non-empty string among the given JSON field names on `v`. Lets one
/// parser accept the text under whichever key the installed version uses.
fn first_str_field<'a>(v: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = v.get(*k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

/// TOLERANT single-line parser. Returns `None` ONLY for blank lines or lines
/// that are not JSON objects at all (those are skipped silently — `codex exec`
/// occasionally interleaves non-JSON banner lines). A JSON object with an
/// unrecognized `type` yields `Some(Unknown { .. })` so it can be counted.
///
/// Robustness contract (AM-4): this function NEVER panics and NEVER returns an
/// `Err` — schema drift can only ever produce `Unknown`, and missing fields
/// default to empty/`None`. That is what keeps a Codex format change from
/// crashing Shugu.
pub fn parse_exec_line(line: &str) -> Option<CodexExecEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Non-JSON or non-object line ⇒ skip (banner / progress text).
    let v: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if !v.is_object() {
        return None;
    }

    let raw_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let kind = canonical_event_type(raw_type);

    let event = match kind.as_str() {
        "thread.started" => CodexExecEvent::ThreadStarted {
            // Field has been `thread_id` and `threadId` across versions.
            thread_id: first_str_field(&v, &["thread_id", "threadId"]).map(String::from),
        },
        "turn.started" => CodexExecEvent::TurnStarted,
        // Streaming text delta. Across versions the raw type has been
        // `item.delta`, `item/agent_message/delta`, `agent_message.delta`, … —
        // all canonicalize (lower-case, `/`→`.`, `_` dropped) to a string
        // ending in `agentmessage.delta`, plus the bare `item.delta`. We read
        // the text from whichever key the version uses.
        t if t.ends_with("agentmessage.delta") || t == "item.delta" => {
            let text = first_str_field(&v, &["delta", "text", "message"])
                .unwrap_or("")
                .to_string();
            CodexExecEvent::AgentMessageDelta { text }
        }
        // Reasoning/thinking delta.
        t if t.contains("reasoning") && t.contains("delta") => {
            let text = first_str_field(&v, &["delta", "text"])
                .unwrap_or("")
                .to_string();
            CodexExecEvent::ReasoningDelta { text }
        }
        // Completed item — only the `agent_message` item type carries the
        // assistant's final text we want; other item types (command runs, file
        // edits) are ignored here (this surface is chat, read-only).
        "item.completed" => {
            let item = v.get("item").cloned().unwrap_or(serde_json::Value::Null);
            let item_type = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if item_type == "agent_message" || item_type == "agentMessage" {
                let text = first_str_field(&item, &["text", "message", "content"])
                    .unwrap_or("")
                    .to_string();
                CodexExecEvent::AgentMessage { text }
            } else {
                CodexExecEvent::Unknown {
                    kind: format!("item.completed:{item_type}"),
                }
            }
        }
        "turn.completed" => {
            // Usage has lived under `usage` at the top level (exec JSONL).
            let usage = v.get("usage").and_then(parse_turn_usage);
            CodexExecEvent::TurnCompleted { usage }
        }
        "turn.failed" | "error" => {
            let message = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .or_else(|| v.get("message").and_then(|m| m.as_str()))
                .unwrap_or("codex exec failed")
                .to_string();
            CodexExecEvent::Failed { message }
        }
        _ => CodexExecEvent::Unknown {
            kind: if raw_type.is_empty() {
                "<no-type>".to_string()
            } else {
                raw_type.to_string()
            },
        },
    };
    Some(event)
}

/// Result of draining a full `codex exec --json` transcript.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexExecOutcome {
    /// Accumulated assistant text (deltas concatenated; a terminal
    /// `agent_message` item REPLACES the accumulator if it's non-empty and we
    /// hadn't streamed deltas — older versions emit only the completed item).
    pub text: String,
    pub usage: Option<CodexUsage>,
    /// Error message if the run reported a failure.
    pub failure: Option<String>,
    /// How many lines mapped to `Unknown` — a non-zero count after a Codex
    /// upgrade is the early-warning signal of schema drift.
    pub unknown_events: usize,
}

/// Drain a complete JSONL transcript (e.g. the full stdout of `codex exec
/// --json`) into a normalized [`CodexExecOutcome`]. This is the graceful
/// degradation entry point: a transcript that no longer parses at all yields an
/// empty-text outcome with `unknown_events > 0` instead of an error/panic.
pub fn collect_exec_stream(stdout: &str) -> CodexExecOutcome {
    let mut out = CodexExecOutcome::default();
    let mut streamed_any_delta = false;
    for line in stdout.lines() {
        let Some(ev) = parse_exec_line(line) else {
            continue;
        };
        match ev {
            CodexExecEvent::AgentMessageDelta { text } => {
                if !text.is_empty() {
                    out.text.push_str(&text);
                    streamed_any_delta = true;
                }
            }
            CodexExecEvent::AgentMessage { text } => {
                // Older versions emit only the completed item (no deltas). If we
                // never streamed a delta, adopt the full item text; otherwise the
                // deltas already built the text and we avoid double-counting.
                if !streamed_any_delta && !text.is_empty() {
                    out.text = text;
                }
            }
            CodexExecEvent::TurnCompleted { usage } => {
                if usage.is_some() {
                    out.usage = usage;
                }
            }
            CodexExecEvent::Failed { message } => {
                out.failure = Some(message);
            }
            CodexExecEvent::Unknown { .. } => {
                out.unknown_events += 1;
            }
            // ThreadStarted / TurnStarted / ReasoningDelta carry no visible
            // chat text for this outcome.
            _ => {}
        }
    }
    out
}

/// Outcome of a `codex exec --json` schema-drift probe, surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexExecProbe {
    /// Detected Codex version (raw + parsed), if `--version` succeeded.
    pub version: Option<CodexVersion>,
    /// Whether the exec stream produced any recognized assistant text.
    pub produced_text: bool,
    /// Number of JSONL lines that mapped to `Unknown` — the drift signal.
    pub unknown_events: usize,
    /// True when the transcript yielded zero recognized events of ANY kind
    /// (text, usage, failure) — i.e. the schema drifted beyond recognition.
    pub schema_unrecognized: bool,
    /// A failure message reported by the run, if any.
    pub failure: Option<String>,
    /// Human-readable verdict for the Connections/Diagnostics card.
    pub verdict: String,
}

/// Run a minimal, READ-ONLY `codex exec --json` turn and report whether Shugu's
/// tolerant parser still recognizes the event schema (AM-4 health check). This
/// is the real production consumer of `collect_exec_stream` + the version
/// detector: it lets the UI warn "Codex updated and changed its output format"
/// BEFORE that drift silently degrades the chat surface.
///
/// `prompt` defaults to a tiny deterministic ask when empty. The run is bounded
/// (2-min backstop) and sandboxed read-only via `codex exec` flags so it can
/// never mutate files. Never spawns cmd.exe (resolved native binary + node
/// fallback prefix args), and honors the dedicated/shared CODEX_HOME.
#[tauri::command]
pub async fn codex_exec_probe(
    app: AppHandle,
    prompt: Option<String>,
    model: Option<String>,
) -> Result<CodexExecProbe, String> {
    // Best-effort version detection — a failure here is not fatal to the probe
    // (we still try the exec run), it just leaves `version: None`.
    let version = codex_detect_version().await.ok();

    let cmd = resolve_codex()?;
    let ask = prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Reply with the single word: ok");

    let mut command = Command::new(&cmd.program);
    for a in &cmd.prefix_args {
        command.arg(a);
    }
    // `exec --json` headless stream; read-only sandbox + never-approve so the
    // probe can neither edit files nor block on an approval prompt.
    command
        .arg("exec")
        .arg("--json")
        .arg("--sandbox")
        .arg("read-only");
    if let Some(model) = model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        command.arg("--model").arg(model);
    }
    command.arg(ask);
    apply_codex_home(&app, &mut command);
    apply_no_window(&mut command);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let child = command
        .spawn()
        .map_err(|e| format!("codex exec spawn failed: {e}"))?;

    // Bound the whole run so a hung Codex can't wedge the probe.
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "codex exec probe timed out (120 s)".to_string())?
    .map_err(|e| format!("codex exec wait failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let outcome = collect_exec_stream(&stdout);

    // "Recognized SOMETHING" = produced text, usage, or a structured failure.
    // If none of those AND there were unknown lines, the schema drifted past
    // recognition. If there were no lines at all, the binary errored upstream
    // (surface stderr in the verdict).
    let recognized_any =
        !outcome.text.is_empty() || outcome.usage.is_some() || outcome.failure.is_some();
    let schema_unrecognized = !recognized_any && outcome.unknown_events > 0;

    let verdict = if schema_unrecognized {
        format!(
            "Codex output schema NOT recognized ({} unknown event(s)). Shugu's parser likely \
             needs an update for this Codex version.",
            outcome.unknown_events
        )
    } else if let Some(f) = &outcome.failure {
        format!("Codex reported a failure: {f}")
    } else if recognized_any {
        if outcome.unknown_events > 0 {
            format!(
                "Schema OK (parsed text/usage), but {} unrecognized event(s) seen — minor drift, \
                 degraded gracefully.",
                outcome.unknown_events
            )
        } else {
            "Schema OK — all events recognized.".to_string()
        }
    } else {
        let err = String::from_utf8_lossy(&output.stderr);
        let excerpt: String = err.trim().chars().take(300).collect();
        format!("No Codex events parsed. stderr: {excerpt}")
    };

    Ok(CodexExecProbe {
        version,
        produced_text: !outcome.text.is_empty(),
        unknown_events: outcome.unknown_events,
        schema_unrecognized,
        failure: outcome.failure,
        verdict,
    })
}

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
            Ok(None) => break, // connection dropped
            Err(_) => break,   // overall timeout
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
    let Ok(conn_mutex) = get_conn(app) else {
        return;
    };
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
    let Ok(conn_mutex) = get_conn(app) else {
        return;
    };
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
    let kind = if device_auth {
        "chatgptDeviceCode"
    } else {
        "chatgpt"
    };
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

#[cfg(test)]
mod version_isolation_tests {
    use super::{
        canonical_event_type, collect_exec_stream, is_windowsapps_package_path, parse_exec_line,
        parse_semver_triple, CodexExecEvent,
    };

    #[test]
    fn semver_triple_parses_the_known_codex_spellings() {
        assert_eq!(
            parse_semver_triple("codex-cli 0.142.0-alpha.1"),
            (Some(0), Some(142), Some(0))
        );
        assert_eq!(
            parse_semver_triple("codex 0.125.0"),
            (Some(0), Some(125), Some(0))
        );
        assert_eq!(
            parse_semver_triple("0.130.0"),
            (Some(0), Some(130), Some(0))
        );
        assert_eq!(parse_semver_triple("1.2.3"), (Some(1), Some(2), Some(3)));
        // Two-component version ⇒ patch is None, still usable.
        assert_eq!(parse_semver_triple("v2.5 build"), (Some(2), Some(5), None));
        // No version present ⇒ all None (never panics).
        assert_eq!(parse_semver_triple("no numbers here"), (None, None, None));
        assert_eq!(parse_semver_triple(""), (None, None, None));
    }

    #[test]
    fn windowsapps_payload_is_not_treated_as_a_spawnable_cli() {
        assert!(is_windowsapps_package_path(std::path::Path::new(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1.0.0_x64\app\resources\codex.exe"
        )));
        assert!(is_windowsapps_package_path(std::path::Path::new(
            "C:/Program Files/WindowsApps/OpenAI.Codex_1.0.0_x64/app/resources/codex.exe"
        )));
        assert!(!is_windowsapps_package_path(std::path::Path::new(
            r"C:\Users\me\AppData\Roaming\npm\node_modules\@openai\codex\vendor\codex.exe"
        )));
    }

    #[test]
    fn event_type_canonicalization_unifies_separators_and_case() {
        assert_eq!(canonical_event_type("thread.started"), "thread.started");
        assert_eq!(canonical_event_type("thread/started"), "thread.started");
        assert_eq!(canonical_event_type("Turn/Completed"), "turn.completed");
    }

    #[test]
    fn parse_line_handles_the_0_125_documented_shape() {
        // Exactly the JSONL captured in the module header for v0.125.0.
        assert_eq!(
            parse_exec_line(r#"{"type":"thread.started","thread_id":"t1"}"#),
            Some(CodexExecEvent::ThreadStarted {
                thread_id: Some("t1".into())
            })
        );
        assert_eq!(
            parse_exec_line(r#"{"type":"turn.started"}"#),
            Some(CodexExecEvent::TurnStarted)
        );
        assert_eq!(
            parse_exec_line(
                r#"{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hi there"}}"#
            ),
            Some(CodexExecEvent::AgentMessage {
                text: "hi there".into()
            })
        );
        match parse_exec_line(
            r#"{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}"#,
        ) {
            Some(CodexExecEvent::TurnCompleted { usage: Some(u) }) => {
                assert_eq!(u.input_tokens, 10);
                assert_eq!(u.output_tokens, 5);
            }
            other => panic!("expected TurnCompleted with usage, got {other:?}"),
        }
    }

    #[test]
    fn parse_line_tolerates_slashed_types_and_alternate_text_keys() {
        // Slashed type spelling (a plausible drift) + `delta` text key.
        assert_eq!(
            parse_exec_line(r#"{"type":"item/agent_message/delta","delta":"chunk"}"#),
            Some(CodexExecEvent::AgentMessageDelta {
                text: "chunk".into()
            })
        );
        // camelCase thread id field.
        assert_eq!(
            parse_exec_line(r#"{"type":"thread.started","threadId":"t2"}"#),
            Some(CodexExecEvent::ThreadStarted {
                thread_id: Some("t2".into())
            })
        );
        // Reasoning delta variant.
        assert_eq!(
            parse_exec_line(r#"{"type":"item.reasoning.delta","text":"thinking"}"#),
            Some(CodexExecEvent::ReasoningDelta {
                text: "thinking".into()
            })
        );
    }

    #[test]
    fn parse_line_degrades_unknown_and_malformed_without_panicking() {
        // Unknown event type ⇒ Unknown (carries the raw type), never an error.
        assert_eq!(
            parse_exec_line(r#"{"type":"brand.new.event.v2","payload":{"x":1}}"#),
            Some(CodexExecEvent::Unknown {
                kind: "brand.new.event.v2".into()
            })
        );
        // Unknown completed-item subtype ⇒ Unknown, not a crash.
        assert_eq!(
            parse_exec_line(
                r#"{"type":"item.completed","item":{"type":"command_execution","cmd":"ls"}}"#
            ),
            Some(CodexExecEvent::Unknown {
                kind: "item.completed:command_execution".into()
            })
        );
        // Missing `type` ⇒ Unknown<no-type>.
        assert_eq!(
            parse_exec_line(r#"{"foo":"bar"}"#),
            Some(CodexExecEvent::Unknown {
                kind: "<no-type>".into()
            })
        );
        // Non-JSON banner line ⇒ skipped (None), never panics.
        assert_eq!(parse_exec_line("Codex CLI starting…"), None);
        assert_eq!(parse_exec_line(""), None);
        assert_eq!(parse_exec_line("   "), None);
        // Truncated/garbage JSON ⇒ skipped, never panics.
        assert_eq!(parse_exec_line(r#"{"type":"turn.started""#), None);
        // A JSON array (not an object) ⇒ skipped.
        assert_eq!(parse_exec_line(r#"[1,2,3]"#), None);
    }

    #[test]
    fn collect_stream_assembles_deltas_usage_and_counts_drift() {
        let transcript = concat!(
            r#"{"type":"thread.started","thread_id":"t1"}"#,
            "\n",
            r#"{"type":"turn.started"}"#,
            "\n",
            r#"{"type":"item/agent_message/delta","delta":"Hello"}"#,
            "\n",
            r#"{"type":"item/agent_message/delta","delta":", world"}"#,
            "\n",
            r#"{"type":"some.future.event"}"#,
            "\n",
            r#"{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":7}}"#,
            "\n",
        );
        let outcome = collect_exec_stream(transcript);
        assert_eq!(outcome.text, "Hello, world");
        assert_eq!(outcome.failure, None);
        assert_eq!(
            outcome.unknown_events, 1,
            "the future event should be counted as drift"
        );
        let usage = outcome.usage.expect("usage should be parsed");
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 7);
    }

    #[test]
    fn collect_stream_adopts_completed_item_when_no_deltas() {
        // Older-version shape: only the completed item, no streaming deltas.
        let transcript = concat!(
            r#"{"type":"thread.started","thread_id":"t1"}"#,
            "\n",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"full answer"}}"#,
            "\n",
            r#"{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}"#,
            "\n",
        );
        let outcome = collect_exec_stream(transcript);
        assert_eq!(outcome.text, "full answer");
        assert_eq!(outcome.unknown_events, 0);
    }

    #[test]
    fn collect_stream_total_drift_degrades_to_empty_not_panic() {
        // Simulate a schema so changed that NOTHING is recognized: graceful
        // degradation = empty text + unknown_events count, no error/panic.
        let transcript = concat!(
            r#"{"type":"v9.alpha.thing","a":1}"#,
            "\n",
            r#"{"type":"v9.alpha.other","b":2}"#,
            "\n",
        );
        let outcome = collect_exec_stream(transcript);
        assert_eq!(outcome.text, "");
        assert_eq!(outcome.failure, None);
        assert_eq!(outcome.unknown_events, 2);
    }

    #[test]
    fn collect_stream_surfaces_failure_message() {
        let transcript = r#"{"type":"turn.failed","error":{"message":"upstream exploded"}}"#;
        let outcome = collect_exec_stream(transcript);
        assert_eq!(outcome.failure.as_deref(), Some("upstream exploded"));
    }
}
