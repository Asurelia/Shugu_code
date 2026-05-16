// Shugu Forge — local llama-server lifecycle controller.
//
// Spawns / kills the user's `llama-server` binary with the correct flags for
// the chat backend to talk to (port 8080, OpenAI-compat protocol, optimal
// SWA cache + Gemma chat template overrides). Driven by buttons on the
// llama.cpp connection card.
//
// Design choices:
//
// * We use `tauri_plugin_shell::ShellExt` (NOT `std::process::Command`)
//   because its `.spawn()` gives us an async event stream we can listen to
//   for terminate / stderr surface, plus a `CommandChild` handle with a
//   clean `.kill()`. Note: dropping a CommandChild does NOT kill the child
//   — we MUST call `.kill()` explicitly. The app's RunEvent::Exit hook in
//   `lib.rs` takes care of this on shutdown; abnormal exits (panic,
//   process-kill) still leak the child and the probe-fallback in
//   `llama_status` is what surfaces leftover servers on next launch.
//
// * The Tauri shell plugin permissions in the capabilities file gate
//   webview-initiated spawns. We call from Rust directly, so no scope is
//   needed here — the permissions only matter if the frontend were to
//   `invoke` the shell plugin's `spawn` command.
//
// * Binary resolution priority:
//     1. Explicit `binary` parameter (the user's "Binary path" override)
//     2. PATH lookup via the `which` crate (covers winget install / scoop)
//     3. Hard-coded fallback to the Docker Desktop inference binary
//        ($USERPROFILE\.docker\bin\inference\llama-server.exe). The user
//        has told us not to USE Docker as a stack, but the binary itself
//        is harmless if it's the only thing available — better than
//        failing.
//
// * Restart semantics: `llama_start` always kills any previous child
//   before spawning a new one. The user can change the model in the UI
//   and just hit Start again; the contract is "Start makes the requested
//   model be the one currently running, full stop".

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use which::which;

/// Tauri-managed app state for the single llama-server child we keep alive.
/// `Mutex<Option<_>>` because at any moment we either have a running child
/// or we don't; concurrent commands serialize on the mutex.
#[derive(Default)]
pub struct LlamaServerState(pub Mutex<Option<CommandChild>>);

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LlamaStatus {
    /// True iff a child is currently running and hasn't exited yet.
    pub running: bool,
    /// OS process id when running, None otherwise.
    pub pid: Option<u32>,
    /// Resolved binary path Tauri actually spawned. Useful for the UI to
    /// confirm "yes, we found the binary, here is where" — purely advisory.
    pub binary: Option<String>,
}

fn resolve_binary(user_path: Option<&str>) -> Result<PathBuf, String> {
    // 1) explicit override from the UI
    if let Some(p) = user_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let pb = PathBuf::from(trimmed);
            if pb.is_file() {
                return Ok(pb);
            }
            return Err(format!("binary path does not exist: {}", trimmed));
        }
    }

    // 2) PATH lookup (winget, scoop, manual install in PATH)
    if let Ok(p) = which("llama-server") {
        return Ok(p);
    }

    // 3) Docker Desktop fallback (the binary itself is fine to invoke
    //    directly even if the user doesn't want a Docker-based workflow)
    if let Ok(home) = std::env::var("USERPROFILE") {
        let candidate = PathBuf::from(home)
            .join(".docker")
            .join("bin")
            .join("inference")
            .join("llama-server.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err(
        "llama-server not found on PATH. Install via `winget install --id ggml.llamacpp` \
         or specify the absolute path in the 'Binary' field."
            .into(),
    )
}

/// Spawn (or restart) llama-server with the recommended flags.
///
/// Idempotent on restart: if a child is already running it is killed first,
/// then we spawn fresh with whatever model the user passed in. This is the
/// "I want llama-server to be running THIS model" contract.
#[tauri::command]
pub async fn llama_start(
    app: tauri::AppHandle,
    state: State<'_, LlamaServerState>,
    binary: Option<String>,
    hf_model: String,
    ctx: Option<u32>,
    port: Option<u16>,
) -> Result<LlamaStatus, String> {
    // Drop any existing child first. We do this BEFORE resolving the new
    // binary so a bad new path doesn't leave us with a dangling running
    // process and no UI confirmation.
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }

    let bin = resolve_binary(binary.as_deref())?;
    let port = port.unwrap_or(8080);
    // Default context size — big enough for real multi-turn conversations
    // (4096 was painfully small and triggered HTTP 400 "exceeds the
    // available context size" after just a few exchanges). 32k is
    // comfortable for Gemma 4 E4B Q5_K_P on a ~16 GB GPU and far below
    // the model's trained 131072 ceiling, so there's still room to push
    // higher if the user wants — `ctx` is overridable via the command
    // arg (future "Context" field on the card).
    let ctx = ctx.unwrap_or(32768);

    let trimmed_model = hf_model.trim();
    if trimmed_model.is_empty() {
        return Err("hfModel is required (e.g. 'HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q5_K_P')".into());
    }

    let bin_display = bin.to_string_lossy().into_owned();

    // tauri_plugin_shell::Command — sidecar-style API but for an external
    // binary specified by absolute path.
    //
    // Flags policy: we deliberately keep the command line MINIMAL. Adding
    // `--swa-full` and `--chat-template gemma` looked attractive on paper
    // (they silence two warnings) but break Gemma 4 in practice — the
    // built-in `gemma` template in llama.cpp is for Gemma 1/2/3 and the
    // model loses its prompt boundaries, producing hallucinations and
    // infinite-token loops. Better to leave the GGUF's embedded template
    // alone (warning notwithstanding) and let the user opt into extra
    // flags via a future "Advanced" field if needed.
    let (mut rx, child) = app
        .shell()
        .command(&bin_display)
        .args([
            "-hf",
            trimmed_model,
            "-c",
            &ctx.to_string(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .spawn()
        .map_err(|e| format!("failed to spawn llama-server: {e}"))?;

    let pid = child.pid();
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    // Drain the receiver in the background so the OS pipe buffers don't fill
    // up (which would deadlock llama-server on its own stdout/stderr writes).
    // We don't surface the lines to the UI for now — the user has llama-server
    // logs in their own terminal anyway. A future enhancement could emit
    // Tauri events here for a "server console" panel.
    tauri::async_runtime::spawn(async move {
        while let Some(_event) = rx.recv().await {
            // Intentionally drop. The receiver MUST be polled or the spawn
            // pipe becomes a slow-write hazard for the child process.
        }
    });

    Ok(LlamaStatus {
        running: true,
        pid: Some(pid),
        binary: Some(bin_display),
    })
}

/// Kill the running llama-server child. Idempotent — returns ok even if
/// nothing was running.
#[tauri::command]
pub fn llama_stop(state: State<'_, LlamaServerState>) -> Result<LlamaStatus, String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    Ok(LlamaStatus { running: false, pid: None, binary: None })
}

/// Hard-kill ALL `llama-server.exe` processes on the system (Windows-only).
/// Surfaces in the UI as the "Force stop external" button — used when
/// `llama_status` reports `running:true` with `pid:None`, meaning the HTTP
/// probe found a server we don't own (orphan from a prior session whose
/// cleanup hook didn't fire, or another tool's instance). Bluntly kills by
/// image name; the trade-off is "may also kill an unrelated llama-server
/// the user wanted alive" — acceptable for the one-button UX vs the
/// alternative of parsing `netstat -ano` for the port-8080 PID.
#[tauri::command]
pub async fn llama_force_stop_external(app: tauri::AppHandle) -> Result<LlamaStatus, String> {
    #[cfg(target_os = "windows")]
    {
        // Use the shell plugin so we go through the same Tauri process
        // tracking infrastructure as llama_start. Async output to keep the
        // UI responsive even if taskkill takes a moment.
        let output = app
            .shell()
            .command("taskkill")
            .args(["/F", "/IM", "llama-server.exe"])
            .output()
            .await
            .map_err(|e| format!("taskkill spawn failed: {e}"))?;
        // taskkill exits 128 ("process not found") when nothing matched —
        // that's a SUCCESS from our point of view ("ensure none running").
        if !output.status.success() && !matches!(output.status.code(), Some(128)) {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("taskkill failed: {}", stderr.trim()));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app
            .shell()
            .command("pkill")
            .args(["-f", "llama-server"])
            .output()
            .await;
    }
    // Give the OS a beat to release the port, then re-probe so the UI
    // reflects reality immediately instead of waiting for the next 2s poll.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let still_running = probe_llama_endpoint().await;
    Ok(LlamaStatus { running: still_running, pid: None, binary: None })
}

/// Snapshot current llama-server status. Two-tier detection:
///
///   1. Owned child handle — if the app spawned llama-server itself, the
///      CommandChild is in `state.0`. This is the fast path (no IO).
///   2. HTTP probe on 127.0.0.1:8080/v1/models — when there's no owned
///      handle, the server may still be running EXTERNALLY: started from a
///      terminal, left over from a previous app session whose state we lost
///      on relaunch, or spawned by another tool. The previous one-tier
///      implementation would report `stopped` in those cases even though
///      chat requests against the same endpoint were succeeding, which is
///      exactly what just confused a user staring at "Server stopped" while
///      the chibi happily replied.
///
/// When we detect a detached server (HTTP probe ok, no owned child) we
/// return `running: true` with `pid: None` — the UI uses the missing pid
/// as a signal to hide the Stop button (we can't kill what we don't own)
/// and to grey out Restart.
///
/// 250 ms timeout keeps the 2s UI polling responsive even when nothing
/// is on the port.
#[tauri::command]
pub async fn llama_status(state: State<'_, LlamaServerState>) -> Result<LlamaStatus, String> {
    // Scope the mutex lock so the guard is dropped BEFORE any await — std's
    // Mutex isn't Send-safe across await points and we don't need it held
    // while we do IO anyway.
    let owned_pid: Option<u32> = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.as_ref().map(|c| c.pid())
    };

    if let Some(pid) = owned_pid {
        return Ok(LlamaStatus { running: true, pid: Some(pid), binary: None });
    }

    let detached_running = probe_llama_endpoint().await;
    Ok(LlamaStatus { running: detached_running, pid: None, binary: None })
}

/// Best-effort GET against the standard llama-server endpoint. Returns true
/// iff the server responds with a 2xx within 250 ms. Any error (DNS,
/// connection refused, timeout, non-2xx) counts as "not running".
async fn probe_llama_endpoint() -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(250))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client.get("http://127.0.0.1:8080/v1/models").send().await {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}
