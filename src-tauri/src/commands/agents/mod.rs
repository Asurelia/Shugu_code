//! Multi-agent system foundation (Phase 0).
//!
//! This is the plumbing for Shugu's mascot → orchestrator → sub-agents
//! architecture. Phase 0 ships ONLY the scaffolding: spawning agents,
//! persisting their lifecycle events, broadcasting them via the Tauri
//! event bus, and surfacing them in the frontend's Agents panel. Real
//! LLM calls, tool execution, and sub-agent fan-out come in Phase 1+.
//!
//! ## Data model (V4 migration)
//!
//! Two tables live next to the existing `messages` / `conversations` :
//!
//!   * `agents`        — one row per agent. Status FSM:
//!                       pending → running → (complete | error | killed).
//!                       `parent_id` builds the agent tree.
//!   * `agent_events`  — append-only audit log of every state change.
//!                       Each row's `payload` is the serialized [`AgentEvent`]
//!                       JSON (camelCase, see serde annotations below).
//!
//! ## Event bus
//!
//! Every persisted event is ALSO broadcast on the Tauri channel
//! `"agent://lifecycle"`. The frontend keeps a single persistent listener
//! that demultiplexes by `agentId` into a Zustand store. Pattern mirrors
//! `chat://delta` in [`crate::commands::chat`].
//!
//! ## DB access pattern
//!
//! We open our own [`rusqlite::Connection`] in a module-level
//! [`OnceLock<Mutex<Connection>>`], same as [`crate::commands::vector`].
//! That bypasses tauri-plugin-sql's sqlx pool but writes to the SAME
//! `shugu.db` file — SQLite WAL mode serializes concurrent writers, so
//! the two connections coexist without contention at our scale.
//!
//! ## Concurrency cap
//!
//! Hard ceiling of 4 active agents at any time, enforced by the in-memory
//! `AgentManagerState` HashMap. Beyond that, `agent_spawn` returns an
//! error and the caller must wait. The 3-4 limit is the well-documented
//! sweet spot for multi-agent systems in 2026 — coordination overhead
//! beyond that eats the parallelism gains.
//!
//! ## Boot recovery
//!
//! If Shugu crashes mid-agent, the SQLite row stays in `running` state
//! but the in-memory handle is gone. On next boot, [`recover_orphans`]
//! runs once via the AppHandle setup hook and marks all such rows as
//! `error` with a "process restarted" message. Without this, the
//! frontend would render phantom running agents forever.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager, State};
use uuid::Uuid;

// Phase 1 runner submodule. Owns the real LLM call loop (synthetic emitter
// of Phase 0 lives no more — `run_agent_task` in runner.rs replaces it).
// Split out so this file stays under the CLAUDE.md 500-line ceiling.
mod runner;

// Phase 2 tools submodule. Defines the closed set of file-system tools the
// orchestrator can call (`fs_read_file`, `fs_write_file`, `fs_list_dir`),
// the JSON-schema renderers per provider dialect (OpenAI / Anthropic), and
// the `execute_tool` dispatcher that resolves a parsed ToolCall against
// the workspace root. The runner imports the public-to-this-module symbols
// (the `pub(super)` items) from here.
mod tools;

/// Continual Harness — harness evolution / Refiner (lot 1 P2) + UI commands.
pub(crate) mod harness;

/// Measurement bench (banc de mesure) — replays fixed tasks against PINNED
/// harness generations on COPIED fixtures, judges with non-executing verifiers,
/// records `bench_runs`, and A/B-compares generations. The legibility spine.
pub(crate) mod bench;

/// Sandboxed execution — runs agent-written code/tests inside a throwaway,
/// network-isolated Docker container (the "environment" that gives real
/// pass/fail feedback). Gated by `allow_exec`: bench copies only, never the
/// user's real project.
pub(crate) mod sandbox;

/// Skill library (Voyager / Hermes) — the agent saves reusable skills it learns
/// (`skill_save` tool) and loads them into context on future runs. Persistent,
/// per-role, compounding learning.
pub(crate) mod skills;

// Re-export the crate-visible items from `tools` so `chat.rs` can reach
// them via `crate::commands::agents::*` without poking into the private
// submodule path. The streaming helpers in `chat.rs` consume:
//   - `ToolCall` as the shape held in `AssistantTurn.tool_calls`
//   - `ToolCallAccumulator` for the OpenAI streaming-fragment assembly
//   - `tools_json_*` for injecting the `tools` body field on agent calls
pub(crate) use tools::{tools_json_anthropic, tools_json_openai, ToolCall, ToolCallAccumulator};

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

/// Max concurrent agents. Beyond 4 the coordination overhead dominates the
/// parallelism gain in every benchmark we found (Anthropic, AG-UI, CrewAI).
const MAX_CONCURRENT_AGENTS: usize = 4;

/// Roles we accept on the spawn path. Stored as TEXT in the DB so the set
/// stays soft-extensible (a Phase 2 contributor can add "reviewer" by
/// editing this slice without a migration).
const ALLOWED_ROLES: &[&str] = &[
    "mascot",
    "orchestrator",
    "coder",
    "researcher",
    "tester",
];

/// Tauri event channel name — single channel, every event carries its own
/// `agentId` so the frontend filters cheaply. Mirrors `chat://delta`.
const EVENT_CHANNEL: &str = "agent://lifecycle";

// ────────────────────────────────────────────────────────────────────────
// Managed state — in-memory tracker of running agents (concurrency cap)
// ────────────────────────────────────────────────────────────────────────

/// One entry per live agent. Holds the role for quick inspection AND
/// an abort signal (`tokio::sync::Notify`) so `agent_kill` can wake the
/// background task between SSE chunks. We chose `Notify` over
/// `tokio_util::sync::CancellationToken` to avoid pulling a new crate —
/// `tokio::sync::Notify` is already available via the existing
/// `tokio = { features = ["full"] }` dep.
pub struct AgentHandle {
    #[allow(dead_code)] // read by the runner / inspection helpers
    pub role: String,
    pub abort: Arc<tokio::sync::Notify>,
}

/// Tauri-managed state — the global in-flight registry. The Mutex is
/// short-held (insert/remove only); we never hold it across awaits.
#[derive(Default)]
pub struct AgentManagerState(pub Arc<Mutex<HashMap<String, AgentHandle>>>);

// ────────────────────────────────────────────────────────────────────────
// DB row shapes (frontend mirrors via TS interfaces in src/lib/agents.ts)
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub id: String,
    pub role: String,
    pub status: String,
    pub parent_id: Option<String>,
    pub model: String,
    pub task: String,
    pub conversation_id: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventRow {
    pub id: i64,
    pub agent_id: String,
    pub ts: i64,
    pub kind: String,
    /// Raw JSON payload — the frontend parses this back into the
    /// [`AgentEvent`] discriminated union for typed access.
    pub payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscript {
    pub agent: AgentRow,
    pub events: Vec<AgentEventRow>,
}

// ────────────────────────────────────────────────────────────────────────
// AgentEvent — the over-the-wire shape broadcast on EVENT_CHANNEL
// ────────────────────────────────────────────────────────────────────────

/// Discriminated union of every lifecycle event an agent can emit.
///
/// Serialization uses `tag = "kind"` with camelCase field names, so the
/// frontend receives e.g. `{"kind":"toolCall","agentId":"...","toolCallId":"...","tool":"...","args":{}}`.
/// Each event carries `agent_id` as its first identifying field so the
/// frontend can short-circuit and skip events that don't concern the
/// currently-displayed agent.
// Phase 0 only constructs Spawn / Message / Complete / Error from the
// synthetic emitter; the tool-related variants land in Phase 2 when the
// orchestrator gains real tool-use. Silence dead-code warning here rather
// than per-variant.
// PLAN V4 FIX (2026-05-17) — `rename_all = "camelCase"` au niveau enum
// renomme les VARIANTS (Spawn → spawn) mais PAS les fields à l'intérieur.
// Sans `rename_all_fields = "camelCase"`, les fields restent snake_case
// (agent_id, parent_id, …) → côté TS frontend, `event.agentId` était
// `undefined` → `.slice()` throw → callback silently failed pour tout
// kind != "delta" (et même pour delta si on accédait agentId).
//
// La combinaison `rename_all` + `rename_all_fields` à mettre sur l'enum
// renomme à la fois les variant names ET les fields à l'intérieur des
// variants. Verifié avec `serde 1.0.200+`.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    Spawn {
        agent_id: String,
        parent_id: Option<String>,
        role: String,
        task: String,
        model: String,
        conversation_id: Option<String>,
    },
    Message {
        agent_id: String,
        /// One of `"system"`, `"user"`, `"assistant"` — string-typed
        /// rather than enum so future custom roles (e.g. `"tool"`) don't
        /// require a serde rename dance.
        role: String,
        content: String,
    },
    ToolCall {
        agent_id: String,
        tool_call_id: String,
        tool: String,
        args: serde_json::Value,
    },
    ToolResult {
        agent_id: String,
        tool_call_id: String,
        result: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Delta {
        agent_id: String,
        chunk: String,
        /// `"content"` or `"reasoning"` — same split as chat-sync.
        delta_kind: String,
    },
    Complete {
        agent_id: String,
        output: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tokens_used: Option<u32>,
        /// The model's accumulated reasoning/thinking for the final turn, if any.
        /// Deltas are live-only (not persisted); this is the durable copy that
        /// rides on the terminal event so the UI can show it after a reload too.
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning: Option<String>,
        ms: u64,
    },
    Error {
        agent_id: String,
        error: String,
    },
    /// Continual Harness (P2) — the harness Refiner is running or has applied a
    /// new generation for this agent's role. Two-stage so the UI never looks
    /// hung during the 5-30s Refiner call: `status = "evolving"` when the call
    /// starts, `status = "applied"` (with generations + summary) on success.
    HarnessEvolved {
        agent_id: String,
        role: String,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        from_generation: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        to_generation: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
}

impl AgentEvent {
    /// Stable discriminator string used in the `agent_events.kind` column.
    /// Must match the `tag = "kind"` value serde emits on serialization.
    fn kind_str(&self) -> &'static str {
        match self {
            AgentEvent::Spawn { .. } => "spawn",
            AgentEvent::Message { .. } => "message",
            AgentEvent::ToolCall { .. } => "toolCall",
            AgentEvent::ToolResult { .. } => "toolResult",
            AgentEvent::Delta { .. } => "delta",
            AgentEvent::Complete { .. } => "complete",
            AgentEvent::Error { .. } => "error",
            AgentEvent::HarnessEvolved { .. } => "harnessEvolved",
        }
    }

    /// Agent id extractor — used to write the `agent_id` column without
    /// having to pattern-match every variant at the call site.
    fn agent_id(&self) -> &str {
        match self {
            AgentEvent::Spawn { agent_id, .. }
            | AgentEvent::Message { agent_id, .. }
            | AgentEvent::ToolCall { agent_id, .. }
            | AgentEvent::ToolResult { agent_id, .. }
            | AgentEvent::Delta { agent_id, .. }
            | AgentEvent::Complete { agent_id, .. }
            | AgentEvent::Error { agent_id, .. }
            | AgentEvent::HarnessEvolved { agent_id, .. } => agent_id,
        }
    }
}

// ────────────────────────────────────────────────────────────────────────
// Spawn arguments — separate struct so the Tauri command can take it as
// a single `args` object (cleaner JS call shape).
// ────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub role: String,
    pub task: String,
    pub model: String,
    pub parent_id: Option<String>,
    pub conversation_id: Option<String>,
    // Phase 1 — provider routing fields. Optional so Phase 0 callers
    // (the test button) still work without supplying them; the runner
    // falls back to env vars (anthropic) or empty key (openai/ollama/custom).
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub chat_template_kwargs: Option<serde_json::Value>,
    /// Phase A (Design Studio) — when set, appended to the agent's system
    /// prompt to drive design-system-styled project generation to disk.
    /// Only the Studio "Generate" passes it; chat delegation leaves it None
    /// (zero impact on the existing delegate path).
    pub design_context: Option<String>,
}

// ────────────────────────────────────────────────────────────────────────
// DB connection (rusqlite, separate from tauri-plugin-sql's sqlx pool)
// ────────────────────────────────────────────────────────────────────────

static AGENTS_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

/// Open (or return the cached) rusqlite Connection to `shugu.db`. Same
/// resolution as `vector.rs::get_conn` — `app_config_dir()/shugu.db` —
/// so both rusqlite users target the file that tauri-plugin-sql migrates.
///
/// The first call ALSO triggers `recover_orphans` which sweeps any
/// `running`/`pending` rows left behind by a previous crash. This MUST
/// run before any consumer reads `agent_list_active`, otherwise the UI
/// shows phantom agents from the previous process.
pub(super) fn get_conn(app: &tauri::AppHandle) -> Result<&'static Mutex<Connection>, String> {
    if let Some(c) = AGENTS_CONN.get() {
        return Ok(c);
    }

    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?
        .join("shugu.db");

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create app config dir: {e}"))?;
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("rusqlite open {}: {e}", db_path.display()))?;

    // WAL for concurrent access alongside vector.rs + the plugin's sqlx
    // connection. Idempotent — re-setting the same journal mode is a
    // no-op cost.
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("WAL pragma: {e}"))?;

    // Sweep orphans from a previous crash. Must happen BEFORE the conn is
    // cached so subsequent commands see consistent state.
    let now = now_ms();
    let swept = conn
        .execute(
            "UPDATE agents
                SET status = 'error',
                    error  = COALESCE(error, 'process restarted — agent orphaned'),
                    finished_at = COALESCE(finished_at, ?1)
              WHERE status IN ('pending', 'running')",
            params![now],
        )
        .map_err(|e| format!("recover orphans: {e}"))?;
    if swept > 0 {
        eprintln!("[agents] swept {swept} orphaned agent(s) from previous session");
    }

    // Purge legacy per-token Delta events. Pre-Phase-2-streaming-fix runs
    // used to persist one row per streamed token, which on the first real
    // agent run produced ~10k rows in `agent_events`. Loading those at
    // panel mount via `getAgentTranscript` froze the mascot window. After
    // the fix, Delta events are emit-only (see `persist_and_emit`), but
    // any legacy rows from older runs still need to be cleared once.
    // Idempotent — re-running this DELETE on a clean DB is a no-op.
    let purged = conn
        .execute("DELETE FROM agent_events WHERE kind = 'delta'", [])
        .map_err(|e| format!("purge legacy deltas: {e}"))?;
    if purged > 0 {
        eprintln!("[agents] purged {purged} legacy delta row(s) from agent_events");
    }

    let _ = AGENTS_CONN.set(Mutex::new(conn));
    AGENTS_CONN
        .get()
        .ok_or_else(|| "AGENTS_CONN OnceLock unexpectedly empty".to_string())
}

// ────────────────────────────────────────────────────────────────────────
// Small helpers
// ────────────────────────────────────────────────────────────────────────

pub(super) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_role_allowed(role: &str) -> bool {
    ALLOWED_ROLES.iter().any(|r| *r == role)
}

/// Persist an AgentEvent to `agent_events` AND broadcast it on the Tauri
/// event bus. Order matters: persist FIRST so consumers that react to the
/// event by querying the transcript (e.g. the dedup `maxEventId` cursor in
/// the frontend store) always see a consistent state.
///
/// EXCEPTION — Delta events (streaming token fragments) are NEVER persisted.
/// They're ephemeral by nature: what we durably need is the consolidated
/// `Message` event emitted at the end of each LLM turn (which IS persisted
/// in this function's normal path). Persisting per-token would mean ~30
/// SQLite INSERTs per second on a streaming response — the lock contention
/// alone choked the runtime AND made the UI unresponsive (transcript drawer
/// mapping 10k+ EventRow rows). For Delta we only emit on the bus; the
/// frontend store merges consecutive deltas into a single streaming buffer.
// Diag — compteur global d'emits delta, pour logger toutes les 50
// deltas + tous les non-deltas. Permet de confirmer côté Rust que app.emit
// est bien appelé. Couplé au frontend `diag("agent-events", ...)`, on
// peut comparer emit Rust ↔ receive JS dans un seul trace file.
// Désactivé en release pour zéro coût en prod.
static EMIT_DELTA_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub(super) fn persist_and_emit(app: &tauri::AppHandle, event: &AgentEvent) -> Result<(), String> {
    // Delta is ephemeral — bypass the SQLite write entirely. Anything that
    // reconstructs the transcript later (`getAgentTranscript`) reads from
    // `agent_events`, which never had per-token rows; it will see the
    // assistant Message events that the runner emits at each turn boundary,
    // and those carry the full assembled content.
    if matches!(event, AgentEvent::Delta { .. }) {
        let emit_result = app.emit(EVENT_CHANNEL, event);
        if cfg!(debug_assertions) {
            let c = EMIT_DELTA_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
            if c == 1 || c % 50 == 0 {
                eprintln!(
                    "[rust:agent-emit] delta #{} aid={} emit_ok={}",
                    c,
                    event.agent_id(),
                    emit_result.is_ok(),
                );
            }
        }
        return Ok(());
    }

    let conn_mutex = get_conn(app)?;
    let payload =
        serde_json::to_string(event).map_err(|e| format!("event serialize: {e}"))?;
    {
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agent_events (agent_id, ts, kind, payload)
             VALUES (?1, ?2, ?3, ?4)",
            params![event.agent_id(), now_ms(), event.kind_str(), payload],
        )
        .map_err(|e| format!("persist event: {e}"))?;
    }
    let emit_result = app.emit(EVENT_CHANNEL, event);
    if cfg!(debug_assertions) {
        eprintln!(
            "[rust:agent-emit] {} aid={} emit_ok={}",
            event.kind_str(),
            event.agent_id(),
            emit_result.is_ok(),
        );
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// Tauri commands
// ────────────────────────────────────────────────────────────────────────

/// Spawn a new agent. Phase 0: this DOES NOT call an LLM. It creates the
/// row, fires a Spawn event, then asynchronously emits a synthetic Message
/// (+300ms) and Complete (+800ms) so the end-to-end pipeline can be tested
/// without a model. Phase 1 will swap the synthetic emitter for a real
/// chat-loop driver.
#[tauri::command]
pub async fn agent_spawn(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    args: SpawnArgs,
) -> Result<String, String> {
    if !is_role_allowed(&args.role) {
        return Err(format!("invalid role: {}", args.role));
    }

    // Capacity check + handle insertion, both under the same mutex so two
    // concurrent spawns can't race past the cap.
    let agent_id = Uuid::new_v4().to_string();
    {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.len() >= MAX_CONCURRENT_AGENTS {
            return Err(format!(
                "agent capacity reached: {} active",
                MAX_CONCURRENT_AGENTS
            ));
        }
        guard.insert(
            agent_id.clone(),
            AgentHandle {
                role: args.role.clone(),
                abort: std::sync::Arc::new(tokio::sync::Notify::new()),
            },
        );
    }

    // INSERT the agents row.
    let created_at = now_ms();
    {
        let conn_mutex = get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agents
                (id, role, status, parent_id, model, task, conversation_id, created_at)
             VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, ?7)",
            params![
                agent_id,
                args.role,
                args.parent_id,
                args.model,
                args.task,
                args.conversation_id,
                created_at
            ],
        )
        .map_err(|e| {
            // Roll back the in-memory handle if the row insert failed —
            // otherwise the capacity cap leaks one slot.
            if let Ok(mut g) = state.0.lock() {
                g.remove(&agent_id);
            }
            format!("insert agents row: {e}")
        })?;
    }

    // Emit Spawn now that the row exists.
    persist_and_emit(
        &app,
        &AgentEvent::Spawn {
            agent_id: agent_id.clone(),
            parent_id: args.parent_id.clone(),
            role: args.role.clone(),
            task: args.task.clone(),
            model: args.model.clone(),
            conversation_id: args.conversation_id.clone(),
        },
    )?;

    // Phase 1 — hand off to the runner submodule. `run_agent_task` resolves
    // the provider (protocol/baseUrl/apiKey from `args`), calls the real
    // streaming helper from `chat.rs` with an agent-specific `on_chunk`
    // callback (which emits AgentEvent::Delta), and on completion writes
    // the output to the row + emits AgentEvent::Complete. Errors flow
    // through `finish_error` (also in runner.rs).
    //
    // Cancellation: the abort token we stored in AgentHandle above is
    // also cloned into the task so `agent_kill` can `notify_one()` to
    // break out of the `tokio::select!` at the next SSE chunk boundary.
    let abort_token = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .get(&agent_id)
            .map(|h| h.abort.clone())
            .ok_or_else(|| "agent handle vanished between insert and spawn".to_string())?
    };

    let app_for_task = app.clone();
    let agent_state = state.0.clone();
    let agent_id_for_task = agent_id.clone();
    let role_for_task = args.role.clone();
    let task_for_task = args.task.clone();
    let model_for_task = args.model.clone();
    let protocol_for_task = args.protocol.clone();
    let base_url_for_task = args.base_url.clone();
    let api_key_for_task = args.api_key.clone();
    let chat_template_kwargs_for_task = args.chat_template_kwargs.clone();
    let design_context_for_task = args.design_context.clone();
    tauri::async_runtime::spawn(async move {
        runner::run_agent_task(
            app_for_task,
            agent_state,
            agent_id_for_task,
            role_for_task,
            task_for_task,
            model_for_task,
            protocol_for_task,
            base_url_for_task,
            api_key_for_task,
            chat_template_kwargs_for_task,
            design_context_for_task,
            abort_token,
        )
        .await;
    });

    Ok(agent_id)
}

/// Kill a running agent. Cooperative cancellation: the runner task selects
/// between its LLM stream future and `handle.abort.notified()`, so
/// `notify_one()` wakes it at the next SSE chunk boundary (typically
/// 10–50 ms latency — acceptable for v1; true mid-chunk abort would
/// require aborting the reqwest connection, a Phase 2 improvement).
///
/// Non-cascading: only the targeted agent is killed. Phase 2+ orchestrator
/// spawning sub-agents must add child-cascade here.
#[tauri::command]
pub async fn agent_kill(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    // Take the handle out of the registry AND grab its abort token in
    // one critical section so a concurrent spawn can't see the slot as
    // freed while the task is still in tokio::select.
    let abort_token = {
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        match guard.remove(&agent_id) {
            Some(handle) => handle.abort,
            None => return Err(format!("agent not found: {agent_id}")),
        }
    };
    // Signal the running task to stop. Idempotent — repeated notifies
    // are a no-op once the task has consumed the first one.
    abort_token.notify_one();

    let finished_at = now_ms();
    {
        let conn_mutex = get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE agents
                SET status = 'killed',
                    finished_at = ?1,
                    error = COALESCE(error, 'killed by user')
              WHERE id = ?2",
            params![finished_at, agent_id],
        )
        .map_err(|e| format!("update agents kill: {e}"))?;
    }
    persist_and_emit(
        &app,
        &AgentEvent::Error {
            agent_id,
            error: "killed by user".into(),
        },
    )?;
    Ok(())
}

/// List active agents — read from SQLite (not the HashMap) so a fresh
/// window reload still sees what was running before. Filters to
/// pending/running.
#[tauri::command]
pub async fn agent_list_active(app: tauri::AppHandle) -> Result<Vec<AgentRow>, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, status, parent_id, model, task, conversation_id,
                    created_at, finished_at, output, error
               FROM agents
              WHERE status IN ('pending', 'running')
              ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], row_to_agent)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Full transcript of an agent — the row plus every persisted event
/// ordered chronologically. Phase 0 returns the full set in one shot;
/// Phase 1 may add `after_id` pagination for long-running agents.
#[tauri::command]
pub async fn agent_get_transcript(
    app: tauri::AppHandle,
    agent_id: String,
) -> Result<AgentTranscript, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;

    let agent: AgentRow = conn
        .query_row(
            "SELECT id, role, status, parent_id, model, task, conversation_id,
                    created_at, finished_at, output, error
               FROM agents
              WHERE id = ?1",
            params![agent_id],
            row_to_agent,
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("agent not found: {agent_id}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT id, agent_id, ts, kind, payload
               FROM agent_events
              WHERE agent_id = ?1
              ORDER BY ts ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let events = stmt
        .query_map(params![agent_id], |r| {
            Ok(AgentEventRow {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                ts: r.get(2)?,
                kind: r.get(3)?,
                payload: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(AgentTranscript { agent, events })
}

/// Every agent (any status) that belongs to a given conversation,
/// chronological order. Used by the UI to show "this chat spawned N agents".
#[tauri::command]
pub async fn agent_list_by_conversation(
    app: tauri::AppHandle,
    conversation_id: String,
) -> Result<Vec<AgentRow>, String> {
    let conn_mutex = get_conn(&app)?;
    let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, status, parent_id, model, task, conversation_id,
                    created_at, finished_at, output, error
               FROM agents
              WHERE conversation_id = ?1
              ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], row_to_agent)
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

// ────────────────────────────────────────────────────────────────────────
// Row mapper — defined once, reused by every command that SELECTs from
// the agents table so the column order can't drift.
// ────────────────────────────────────────────────────────────────────────

fn row_to_agent(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRow> {
    Ok(AgentRow {
        id: r.get(0)?,
        role: r.get(1)?,
        status: r.get(2)?,
        parent_id: r.get(3)?,
        model: r.get(4)?,
        task: r.get(5)?,
        conversation_id: r.get(6)?,
        created_at: r.get(7)?,
        finished_at: r.get(8)?,
        output: r.get(9)?,
        error: r.get(10)?,
    })
}
