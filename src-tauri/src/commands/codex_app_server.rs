//! Codex **app-server** client — the native JSON-RPC 2.0 integration OpenAI
//! built to embed Codex (the same harness powering the VSCode/JetBrains/Xcode/
//! web/macOS clients). Replaces the crude `codex exec` one-shot: one persistent
//! `codex app-server` process speaks JSON-RPC over stdio (JSONL), giving us
//! native model selection, reasoning effort, REAL rate limits, login, and
//! streaming turns over a single connection.
//!
//! Protocol validated live against codex-cli 0.125.0 (see the
//! `reference-codex-app-server` memory + `codex app-server generate-json-schema`).
//! Methods used: `initialize` (+ `initialized` notif), `model/list`,
//! `account/rateLimits/read`, `getAuthStatus`, `thread/start`, `turn/start`,
//! `account/login/start`, `account/login/cancel`, `account/logout`. Streaming
//! notifications: `item/agentMessage/delta`, `item/reasoning/textDelta`,
//! `turn/completed`, `account/rateLimitsUpdated`, …
//!
//! Design: a lazily-spawned singleton connection. A reader task demultiplexes
//! stdout lines into (a) responses routed to the awaiting caller by JSON-RPC id,
//! and (b) notifications routed to per-thread subscribers (for streaming turns)
//! plus a few app-wide Tauri events (pushed rate-limits, login progress).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};

use crate::commands::codex::{apply_codex_home, resolve_codex_cmd, CodexCmd};

/// A live app-server connection. Cheap to clone via `Arc`.
pub struct AppServer {
    /// Serialized writes to the child's stdin (JSON-RPC requests/notifications).
    stdin: AsyncMutex<ChildStdin>,
    /// Monotonic JSON-RPC request id.
    next_id: AtomicI64,
    /// In-flight requests awaiting a response, keyed by id.
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    /// Per-thread notification subscribers (a streaming turn registers one for
    /// the duration of its turn so it receives item/turn deltas live).
    subscribers: Mutex<HashMap<String, mpsc::UnboundedSender<Value>>>,
    /// In-flight logins awaiting their `account/login/completed` notification,
    /// keyed by loginId. Resolved Ok(()) on success, Err(msg) on failure.
    login_waiters: Mutex<HashMap<String, oneshot::Sender<Result<(), String>>>>,
    /// Kept so the child isn't reaped while the conn lives; also lets us kill it.
    _child: Mutex<Child>,
}

impl AppServer {
    /// Send a request and await its response (30s timeout).
    pub async fn request(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut p = self.pending.lock().map_err(|_| "pending poisoned")?;
            p.insert(id, tx);
        }
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_line(&msg).await?;
        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(format!("codex app-server: réponse annulée ({method})")),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(format!("codex app-server: délai dépassé ({method})"))
            }
        }
    }

    /// Send a notification (no id, no response expected).
    pub async fn notify(self: &Arc<Self>, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.write_line(&msg).await
    }

    async fn write_line(self: &Arc<Self>, msg: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        line.push('\n');
        let mut w = self.stdin.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("codex app-server write: {e}"))?;
        w.flush().await.map_err(|e| format!("codex app-server flush: {e}"))
    }

    /// Register a per-thread notification subscriber; returns the receiver. The
    /// caller drops it (or it's overwritten) when the turn ends.
    pub fn subscribe(self: &Arc<Self>, thread_id: &str) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut s) = self.subscribers.lock() {
            s.insert(thread_id.to_string(), tx);
        }
        rx
    }

    pub fn unsubscribe(self: &Arc<Self>, thread_id: &str) {
        if let Ok(mut s) = self.subscribers.lock() {
            s.remove(thread_id);
        }
    }

    /// Register a waiter for a login's `account/login/completed` notification.
    /// The returned receiver resolves Ok(()) on success, Err(msg) on failure.
    pub fn await_login(self: &Arc<Self>, login_id: &str) -> oneshot::Receiver<Result<(), String>> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut w) = self.login_waiters.lock() {
            w.insert(login_id.to_string(), tx);
        }
        rx
    }

    pub fn cancel_login_wait(self: &Arc<Self>, login_id: &str) {
        if let Ok(mut w) = self.login_waiters.lock() {
            w.remove(login_id);
        }
    }
}

// ── Singleton management ────────────────────────────────────────────────

/// Guards the single shared connection. `None` until first use or after a drop.
static CONN: OnceLock<AsyncMutex<Option<Arc<AppServer>>>> = OnceLock::new();

fn conn_slot() -> &'static AsyncMutex<Option<Arc<AppServer>>> {
    CONN.get_or_init(|| AsyncMutex::new(None))
}

/// Get the live connection, spawning + initializing it on first use. If the
/// previous connection died (child exited), the next call respawns.
pub async fn ensure(app: &AppHandle) -> Result<Arc<AppServer>, String> {
    let mut slot = conn_slot().lock().await;

    // Reuse a healthy connection.
    if let Some(existing) = slot.as_ref() {
        let alive = {
            let mut c = existing._child.lock().map_err(|_| "child poisoned")?;
            matches!(c.try_wait(), Ok(None)) // None = still running
        };
        if alive {
            return Ok(existing.clone());
        }
    }

    // Spawn a fresh `codex app-server`.
    let bin: CodexCmd = resolve_codex_cmd()?;
    let mut cmd = Command::new(&bin.program);
    cmd.args(&bin.prefix_args);
    cmd.arg("app-server");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    crate::commands::codex::apply_no_window_pub(&mut cmd);
    apply_codex_home(app, &mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("spawn codex app-server: {e}"))?;
    let stdin = child.stdin.take().ok_or("codex app-server: no stdin")?;
    let stdout = child.stdout.take().ok_or("codex app-server: no stdout")?;
    let stderr = child.stderr.take().ok_or("codex app-server: no stderr")?;

    let server = Arc::new(AppServer {
        stdin: AsyncMutex::new(stdin),
        next_id: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        subscribers: Mutex::new(HashMap::new()),
        login_waiters: Mutex::new(HashMap::new()),
        _child: Mutex::new(child),
    });

    // Reader task: demultiplex responses vs notifications.
    {
        let server2 = server.clone();
        let app2 = app.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim();
                if !line.starts_with('{') {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                // Response (has an id matching a pending request).
                if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                    let waiter = server2.pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(tx) = waiter {
                        let payload = if let Some(err) = v.get("error") {
                            Err(err
                                .get("message")
                                .and_then(|m| m.as_str())
                                .unwrap_or("codex app-server error")
                                .to_string())
                        } else {
                            Ok(v.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(payload);
                        continue;
                    }
                    // An id with no waiter = a server→client REQUEST (approvals).
                    // v1: not handled (chat uses read-only; approvals would just
                    // time out server-side). Logged for diagnostics.
                    continue;
                }
                // Notification (has a method, no id).
                if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                    dispatch_notification(&server2, &app2, method, &v);
                }
            }
            // stdout closed → child gone; drop the connection so `ensure`
            // respawns next time.
            if let Some(slot) = CONN.get() {
                if let Ok(mut g) = slot.try_lock() {
                    *g = None;
                }
            }
            let _ = app2.emit("codex://disconnected", ());
        });
    }

    // Drain stderr (diagnostics only; keep the pipe from filling).
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(_l)) = lines.next_line().await {
            // Intentionally dropped — app-server stderr is noisy (skill loads).
        }
    });

    // Handshake: initialize → initialized.
    let init = server
        .request(
            "initialize",
            json!({
                "clientInfo": { "name": "shugu-forge", "title": "Shugu Forge", "version": "0.1.0" }
            }),
        )
        .await?;
    let _ = app.emit("codex://initialized", init);
    server.notify("initialized", json!({})).await?;

    *slot = Some(server.clone());
    Ok(server)
}

/// Route a notification to its per-thread subscriber and/or app-wide events.
fn dispatch_notification(server: &Arc<AppServer>, app: &AppHandle, method: &str, v: &Value) {
    // Thread-scoped streaming notifications carry a threadId — forward to that
    // turn's subscriber so the chat path receives deltas live.
    let thread_id = v
        .get("params")
        .and_then(|p| p.get("threadId"))
        .and_then(|t| t.as_str());
    if let Some(tid) = thread_id {
        if let Ok(subs) = server.subscribers.lock() {
            if let Some(tx) = subs.get(tid) {
                let _ = tx.send(v.clone());
            }
        }
    }

    // App-wide notifications worth surfacing regardless of a turn.
    match method {
        // Pushed quota update (real name has the slash — verified against the
        // ServerNotification schema; an earlier guess `account/rateLimitsUpdated`
        // was wrong and would silently never fire).
        "account/rateLimits/updated" => {
            if let Some(rl) = v.get("params").and_then(|p| p.get("rateLimits")) {
                let _ = app.emit("codex://rate-limits", rl.clone());
            }
        }
        // Login finished: wake the awaiting `codex_login` call by loginId AND
        // emit a structured completion event for the card.
        "account/login/completed" => {
            let p = v.get("params").cloned().unwrap_or(Value::Null);
            let login_id = p.get("loginId").and_then(|x| x.as_str()).unwrap_or("");
            let success = p.get("success").and_then(|x| x.as_bool()).unwrap_or(false);
            let err = p
                .get("error")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            if let Ok(mut w) = server.login_waiters.lock() {
                if let Some(tx) = w.remove(login_id) {
                    let _ = tx.send(if success {
                        Ok(())
                    } else {
                        Err(err.clone().unwrap_or_else(|| "login échoué".into()))
                    });
                }
            }
            let _ = app.emit(
                "codex://login",
                serde_json::json!({ "phase": "completed", "success": success, "error": err }),
            );
        }
        _ => {}
    }
}
