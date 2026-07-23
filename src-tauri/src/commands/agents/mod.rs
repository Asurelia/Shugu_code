//! Shugu's native multi-agent runtime.
//!
//! This module owns spawning, durable lifecycle events, provider-backed LLM
//! loops, tool dispatch, sub-agent fan-out, cancellation, execution profiles,
//! human-in-the-loop resumes and worktree isolation.
//!
//! ## Data model
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
//! that demultiplexes by `agentId` into TanStack Query caches. Pattern mirrors
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
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use uuid::Uuid;

// Provider-backed LLM and tool-use loop.
pub(crate) mod runner;

// Runtime-enforced plan -> mutate -> verify completion contract. Kept pure so
// models/providers cannot bypass it and its state transitions stay unit-tested.
mod lifecycle;

// Versioned prompt composition and bounded workspace instruction discovery.
// Kept separate from the provider loop so prompts remain pure and unit-testable.
mod project_context;
pub(crate) mod prompts;

// Coalescing buffer for streaming Delta events — merges token-level chunks
// into ~14 events/s per (agent, kind) before they hit the Tauri event bus.
// See the module doc for the ordering contract with `persist_and_emit`.
mod delta_buffer;

// Phase 2 tools submodule. Defines the closed set of file-system tools the
// orchestrator can call (`fs_read_file`, `fs_write_file`, `fs_list_dir`),
// the JSON-schema renderers per provider dialect (OpenAI / Anthropic), and
// the `execute_tool` dispatcher that resolves a parsed ToolCall against
// the workspace root. The runner imports the public-to-this-module symbols
// (the `pub(super)` items) from here.
mod tools;

/// Governed command execution. Auto is sandboxed and fail-closed; only a native
/// session grant allows Full Access to use the direct process path.
pub(crate) mod exec;

/// Governed-exec layer (P0-a) — `ExecutionPolicy` (the capability envelope of a
/// run) + `CommandRisk` (a static classifier that flags the irreversible /
/// exfiltrating tail so the UI can surface a risk card WITHOUT blocking the
/// loop). The `run_command` dispatch in `tools.rs` calls `classify_command`
/// before spawning; the Tauri command `agent_classify_command` lets the UI
/// pre-flight a command string too.
pub(crate) mod policy;

/// Real Windows process sandbox for Auto `run_command`. The
/// command runs in a write-confined / reads-open LOW-integrity child spawned via
/// `CreateProcessAsUserW`: it can READ anywhere (so node/pnpm/cargo/git work) but
/// can only WRITE the workspace and dedicated `.shugu/agent-runtime` caches.
/// Global temp/user caches stay untouched. Network stays active. Any setup
/// failure blocks the command; it never falls back to direct execution. On
/// non-Windows Auto is unavailable until a native sandbox exists. See
/// `docs/win-sandbox-validation.md` for the mechanism + runtime checklist.
pub(crate) mod sandbox;

/// Skill library (Voyager / Hermes) — the agent saves reusable skills it learns
/// (`skill_save` tool) and loads them into context on future runs. Persistent,
/// per-role, compounding learning.
pub(crate) mod skills;

/// Learned command rules (Phase 2 — « mode fluide ») : motifs de commande
/// bénis (`allow`) ou flaggés (`deny`) par l'utilisateur, persistés, qui
/// OVERRIDENT le classifieur statique (`policy::classify_with_rules`). Un
/// `allow` retire le BADGE de risque (pas un prompt — il n'y en a pas) sur les
/// commandes de confiance. Calque la persistance de `skills.rs`.
pub(crate) mod command_rules;

/// S3 — Closed-loop lesson injection. At the start of each run, retrieves the
/// most relevant validated past reviews via semantic search and injects them
/// into the agent's context so past mistakes compound into future improvements.
mod lessons;

/// Faits de profil explicitement validés par l'utilisateur, injectés comme
/// données bornées dans les rôles conversationnels (orchestrator/mascot).
mod profile_memory;

/// Durable user objectives. A Goal owns successive agent runs and remains
/// resumable across reloads/restarts.
pub(crate) mod goals;

/// LOT 1 — Task-graph d'orchestration. Logique PURE (aucune I/O) qui transforme
/// les args de `todo_write` en graphe de tâches dependency-aware : validation
/// (ids/deps/cycles), prochaine tâche actionnable, accusé utile pour le modèle
/// et bloc d'ancrage ré-injecté dans la boucle (`runner.rs`). Le graphe n'a pas
/// de table dédiée : il vit dans les args du toolCall, déjà persistés.
mod plan;

// Re-export the crate-visible items from `tools` so `chat.rs` can reach
// them via `crate::commands::agents::*` without poking into the private
// submodule path. The streaming helpers in `chat.rs` consume:
//   - `ToolCall` as the shape held in `AssistantTurn.tool_calls`
//   - `ToolCallAccumulator` for the OpenAI streaming-fragment assembly
//   - `tools_json_*` for injecting the `tools` body field on agent calls
pub(crate) use tools::{
    tools_json_anthropic, tools_json_openai, ToolCall, ToolCallAccumulator, ToolResult,
};

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

/// Max concurrent agents. Beyond 4 the coordination overhead dominates the
/// parallelism gain in every benchmark we found (Anthropic, AG-UI, CrewAI).
const MAX_CONCURRENT_AGENTS: usize = 4;

/// Roles we accept on the spawn path. Stored as TEXT in the DB so the set
/// stays soft-extensible (a Phase 2 contributor can add "reviewer" by
/// editing this slice without a migration).
pub(crate) const ALLOWED_ROLES: &[&str] = &[
    "mascot",
    "orchestrator",
    "coder",
    "researcher",
    "tester",
    // Roles spawned by their dedicated commands (agent_atelier_run /
    // agent_grounded_run) — listed here so the set is the single source of
    // truth and a direct agent_spawn with these roles works too.
    "atelier",
    "grounded",
];

/// Tauri event channel name — single channel, every event carries its own
/// `agentId` so the frontend filters cheaply. Mirrors `chat://delta`.
const EVENT_CHANNEL: &str = "agent://lifecycle";

// ────────────────────────────────────────────────────────────────────────
// Managed state — in-memory tracker of running agents (concurrency cap)
// ────────────────────────────────────────────────────────────────────────

/// One entry per live agent. Holds the role for quick inspection AND
/// an abort signal (`tokio::sync::Notify`) for async work plus an atomic flag
/// polled by blocking command/process loops. Kill therefore terminates both the
/// Rust future and its OS process tree instead of merely dropping a JoinHandle.
pub struct AgentHandle {
    #[allow(dead_code)] // read by the runner / inspection helpers
    pub role: String,
    pub abort: Arc<tokio::sync::Notify>,
    pub cancelled: Arc<std::sync::atomic::AtomicBool>,
}

/// Tauri-managed state — the global in-flight registry. The Mutex is
/// short-held (insert/remove only); we never hold it across awaits.
#[derive(Default)]
pub struct AgentManagerState(pub Arc<Mutex<HashMap<String, AgentHandle>>>);

/// Native authority for direct, unsandboxed execution. The frontend can ask
/// for the grant, but only the native confirmation dialog can enable it. The
/// flag lives in memory, so every application restart returns to Auto.
#[derive(Default)]
pub struct FullAccessGrant(std::sync::atomic::AtomicBool);

impl FullAccessGrant {
    fn enabled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }

    fn set(&self, enabled: bool) {
        self.0.store(enabled, std::sync::atomic::Ordering::Release);
    }
}

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
    pub execution_profile: String,
    pub isolate: bool,
    pub profile_verified: bool,
    pub isolation_status: String,
    pub goal_id: Option<String>,
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
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentEvent {
    Spawn {
        agent_id: String,
        parent_id: Option<String>,
        role: String,
        task: String,
        model: String,
        conversation_id: Option<String>,
        execution_profile: policy::ExecutionProfile,
        isolate: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        goal_id: Option<String>,
    },
    Message {
        agent_id: String,
        /// One of `"system"`, `"user"`, `"assistant"` — string-typed
        /// rather than enum so future custom roles (e.g. `"tool"`) don't
        /// require a serde rename dance.
        role: String,
        content: String,
    },
    /// Reproducibility metadata for the effective runtime prompt. The complete
    /// composed fragment is persisted as the following system Message; this
    /// event makes its version, exact tool manifest and workspace sources
    /// queryable without reparsing prompt prose.
    PromptComposed {
        agent_id: String,
        version: String,
        fingerprint: String,
        execution_profile: policy::ExecutionProfile,
        protocol: String,
        tool_names: Vec<String>,
        rule_sources: Vec<String>,
        package_manager: Option<String>,
        context_truncated: bool,
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
    /// Skill learned (Voyager/Hermes) — the agent saved a REUSABLE skill that the
    /// real environment VERIFIED (its last `run_command` test exited 0). Emitted
    /// by the tool loop so the main chat UI shows an inline "🎓 appris : <name>"
    /// badge. Replaces the retired `HarnessEvolved` (prompt-rewrite Refiner).
    ///
    /// `source` — who created the skill: `"agent"` (via the `skill_save` tool
    /// after a passing test) or `"advisor"` (via the `skill_save_advisor` Tauri
    /// command, written by the external reviewer model). Serialised camelCase.
    SkillLearned {
        agent_id: String,
        role: String,
        name: String,
        /// `"agent"` | `"advisor"` — serialised camelCase via rename_all_fields.
        source: String,
    },
    /// S3 — Closed-loop lesson injection. Emitted when validated past-run lessons
    /// are retrieved via semantic search and injected into the agent's context.
    /// The `count` field reports how many lessons were actually injected so the
    /// UI can show a brief "📚 N leçon(s) injectée(s)" badge.
    LessonsInjected {
        agent_id: String,
        role: String,
        count: usize,
    },
    /// AM-2 — orchestrated-memory RECALL. Emitted when the `recall()` hook
    /// injected past facts/episodes (from the `memory` vector collection)
    /// relevant to this task into the agent's context. `count` = how many
    /// memories were surfaced, so the UI can show a "🧠 N souvenir(s) rappelé(s)"
    /// badge. Distinct from `LessonsInjected` (validated reviews) — these are the
    /// agent's own remembered facts + compaction summaries.
    MemoryRecalled {
        agent_id: String,
        role: String,
        count: usize,
    },
    /// AM-2 — history COMPACTION. Emitted when the loop summarised its oldest
    /// turns into one episodic memory (written to the `memory` collection) and
    /// replaced them with a single recap, to stay within context. `folded` =
    /// how many turns were collapsed into the summary, so the UI can show a
    /// "🗜 N tours compactés" note instead of the old silent 30-message drop.
    MemoryCompacted {
        agent_id: String,
        role: String,
        folded: usize,
    },
    /// A file write performed by the agent (fs_write_file / fs_edit). Carries the
    /// PRE-write content (`before`) so the chat can show a diff vs HEAD and offer
    /// an "Annuler" that restores it — exactly like the chat-direct path's
    /// `chat://writes`. `before == None` means the file was created this run.
    /// Persisted to `agent_events` so the diff/undo survive a reload.
    Write {
        agent_id: String,
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        before: Option<String>,
    },
    /// Capture d'écran prise par l'agent (outil `capture_screen`) pour la
    /// vérification visuelle (« tests réels »). `path` = JPEG plein format sur
    /// disque (app_data_dir/captures/) ; `thumb_data_url` = miniature 512 px
    /// affichée dans la timeline du fil. Persisté dans `agent_events` → la
    /// miniature survit au reload sans protocole asset.
    Screenshot {
        agent_id: String,
        tool_call_id: String,
        path: String,
        thumb_data_url: String,
    },
    /// Phase 3 — an isolated agent run started inside a FRESH git worktree.
    /// Emitted once, right after the worktree is created and BEFORE the tool
    /// loop runs. `path` is the worktree's working dir, `branch` its fresh
    /// branch. Only ever emitted when a caller opted into isolation
    /// (`isolate=true`); the default in-place path never emits it.
    WorktreeStarted {
        agent_id: String,
        path: String,
        branch: String,
    },
    /// Phase 3 — an isolated agent run finished and its worktree was finalized.
    /// `outcome` is one of:
    ///   * `"merged"`     — branch merged cleanly into the user's tree (`commit`
    ///                      is the merge commit); worktree removed.
    ///   * `"no-changes"` — the agent produced nothing to land; worktree removed.
    ///   * `"discarded"`  — the run was killed mid-flight; worktree discarded.
    ///   * `"diff"`       — the changes were KEPT for manual review (conflict,
    ///                      dirty target, or error). `branch`/`path` point at the
    ///                      kept worktree, `diff` is a `git diff --stat` summary,
    ///                      and `reason` explains why it wasn't auto-merged.
    /// Only ever emitted when a caller opted into isolation.
    WorktreeFinalized {
        agent_id: String,
        outcome: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        commit: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    /// Phase 7 #4 — l'isolation a été DEMANDÉE mais n'a pas pu démarrer (pas de
    /// dépôt git, pas de workspace, ou échec `git worktree add`). Le run s'arrête
    /// avant mutation : aucune retombée silencieuse sur le checkout réel.
    WorktreeSkipped {
        agent_id: String,
        reason: String,
    },
    /// Human-in-the-loop — l'agent a appelé `ask_user` : 1 à 4 questions à choix
    /// à présenter en carte CLIQUABLE dans le fil. Le tour se termine (fin-de-tour)
    /// via le sentinel `AGENT_PAUSE_SENTINEL` ; la réponse relance l'agent via la
    /// commande `agent_continue`. `questions` = le JSON brut de l'outil (tableau
    /// d'objets { id?, question, multiSelect?, options[] }). Persisté dans
    /// `agent_events` → la carte se reconstruit après un reload.
    QuestionAsked {
        agent_id: String,
        tool_call_id: String,
        questions: serde_json::Value,
    },
    /// Human-in-the-loop — l'agent a appelé `submit_plan` : son plan final (Markdown)
    /// à présenter en carte avec « Approuver et exécuter » / « Continuer à planifier ».
    /// Le tour se termine ; l'approbation bascule le mode en Agent et relance via
    /// `agent_continue`. Persisté → survit au reload.
    PlanSubmitted {
        agent_id: String,
        tool_call_id: String,
        plan: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

impl AgentEvent {
    /// Stable discriminator string used in the `agent_events.kind` column.
    /// Must match the `tag = "kind"` value serde emits on serialization.
    fn kind_str(&self) -> &'static str {
        match self {
            AgentEvent::Spawn { .. } => "spawn",
            AgentEvent::Message { .. } => "message",
            AgentEvent::PromptComposed { .. } => "promptComposed",
            AgentEvent::ToolCall { .. } => "toolCall",
            AgentEvent::ToolResult { .. } => "toolResult",
            AgentEvent::Delta { .. } => "delta",
            AgentEvent::Complete { .. } => "complete",
            AgentEvent::Error { .. } => "error",
            AgentEvent::SkillLearned { .. } => "skillLearned",
            AgentEvent::LessonsInjected { .. } => "lessonsInjected",
            AgentEvent::MemoryRecalled { .. } => "memoryRecalled",
            AgentEvent::MemoryCompacted { .. } => "memoryCompacted",
            AgentEvent::Write { .. } => "write",
            AgentEvent::Screenshot { .. } => "screenshot",
            AgentEvent::WorktreeStarted { .. } => "worktreeStarted",
            AgentEvent::WorktreeFinalized { .. } => "worktreeFinalized",
            AgentEvent::WorktreeSkipped { .. } => "worktreeSkipped",
            AgentEvent::QuestionAsked { .. } => "questionAsked",
            AgentEvent::PlanSubmitted { .. } => "planSubmitted",
        }
    }

    /// Agent id extractor — used to write the `agent_id` column without
    /// having to pattern-match every variant at the call site.
    fn agent_id(&self) -> &str {
        match self {
            AgentEvent::Spawn { agent_id, .. }
            | AgentEvent::Message { agent_id, .. }
            | AgentEvent::PromptComposed { agent_id, .. }
            | AgentEvent::ToolCall { agent_id, .. }
            | AgentEvent::ToolResult { agent_id, .. }
            | AgentEvent::Delta { agent_id, .. }
            | AgentEvent::Complete { agent_id, .. }
            | AgentEvent::Error { agent_id, .. }
            | AgentEvent::SkillLearned { agent_id, .. }
            | AgentEvent::LessonsInjected { agent_id, .. }
            | AgentEvent::MemoryRecalled { agent_id, .. }
            | AgentEvent::MemoryCompacted { agent_id, .. }
            | AgentEvent::Write { agent_id, .. }
            | AgentEvent::Screenshot { agent_id, .. }
            | AgentEvent::WorktreeStarted { agent_id, .. }
            | AgentEvent::WorktreeFinalized { agent_id, .. }
            | AgentEvent::WorktreeSkipped { agent_id, .. }
            | AgentEvent::QuestionAsked { agent_id, .. }
            | AgentEvent::PlanSubmitted { agent_id, .. } => agent_id,
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
    /// Path absolu d'un fichier `.md` (format Claude Code) définissant un
    /// agent custom. Si fourni, son frontmatter remplace `role`/`model` et
    /// son body devient le `system_prompt_override` envoyé au runner.
    pub agent_def_path: Option<String>,
    /// Mode du sélecteur de chat (cockpit). `Some("plan")` ⇒ run en LECTURE
    /// SEULE : le runner retire fs_write_file/fs_edit/run_command du manifest
    /// et refuse toute mutation (defense-in-depth). Toute autre valeur (ou
    /// None) ⇒ exécution directe complète. Seule la délégation chat le fournit ;
    /// Atelier/Studio le laissent None (write requis).
    pub mode: Option<String>,
    /// Effective backend-enforced profile. Legacy callers may omit it; the
    /// backend derives Plan/Chat from `mode` and otherwise defaults to Auto.
    pub execution_profile: Option<policy::ExecutionProfile>,
    /// Modèle CONSEILLER distinct pour l'outil `advisor` (v2). Résolu côté TS
    /// depuis `routing.advisorModel`. Quand `advisor_model` est présent, le
    /// runner consulte CE modèle (avec son provider) au lieu de l'exécuteur.
    /// Les 4 champs vont ensemble (None ⇒ auto-consultation).
    pub advisor_model: Option<String>,
    pub advisor_protocol: Option<String>,
    pub advisor_base_url: Option<String>,
    pub advisor_api_key: Option<String>,
    /// Phase 3 — worktree-per-agent isolation opt-in. When `Some(true)`, the
    /// agent runs inside a fresh git worktree and its changes are merged back at
    /// the end (parity with Cursor's per-agent isolation, for a future chat
    /// fan-out). Defaults to `false` (absent) — no current caller sets it, so
    /// the single-agent in-place flow is unchanged. Ignored in Plan mode
    /// (read-only never mutates, so it never isolates). Serializes from the
    /// camelCase `isolate` field.
    pub isolate: Option<bool>,
    /// Existing durable Goal to resume. `mode="goal"` without this field creates
    /// a new Goal atomically with the run.
    pub goal_id: Option<String>,
    /// User-facing Goal metadata. Kept separate from `task`, which may contain
    /// injected editor context and is therefore not a good durable objective.
    pub goal_title: Option<String>,
    pub goal_objective: Option<String>,
}

/// Arguments for `agent_continue` — human-in-the-loop resume after the user
/// answered an `ask_user` or approved/declined a `submit_plan`. The previous
/// turn ended cleanly (fin-de-tour) ; `answer` becomes the new run's `task`, and
/// `mode` governs read-only (a plan approval passes `mode: "agent"` to execute).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueArgs {
    pub conversation_id: String,
    pub model: String,
    /// Message user synthétique injecté (réponse aux questions, ou « exécute le
    /// plan approuvé » avec le plan réinjecté). Devient la `task` du nouveau run.
    pub answer: String,
    /// "plan" (relance après `ask_user` en Plan) ou "agent" (approbation de plan
    /// → bascule exécution). Passé tel quel à `SpawnArgs.mode`.
    pub mode: Option<String>,
    pub execution_profile: Option<policy::ExecutionProfile>,
    pub isolate: Option<bool>,
    /// `tool_call_id` de l'interaction consommée — clé d'idempotence (une réponse
    /// déjà consommée ne relance pas). None ⇒ pas de garde (relance directe).
    pub interaction_id: Option<String>,
    /// "ask_user" | "submit_plan" — trace dans `agent_interactions`.
    pub kind: Option<String>,
    /// Réponse brute (JSON des choix, ou feedback) — trace.
    pub response: Option<String>,
    /// "approved" | "continue" — verdict d'approbation d'un plan.
    pub verdict: Option<String>,
    // Provider routing — miroir de `SpawnArgs`, résolu côté TS.
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub chat_template_kwargs: Option<serde_json::Value>,
    pub advisor_model: Option<String>,
    pub advisor_protocol: Option<String>,
    pub advisor_base_url: Option<String>,
    pub advisor_api_key: Option<String>,
}

/// Arguments for an Atelier run (env-grounded build→test→learn loop). Mirrors the
/// provider routing of `SpawnArgs`, but role is fixed to "atelier" and the run
/// happens in a throwaway creation dir (empty temp dir, exec directe).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AtelierArgs {
    pub task: String,
    pub model: String,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub chat_template_kwargs: Option<serde_json::Value>,
}

/// Arguments for a Grounded Run — exec DIRECTLY on the user's real project
/// (pivot 2026-06-10, le filet est git). Mirrors `AtelierArgs` provider
/// routing, plus an optional verification command the agent must run after
/// each change.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroundedArgs {
    pub task: String,
    pub model: String,
    pub protocol: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub chat_template_kwargs: Option<serde_json::Value>,
    /// The project's verification command (e.g. "pnpm typecheck"). When set it
    /// is injected into the system prompt so the agent runs EXACTLY that.
    pub test_command: Option<String>,
}

// ────────────────────────────────────────────────────────────────────────
// DB connection (rusqlite, separate from tauri-plugin-sql's sqlx pool)
// ────────────────────────────────────────────────────────────────────────

static AGENTS_CONN: OnceLock<Mutex<Connection>> = OnceLock::new();

#[derive(Debug, Default, PartialEq, Eq)]
struct OrphanRecovery {
    agents: usize,
    interaction_claims: usize,
    goals_paused: usize,
}

fn recover_orphans(conn: &Connection, now: i64) -> Result<OrphanRecovery, String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("begin orphan recovery: {e}"))?;
    let agents = tx
        .execute(
            "UPDATE agents
                SET status = 'error',
                    error  = COALESCE(error, 'process restarted — agent orphaned'),
                    finished_at = COALESCE(finished_at, ?1),
                    isolation_status = CASE
                      WHEN isolate = 1 THEN 'unknown'
                      ELSE isolation_status
                    END
              WHERE status IN ('pending', 'running')",
            params![now],
        )
        .map_err(|e| format!("recover orphan agents: {e}"))?;
    // A process can die after atomically claiming an unanswered HITL card but
    // before spawning/persisting the continuation. No in-memory claimant can
    // survive a restart, so every unanswered token is stale and must be freed.
    let interaction_claims = tx
        .execute(
            "UPDATE agent_interactions
                SET claim_token = NULL
              WHERE answered_at IS NULL AND claim_token IS NOT NULL",
            [],
        )
        .map_err(|e| format!("recover interaction claims: {e}"))?;
    let goals_paused = goals::pause_orphaned_on_conn(&tx, now)?;
    tx.commit()
        .map_err(|e| format!("commit orphan recovery: {e}"))?;
    Ok(OrphanRecovery {
        agents,
        interaction_claims,
        goals_paused,
    })
}

/// Open (or return the cached) rusqlite Connection to `shugu.db`. Same
/// resolution as `vector.rs::get_conn` — `app_config_dir()/shugu.db` —
/// so both rusqlite users target the file that tauri-plugin-sql migrates.
///
/// The first call ALSO triggers `recover_orphans` which sweeps any
/// `running`/`pending` rows left behind by a previous crash. This MUST
/// run before any consumer reads `agent_list_active`, otherwise the UI
/// shows phantom agents from the previous process.
pub(crate) fn get_conn(app: &tauri::AppHandle) -> Result<&'static Mutex<Connection>, String> {
    if let Some(c) = AGENTS_CONN.get() {
        return Ok(c);
    }

    let db_path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("cannot resolve app config dir: {e}"))?
        .join("shugu.db");

    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create app config dir: {e}"))?;
    }

    let conn = Connection::open(&db_path)
        .map_err(|e| format!("rusqlite open {}: {e}", db_path.display()))?;

    // AM-5 cross-handle concurrency. `busy_timeout` is a PER-CONNECTION
    // setting, so the hardening on vector.rs's VEC_CONN does NOT cover this
    // handle. Without it, AGENTS_CONN (a heavy writer: orphan sweep, delta /
    // screenshot purges, agent rows / events / skills / usage) fails
    // IMMEDIATELY with SQLITE_BUSY ("database is locked") whenever VEC_CONN or
    // the sqlx pool holds the WAL write lock (e.g. during a memory_remember
    // IMMEDIATE transaction). Set it BEFORE the WAL pragma so the journal-mode
    // switch itself waits instead of erroring. 5000 ms mirrors
    // vector.rs::BUSY_TIMEOUT_MS — keep the two in sync.
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("busy_timeout: {e}"))?;

    // WAL for concurrent access alongside vector.rs + the plugin's sqlx
    // connection. Idempotent — re-setting the same journal mode is a
    // no-op cost.
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("WAL pragma: {e}"))?;

    // synchronous=NORMAL: corruption-safe under WAL with fewer fsyncs, so the
    // write lock is released sooner under contention (consistent with
    // vector.rs::configure_connection).
    conn.execute_batch("PRAGMA synchronous=NORMAL;")
        .map_err(|e| format!("synchronous pragma: {e}"))?;

    // Sweep orphans from a previous crash. Must happen BEFORE the conn is
    // cached so subsequent commands see consistent state.
    let now = now_ms();
    let recovery = recover_orphans(&conn, now)?;
    if recovery.agents > 0 || recovery.interaction_claims > 0 || recovery.goals_paused > 0 {
        eprintln!(
            "[agents] recovery: {} orphaned agent(s), {} stale interaction claim(s), {} resumable goal(s)",
            recovery.agents, recovery.interaction_claims, recovery.goals_paused
        );
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

    // Purge des miniatures de capture d'écran de plus de 7 jours : chaque
    // event `screenshot` embarque une miniature base64 (~50-160 Ko) — sans
    // purge, shugu.db gonflerait indéfiniment sur usage intensif. 7 jours
    // suffisent largement à la relecture d'un run ; le JPEG plein format
    // reste de toute façon dans app_data_dir/captures/.
    let week_ago = now_ms() - 7 * 24 * 3600 * 1000;
    let purged_shots = conn
        .execute(
            "DELETE FROM agent_events WHERE kind = 'screenshot' AND ts < ?1",
            params![week_ago],
        )
        .map_err(|e| format!("purge old screenshots: {e}"))?;
    if purged_shots > 0 {
        eprintln!("[agents] purged {purged_shots} screenshot row(s) older than 7 days");
    }

    // Phase 2 — table des règles de commande apprises. Auto-migrante côté
    // backend (CREATE TABLE IF NOT EXISTS) : pas de migration TS à ajouter, la
    // table existe dès le premier accès agent. PK = pattern (INSERT OR REPLACE
    // raffine une règle existante).
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_command_rules (
            pattern    TEXT PRIMARY KEY,
            verdict    TEXT NOT NULL,
            detail     TEXT,
            created_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| format!("create agent_command_rules: {e}"))?;

    let _ = AGENTS_CONN.set(Mutex::new(conn));
    AGENTS_CONN
        .get()
        .ok_or_else(|| "AGENTS_CONN OnceLock unexpectedly empty".to_string())
}

// ────────────────────────────────────────────────────────────────────────
// Small helpers
// ────────────────────────────────────────────────────────────────────────

pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_role_allowed(role: &str) -> bool {
    ALLOWED_ROLES.iter().any(|r| *r == role)
}

fn resolve_execution_profile(
    mode: Option<&str>,
    requested: Option<policy::ExecutionProfile>,
) -> Result<policy::ExecutionProfile, String> {
    match mode {
        Some("chat") => Ok(policy::ExecutionProfile::Chat),
        Some("plan") => Ok(match requested {
            Some(policy::ExecutionProfile::Chat) => policy::ExecutionProfile::Chat,
            _ => policy::ExecutionProfile::Plan,
        }),
        Some("agent") | Some("goal") | None => {
            Ok(requested.unwrap_or(policy::ExecutionProfile::Auto))
        }
        Some(other) => Err(format!("mode agent invalide: {other}")),
    }
}

fn require_profile_grant(
    profile: policy::ExecutionProfile,
    full_access_enabled: bool,
) -> Result<policy::ExecutionProfile, String> {
    if matches!(profile, policy::ExecutionProfile::FullAccess) && !full_access_enabled {
        return Err(
            "Full Access n'est pas autorisé pour cette session. Active-le depuis le sélecteur de mode et confirme la boîte de dialogue native."
                .to_string(),
        );
    }
    Ok(profile)
}

fn require_agent_loop_capability(
    profile: policy::ExecutionProfile,
    protocol: &str,
    model: &str,
) -> Result<(), String> {
    if profile.is_read_only() {
        return Ok(());
    }
    let caps = crate::commands::model_capabilities::capabilities(protocol, model);
    if matches!(
        caps.agent_loop,
        crate::commands::model_capabilities::AgentLoopSupport::ChatOnly
    ) {
        return Err(format!(
            "{protocol}/{model} est Chat-only dans cette version de Shugu : aucun adaptateur d'outils agentiques vérifié n'est disponible. Choisis un modèle Anthropic/OpenAI-compatible, ou utilise le mode Chat."
        ));
    }
    Ok(())
}

/// Dispatch-time check as well as spawn-time check: revoking Full Access
/// immediately blocks the next tool call of runs that were already active.
pub(crate) fn execution_profile_authorized(
    app: &tauri::AppHandle,
    profile: policy::ExecutionProfile,
) -> bool {
    !matches!(profile, policy::ExecutionProfile::FullAccess)
        || app
            .try_state::<FullAccessGrant>()
            .is_some_and(|grant| grant.enabled())
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
    if let AgentEvent::Delta {
        agent_id,
        chunk,
        delta_kind,
    } = event
    {
        // Coalesce: most chunks just feed the buffer; one merged Delta comes
        // out per FLUSH_INTERVAL per (agent, kind). The stream's tail is
        // flushed by the non-delta branch below (the runner always closes a
        // turn with Message/Complete/Error).
        let Some(merged) = delta_buffer::push(agent_id, delta_kind, chunk) else {
            return Ok(());
        };
        let merged_event = AgentEvent::Delta {
            agent_id: agent_id.clone(),
            chunk: merged,
            delta_kind: delta_kind.clone(),
        };
        let emit_result = app.emit(EVENT_CHANNEL, &merged_event);
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

    // Non-delta event: flush this agent's pending merged deltas FIRST so the
    // frontend never sees a Message/ToolCall/Complete overtake its own text.
    for (delta_kind, chunk) in delta_buffer::drain(event.agent_id()) {
        let flushed = AgentEvent::Delta {
            agent_id: event.agent_id().to_string(),
            chunk,
            delta_kind,
        };
        let _ = app.emit(EVENT_CHANNEL, &flushed);
    }

    let conn_mutex = get_conn(app)?;
    let payload = serde_json::to_string(event).map_err(|e| format!("event serialize: {e}"))?;
    {
        let mut conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin agent spawn: {e}"))?;
        tx.execute(
            "INSERT INTO agent_events (agent_id, ts, kind, payload)
             VALUES (?1, ?2, ?3, ?4)",
            params![event.agent_id(), now_ms(), event.kind_str(), payload],
        )
        .map_err(|e| format!("persist event: {e}"))?;
        goals::apply_event_on_conn(&tx, event, now_ms())?;
        tx.commit()
            .map_err(|e| format!("commit agent event: {e}"))?;
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentAccessChanged {
    profile: &'static str,
}

fn emit_access_profile(app: &tauri::AppHandle, enabled: bool) {
    let _ = app.emit(
        "chat://agent-access-changed",
        AgentAccessChanged {
            profile: if enabled { "fullAccess" } else { "auto" },
        },
    );
}

/// Ask once per native app session before enabling unsandboxed execution.
/// This cannot be bypassed by writing sessionStorage or emitting a web event.
#[tauri::command]
pub async fn agent_enable_full_access(
    app: tauri::AppHandle,
    grant: State<'_, FullAccessGrant>,
) -> Result<bool, String> {
    if grant.enabled() {
        return Ok(true);
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(
            "Full Access autorise les agents à lancer des commandes directement sur votre machine, sans sandbox et sans confirmation par commande. Les modes Chat et Plan restent en lecture seule. Cette autorisation expire au redémarrage de Shugu.",
        )
        .title("Activer Full Access pour cette session ?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Activer Full Access".to_string(),
            "Rester en Auto".to_string(),
        ))
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });

    let accepted = receiver
        .await
        .map_err(|_| "la confirmation Full Access a été interrompue".to_string())?;
    if accepted {
        grant.set(true);
    }
    emit_access_profile(&app, grant.enabled());
    Ok(grant.enabled())
}

#[tauri::command]
pub fn agent_disable_full_access(app: tauri::AppHandle, grant: State<'_, FullAccessGrant>) -> bool {
    grant.set(false);
    emit_access_profile(&app, false);
    false
}

#[tauri::command]
pub fn agent_full_access_status(grant: State<'_, FullAccessGrant>) -> bool {
    grant.enabled()
}

/// Persist and spawn a provider-backed agent run under the resolved native
/// execution profile.
#[tauri::command]
pub async fn agent_spawn(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    full_access: State<'_, FullAccessGrant>,
    mut args: SpawnArgs,
) -> Result<String, String> {
    // Agent custom (`.md` format Claude Code) ? Charge la définition et écrase
    // role/model par ses valeurs. Le body devient le `system_prompt_override`
    // — le runner accepte déjà ce levier ([runner.rs] system_prompt_override).
    // Sinon : comportement historique (role brut, seed_prompt par défaut).
    //
    // ⚠ CONTRAT : on ne résout ici QUE `role` + `model` (nom nu). Le provider du
    // modèle épinglé (protocol / base_url / api_key) reste la responsabilité de
    // l'appelant TS (handleDelegate → resolveProvider + loadProviderConfig). Un
    // futur appelant qui passerait `agent_def_path` SANS résoudre le provider en
    // amont enverrait le bon model mais les mauvais protocol/clé.
    let (system_prompt_override, definition_tools): (Option<String>, Option<Vec<String>>) =
        match args.agent_def_path.as_deref() {
            Some(p) if !p.is_empty() => {
                let def = crate::commands::agent_defs::load_def(&app, p)?;
                args.role = def.base_role;
                if let Some(m) = def.model {
                    // Strip the "provider/" prefix — the API body needs the bare model name
                    // (mirrors resolveProvider() on the TS side, e.g. "openai/gpt-4o" → "gpt-4o").
                    args.model = m.split_once('/').map(|(_, n)| n.to_string()).unwrap_or(m);
                }
                let tools = if def.tools.is_empty() {
                    None
                } else {
                    Some(def.tools)
                };
                (Some(def.body), tools)
            }
            _ => (None, None),
        };

    if !is_role_allowed(&args.role) {
        return Err(format!("invalid role: {}", args.role));
    }

    let execution_profile = require_profile_grant(
        resolve_execution_profile(args.mode.as_deref(), args.execution_profile)?,
        full_access.enabled(),
    )?;
    require_agent_loop_capability(
        execution_profile,
        args.protocol.as_deref().unwrap_or("openai"),
        &args.model,
    )?;
    let isolate_for_task = args.isolate.unwrap_or(false) && !execution_profile.is_read_only();

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
                cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
    }

    // INSERT the agent and its durable Goal attachment in one transaction. A
    // Goal-mode run without goal_id creates a new objective; a continuation
    // passes the existing id and becomes its new current attempt.
    let created_at = now_ms();
    let persist_spawn = (|| -> Result<Option<String>, String> {
        let conn_mutex = get_conn(&app)?;
        let mut conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("begin agent spawn transaction: {e}"))?;
        let goal_requested = args.mode.as_deref() == Some("goal") || args.goal_id.is_some();
        let attached_goal_id = if goal_requested {
            let conversation_id = args
                .conversation_id
                .as_deref()
                .ok_or_else(|| "le mode Goal exige une conversation".to_string())?;
            let workspace_id = runner::get_workspace_root(&app)
                .as_deref()
                .map(crate::commands::vector::workspace_id);
            Some(goals::attach_run_on_conn(
                &tx,
                goals::AttachGoal {
                    existing_goal_id: args.goal_id.as_deref(),
                    conversation_id,
                    workspace_id: workspace_id.as_deref(),
                    title: args.goal_title.as_deref(),
                    objective: args.goal_objective.as_deref().unwrap_or(&args.task),
                    role: &args.role,
                    model: &args.model,
                    protocol: args.protocol.as_deref(),
                    base_url: args.base_url.as_deref(),
                    execution_profile: execution_profile.as_str(),
                    isolate: isolate_for_task,
                    agent_id: &agent_id,
                    now: created_at,
                },
            )?)
        } else {
            None
        };
        tx.execute(
            "INSERT INTO agents
                (id, role, status, parent_id, model, task, conversation_id, created_at,
                 execution_profile, isolate, profile_verified, isolation_status, goal_id)
             VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11)",
            params![
                agent_id,
                args.role,
                args.parent_id,
                args.model,
                args.task,
                args.conversation_id,
                created_at,
                execution_profile.as_str(),
                isolate_for_task,
                if isolate_for_task { "pending" } else { "none" },
                attached_goal_id,
            ],
        )
        .map_err(|e| format!("insert agents row: {e}"))?;
        tx.commit()
            .map_err(|e| format!("commit agent spawn transaction: {e}"))?;
        Ok(attached_goal_id)
    })();
    let attached_goal_id = match persist_spawn {
        Ok(goal_id) => goal_id,
        Err(error) => {
            if let Ok(mut guard) = state.0.lock() {
                guard.remove(&agent_id);
            }
            return Err(error);
        }
    };

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
            execution_profile,
            isolate: isolate_for_task,
            goal_id: attached_goal_id.clone(),
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
    let system_prompt_override_for_task = system_prompt_override;
    let definition_tools_for_task = definition_tools;
    // Exécution DIRECTE par défaut (décision utilisateur 2026-07-02, retour au
    // pivot 2026-06-10 « exec directe + filet git ») : l'agent travaille sur le
    // VRAI checkout, comme Claude Code. L'isolation worktree (Phase 7 #4) reste
    // disponible en OPT-IN (`isolate: true`) mais n'est plus le défaut : le
    // worktree démarre du dernier COMMIT, donc les fichiers non commités du
    // user y sont INVISIBLES (agent « aveugle » : fichiers introuvables, croit
    // qu'ils sont sur une autre branche) et son résultat reste parqué sur une
    // branche tant que rien n'est mergé — deux pièges fatals pour un
    // utilisateur qui ne commit pas. JAMAIS en Plan/read-only (rien à isoler).
    // Mémoire de conversation : le chemin chat passe la conv pour recharger les
    // tours précédents dans l'historique de l'agent.
    let conversation_id_for_task = args.conversation_id.clone();
    // Modèle conseiller distinct (v2) : Some seulement si un modèle advisor a été
    // résolu côté TS (routing.advisorModel). Sinon None ⇒ auto-consultation.
    let advisor_for_task: Option<runner::AdvisorConfig> = match (
        args.advisor_model.clone(),
        args.advisor_protocol.clone(),
        args.advisor_base_url.clone(),
    ) {
        (Some(model), Some(protocol), Some(base_url)) if !model.trim().is_empty() => {
            Some(runner::AdvisorConfig {
                model,
                protocol,
                base_url,
                api_key: args.advisor_api_key.clone().unwrap_or_default(),
            })
        }
        // Filet : advisor_model fourni mais protocol/base_url manquant = bug de
        // résolution TS. On retombe en auto-consultation (None) mais on le SIGNALE
        // en dev (sinon un conseiller mal configuré dégrade en silence).
        (Some(model), _, _) if !model.trim().is_empty() => {
            #[cfg(debug_assertions)]
            eprintln!(
                "[agent_spawn] advisor_model='{model}' fourni mais protocol/base_url manquant — auto-consultation (vérifier resolveAdvisorArgs)"
            );
            None
        }
        _ => None,
    };
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
            None, // workspace_override — chat works on the real open workspace
            // Exec directe pour TOUT agent (pivot 2026-06-10) : run_command tourne
            // sur la machine, le filet de sécurité est git (onglet Git de l'app).
            system_prompt_override_for_task, // None ⇒ seed_prompt ; Some ⇒ .md custom
            execution_profile,
            conversation_id_for_task, // recharge les tours précédents de la conv
            advisor_for_task,         // modèle conseiller distinct (v2) ou None
            isolate_for_task,         // Phase 3 — worktree-per-agent (default OFF)
            definition_tools_for_task,
        )
        .await;
    });

    Ok(agent_id)
}

/// Human-in-the-loop — relance un agent après une réponse de l'utilisateur à un
/// `ask_user`, ou l'approbation d'un `submit_plan`. Le tour précédent s'est terminé
/// proprement (fin-de-tour via le sentinel) ; ici on injecte la réponse comme
/// nouvelle `task` et on relance via le chemin `agent_spawn` habituel — qui recharge
/// l'historique de la conversation. L'idempotence (double-clic / reload+re-clic)
/// repose sur la table `agent_interactions` : un `tool_call_id` déjà consommé rend
/// l'appel no-op (erreur douce).
#[tauri::command]
pub async fn agent_continue(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    full_access: State<'_, FullAccessGrant>,
    mut args: ContinueArgs,
) -> Result<String, String> {
    let interaction_id = args
        .interaction_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "interaction_id requis pour reprendre un agent".to_string())?
        .to_string();
    let claim_token = Uuid::new_v4().to_string();

    // Claim transactionnel : crée aussi la ligne pending pour les anciennes
    // cartes V18 qui ont été émises avant la migration V21.
    let (stored_kind, source_profile, source_isolate, source_goal_id) = {
        let conn_mutex = get_conn(&app)?;
        let mut conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("interaction transaction: {e}"))?;
        let source_from_id = interaction_id
            .split_once(':')
            .map(|(id, _)| id)
            .unwrap_or("");
        tx.execute(
            "INSERT OR IGNORE INTO agent_interactions
                (interaction_id, conversation_id, kind, created_at,
                 source_agent_id, source_execution_profile, source_isolate)
             SELECT ?1, COALESCE(?2, conversation_id), ?3, ?4,
                    id, execution_profile, isolate
               FROM agents WHERE id=?5",
            params![
                interaction_id,
                args.conversation_id,
                args.kind,
                now_ms(),
                source_from_id
            ],
        )
        .map_err(|e| format!("interaction bootstrap: {e}"))?;

        let row: Option<(
            Option<String>,
            Option<String>,
            Option<bool>,
            Option<i64>,
            Option<String>,
            Option<String>,
        )> = tx
            .query_row(
                "SELECT i.kind, i.source_execution_profile, i.source_isolate,
                        i.answered_at, i.claim_token, a.goal_id
                   FROM agent_interactions i
                   LEFT JOIN agents a ON a.id=i.source_agent_id
                  WHERE i.interaction_id=?1",
                params![interaction_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| format!("interaction lookup: {e}"))?;
        let (
            stored_kind,
            source_profile,
            source_isolate,
            answered_at,
            existing_claim,
            source_goal_id,
        ) = row.ok_or_else(|| "interaction inconnue ou agent source introuvable".to_string())?;
        if answered_at.is_some() {
            return Err("Cette interaction a déjà été traitée.".to_string());
        }
        if existing_claim.is_some() {
            return Err("Cette interaction est déjà en cours de traitement.".to_string());
        }
        if let (Some(expected), Some(received)) = (stored_kind.as_deref(), args.kind.as_deref()) {
            if expected != received {
                return Err(format!(
                    "type d'interaction incohérent : attendu {expected}, reçu {received}"
                ));
            }
        }
        let changed = tx
            .execute(
                "UPDATE agent_interactions SET claim_token=?1
                  WHERE interaction_id=?2 AND answered_at IS NULL AND claim_token IS NULL",
                params![claim_token, interaction_id],
            )
            .map_err(|e| format!("interaction claim: {e}"))?;
        if changed != 1 {
            return Err("Cette interaction est déjà en cours de traitement.".to_string());
        }
        let source_profile =
            policy::ExecutionProfile::from_persisted(source_profile.as_deref().unwrap_or("plan"))
                .ok_or_else(|| "profil source de l'interaction invalide".to_string())?;
        tx.commit()
            .map_err(|e| format!("interaction claim commit: {e}"))?;
        (
            stored_kind.unwrap_or_else(|| "ask_user".to_string()),
            source_profile,
            source_isolate.unwrap_or(false),
            source_goal_id,
        )
    };

    let effective_profile = match (stored_kind.as_str(), args.verdict.as_deref()) {
        ("submit_plan", Some("approved")) => policy::ExecutionProfile::Auto,
        ("submit_plan", _) => policy::ExecutionProfile::Plan,
        _ => source_profile,
    };
    args.execution_profile = Some(effective_profile);
    args.mode = Some(
        match effective_profile {
            policy::ExecutionProfile::Chat => "chat",
            policy::ExecutionProfile::Plan => "plan",
            policy::ExecutionProfile::Auto | policy::ExecutionProfile::FullAccess => "agent",
        }
        .to_string(),
    );
    args.isolate = Some(source_isolate && !effective_profile.is_read_only());
    let response_for_record = args.response.clone();
    let verdict_for_record = args.verdict.clone();

    // Relance : réutilise INTÉGRALEMENT le chemin `agent_spawn` (cap, INSERT row,
    // Spawn, run_agent_task avec rechargement d'historique par conversation_id).
    // La réponse de l'utilisateur devient la `task`. Un nouvel agent_id est créé.
    let spawn_args = SpawnArgs {
        role: "orchestrator".to_string(),
        task: args.answer,
        model: args.model,
        parent_id: None,
        conversation_id: Some(args.conversation_id),
        protocol: args.protocol,
        base_url: args.base_url,
        api_key: args.api_key,
        chat_template_kwargs: args.chat_template_kwargs,
        design_context: None,
        agent_def_path: None,
        mode: args.mode,
        execution_profile: args.execution_profile,
        advisor_model: args.advisor_model,
        advisor_protocol: args.advisor_protocol,
        advisor_base_url: args.advisor_base_url,
        advisor_api_key: args.advisor_api_key,
        isolate: args.isolate,
        goal_id: source_goal_id,
        goal_title: None,
        goal_objective: None,
    };
    let manager_after_spawn = state.0.clone();
    let spawn = agent_spawn(app.clone(), state, full_access, spawn_args).await;
    match spawn {
        Ok(agent_id) => {
            let finalized = (|| -> Result<(), String> {
                let conn_mutex = get_conn(&app)?;
                let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
                let changed = conn
                    .execute(
                        "UPDATE agent_interactions
                        SET response=?1, verdict=?2, answered_at=?3,
                            continuation_agent_id=?4, claim_token=NULL
                      WHERE interaction_id=?5 AND claim_token=?6 AND answered_at IS NULL",
                        params![
                            response_for_record,
                            verdict_for_record,
                            now_ms(),
                            agent_id,
                            interaction_id,
                            claim_token
                        ],
                    )
                    .map_err(|e| format!("interaction finalize: {e}"))?;
                if changed != 1 {
                    return Err("l'interaction n'a pas pu être finalisée".into());
                }
                Ok(())
            })();
            if let Err(err) = finalized {
                // Do not leave an untracked duplicate continuation running. The
                // runner observes both signals and terminates its process tree.
                if let Ok(guard) = manager_after_spawn.lock() {
                    if let Some(handle) = guard.get(&agent_id) {
                        handle
                            .cancelled
                            .store(true, std::sync::atomic::Ordering::Release);
                        handle.abort.notify_waiters();
                    }
                }
                if let Ok(conn_mutex) = get_conn(&app) {
                    if let Ok(conn) = conn_mutex.lock() {
                        let _ = conn.execute(
                            "UPDATE agent_interactions SET claim_token=NULL
                              WHERE interaction_id=?1 AND claim_token=?2 AND answered_at IS NULL",
                            params![interaction_id, claim_token],
                        );
                    }
                }
                return Err(format!(
                    "la reprise a été annulée car sa trace atomique a échoué : {err}"
                ));
            }
            Ok(agent_id)
        }
        Err(err) => {
            if let Ok(conn_mutex) = get_conn(&app) {
                if let Ok(conn) = conn_mutex.lock() {
                    let _ = conn.execute(
                        "UPDATE agent_interactions SET claim_token=NULL
                          WHERE interaction_id=?1 AND claim_token=?2 AND answered_at IS NULL",
                        params![interaction_id, claim_token],
                    );
                }
            }
            Err(err)
        }
    }
}

/// Atelier run — the env-grounded learning loop. Spawns an `atelier` agent in a
/// THROWAWAY creation dir (under the OS temp dir), driven by `ATELIER_PROMPT`:
/// it builds a small web UI, writes a Playwright test, runs it for real (exec
/// directe), iterates on real failures, and saves a skill only once the test
/// passes. Streams into the SAME transcript UI as any agent — no separate window.
#[tauri::command]
pub async fn agent_atelier_run(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    args: AtelierArgs,
) -> Result<String, String> {
    // Dedicated role so Atelier-learned skills ("build + browser-test a web UI")
    // load for FUTURE Atelier runs but never pollute plain `coder` chat turns
    // (where a UI-testing recipe is irrelevant). The system prompt is overridden
    // (ATELIER_PROMPT) regardless of role, so `seed_prompt` for it is unused.
    let role = "atelier";

    // Capacity check + handle insertion (same cap as agent_spawn).
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
                role: role.to_string(),
                abort: std::sync::Arc::new(tokio::sync::Notify::new()),
                cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
    }

    // Throwaway creation dir under the OS temp dir. Canonicalize so the
    // workspace path-guard's pre-canonicalized-root contract holds on Windows
    // (the `\\?\` prefix).
    let ws_raw = std::env::temp_dir().join(format!("shugu-atelier-{agent_id}"));
    if let Err(e) = std::fs::create_dir_all(&ws_raw) {
        if let Ok(mut g) = state.0.lock() {
            g.remove(&agent_id);
        }
        return Err(format!("create atelier dir: {e}"));
    }
    let ws = std::fs::canonicalize(&ws_raw).unwrap_or(ws_raw);

    // INSERT the agents row (standalone — no conversation, no parent).
    let created_at = now_ms();
    {
        let conn_mutex = get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agents
                (id, role, status, parent_id, model, task, conversation_id, created_at,
                 execution_profile, isolate, profile_verified, isolation_status)
             VALUES (?1, ?2, 'running', NULL, ?3, ?4, NULL, ?5, 'auto', 0, 1, 'none')",
            params![agent_id, role, args.model, args.task, created_at],
        )
        .map_err(|e| {
            if let Ok(mut g) = state.0.lock() {
                g.remove(&agent_id);
            }
            format!("insert agents row: {e}")
        })?;
    }

    persist_and_emit(
        &app,
        &AgentEvent::Spawn {
            agent_id: agent_id.clone(),
            parent_id: None,
            role: role.to_string(),
            task: args.task.clone(),
            model: args.model.clone(),
            conversation_id: None,
            execution_profile: policy::ExecutionProfile::Auto,
            isolate: false,
            goal_id: None,
        },
    )?;

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
    let ws_for_task = ws.clone();
    tauri::async_runtime::spawn(async move {
        runner::run_agent_task(
            app_for_task,
            agent_state,
            agent_id_for_task,
            role.to_string(),
            args.task,
            args.model,
            args.protocol,
            args.base_url,
            args.api_key,
            args.chat_template_kwargs,
            None, // design_context
            abort_token,
            Some(ws_for_task), // workspace_override — the throwaway creation dir
            Some(prompts::ATELIER_PROMPT.to_string()),
            policy::ExecutionProfile::Auto,
            None,  // conversation_id — l'Atelier n'est pas lié à une conversation
            None,  // advisor — pas de conseiller distinct pour l'Atelier
            false, // isolate — l'Atelier a DÉJÀ son dossier jetable (override Some)
            None,  // definition_tools — preset interne
        )
        .await;
        // The creation dir is intentionally left on disk so the preview pane can
        // render the built app; the OS reclaims the temp dir over time.
    });

    Ok(agent_id)
}

/// Preflight the agent execution context: is the GIT SAFETY NET in place?
/// Execution itself is always available (exec directe, pivot 2026-06-10) —
/// what the UI surfaces is a NON-blocking warning when the workspace has no
/// git repo or has uncommitted changes. Runs the blocking `git status` probe
/// off the async runtime.
#[tauri::command]
pub async fn agent_exec_preflight(app: tauri::AppHandle) -> Result<exec::ExecCapability, String> {
    let root = crate::commands::fs::restore_workspace_root(&app);
    tokio::task::spawn_blocking(move || exec::check_git_safety(root))
        .await
        .map_err(|e| format!("preflight join error: {e}"))
}

/// Classify a command string against an execution policy WITHOUT running it
/// (P0-a). The UI calls this to pre-flight a command the user is about to let
/// an agent run — it returns `{ level, reason?, detail? }` so a risk card can
/// be shown for `danger` verdicts. Pure/synchronous classifier, so no blocking
/// work; `read_only` maps to the policy envelope (`true` ⇒ ReadOnly/Plan mode).
#[tauri::command]
pub async fn agent_classify_command(
    command: String,
    read_only: Option<bool>,
    execution_profile: Option<policy::ExecutionProfile>,
) -> Result<policy::CommandRisk, String> {
    let pol = execution_profile
        .map(policy::ExecutionProfile::policy)
        .unwrap_or_else(|| policy::policy_for_run(read_only.unwrap_or(false)));
    Ok(policy::classify_command(&command, pol))
}

/// Grounded Run — the env-grounded loop DIRECTLY on the user's real project
/// (pivot 2026-06-10 : plus de miroir jetable). Spawns a `grounded` agent with
/// execution enabled, driven by `GROUNDED_PROMPT`: it reads, edits, runs the
/// project's checks, and iterates on real failures. Every change lands on the
/// live tree as it happens — the user follows and reverts them in the app's
/// Git panel (the git watcher refreshes it live).
#[tauri::command]
pub async fn agent_grounded_run(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    args: GroundedArgs,
) -> Result<String, String> {
    let role = "grounded";

    // The live project root must be open — that's where the agent works.
    if crate::commands::fs::restore_workspace_root(&app).is_none() {
        return Err("aucun projet ouvert : ouvre un dossier avant un Grounded Run".to_string());
    }

    // Capacity check + handle insertion (same cap as agent_spawn / Atelier).
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
                role: role.to_string(),
                abort: std::sync::Arc::new(tokio::sync::Notify::new()),
                cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
    }

    // INSERT the agents row (standalone — no conversation, no parent).
    let created_at = now_ms();
    {
        let conn_mutex = get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agents
                (id, role, status, parent_id, model, task, conversation_id, created_at,
                 execution_profile, isolate, profile_verified, isolation_status)
             VALUES (?1, ?2, 'running', NULL, ?3, ?4, NULL, ?5, 'auto', 1, 1, 'pending')",
            params![agent_id, role, args.model, args.task, created_at],
        )
        .map_err(|e| {
            if let Ok(mut g) = state.0.lock() {
                g.remove(&agent_id);
            }
            format!("insert agents row: {e}")
        })?;
    }

    persist_and_emit(
        &app,
        &AgentEvent::Spawn {
            agent_id: agent_id.clone(),
            parent_id: None,
            role: role.to_string(),
            task: args.task.clone(),
            model: args.model.clone(),
            conversation_id: None,
            execution_profile: policy::ExecutionProfile::Auto,
            isolate: true,
            goal_id: None,
        },
    )?;

    // System prompt = GROUNDED_PROMPT + the project's verification command (if
    // provided) so the agent runs EXACTLY that after each change.
    let mut system_prompt = prompts::GROUNDED_PROMPT.to_string();
    if let Some(cmd) = args.test_command.as_deref() {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            system_prompt.push_str(&format!(
                "\n\nVERIFICATION COMMAND (run EXACTLY this with run_command after each change, iterate until it exits 0):\n{cmd}\n"
            ));
        }
    }

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
    tauri::async_runtime::spawn(async move {
        runner::run_agent_task(
            app_for_task,
            agent_state,
            agent_id_for_task,
            role.to_string(),
            args.task,
            args.model,
            args.protocol,
            args.base_url,
            args.api_key,
            args.chat_template_kwargs,
            None, // design_context
            abort_token,
            None, // workspace_override — the REAL open workspace
            Some(system_prompt),
            policy::ExecutionProfile::Auto,
            None, // conversation_id — Grounded Run n'est pas lié à une conversation
            None, // advisor — pas de conseiller distinct pour Grounded Run
            true, // isolate — Phase 7 #4 : Grounded Run isolé par défaut (Option B,
            // cohérence « autonomie fiable » ; merge-back opt-in via l'UI)
            None, // definition_tools — preset interne
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
/// CASCADE (Phase B) : tue la cible ET tous ses sous-agents délégués encore
/// vivants (descendants via `parent_id`, index `idx_agents_parent`), pour qu'un
/// kill du parent n'orpheline pas un enfant en cours.
#[tauri::command]
pub async fn agent_kill(
    app: tauri::AppHandle,
    state: State<'_, AgentManagerState>,
    agent_id: String,
) -> Result<(), String> {
    // Cascade : rassembler tous les descendants vivants (BFS via parent_id)
    // AVANT de toucher au registre.
    let mut descendants: Vec<String> = Vec::new();
    {
        let conn_mutex = get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        let mut frontier = vec![agent_id.clone()];
        while let Some(pid) = frontier.pop() {
            let kids: Vec<String> = {
                let mut stmt = conn
                    .prepare(
                        "SELECT id FROM agents
                          WHERE parent_id = ?1 AND status IN ('running', 'pending')",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![pid], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.flatten().collect()
            };
            for k in kids {
                if k != agent_id && !descendants.contains(&k) {
                    descendants.push(k.clone());
                    frontier.push(k);
                }
            }
        }
    }

    // Signal async + flag atomique pour les boucles bloquantes. Les handles
    // restent enregistrés jusqu'à ce que leurs runners aient effectivement
    // arrêté les processus enfants ; la capacité reflète ainsi le travail réel.
    let abort_token = {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        for d in &descendants {
            if let Some(h) = guard.get(d) {
                h.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
                h.abort.notify_one();
            }
        }
        match guard.get(&agent_id) {
            Some(handle) => {
                handle
                    .cancelled
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                handle.abort.clone()
            }
            None => return Err(format!("agent not found: {agent_id}")),
        }
    };
    // Signal the running task to stop. Idempotent — repeated notifies
    // are a no-op once the task has consumed the first one.
    abort_token.notify_one();

    // UPDATE status='killed' pour la cible + tous les descendants.
    let finished_at = now_ms();
    let mut killed_ids: Vec<String> = Vec::new();
    {
        let conn_mutex = get_conn(&app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        for id in std::iter::once(&agent_id).chain(descendants.iter()) {
            let changed = conn
                .execute(
                    "UPDATE agents
                    SET status = 'killed',
                        finished_at = ?1,
                        error = COALESCE(error, 'killed by user')
                  WHERE id = ?2 AND status IN ('running', 'pending')",
                    params![finished_at, id],
                )
                .map_err(|e| format!("update agents kill: {e}"))?;
            if changed == 1 {
                killed_ids.push(id.clone());
            }
        }
    }

    // Emit only for rows whose terminal-state CAS we actually won.
    for id in &killed_ids {
        persist_and_emit(
            &app,
            &AgentEvent::Error {
                agent_id: id.clone(),
                error: "killed by user".into(),
            },
        )?;
    }
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
                    created_at, finished_at, output, error, execution_profile, isolate,
                    profile_verified, isolation_status, goal_id
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
                    created_at, finished_at, output, error, execution_profile, isolate,
                    profile_verified, isolation_status, goal_id
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
                    created_at, finished_at, output, error, execution_profile, isolate,
                    profile_verified, isolation_status, goal_id
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
        execution_profile: r.get(11)?,
        isolate: r.get(12)?,
        profile_verified: r.get(13)?,
        isolation_status: r.get(14)?,
        goal_id: r.get(15)?,
    })
}

#[cfg(test)]
mod profile_tests {
    use super::*;

    #[test]
    fn legacy_modes_are_authoritative_read_only_profiles() {
        assert_eq!(
            resolve_execution_profile(Some("chat"), Some(policy::ExecutionProfile::FullAccess))
                .unwrap(),
            policy::ExecutionProfile::Chat
        );
        assert_eq!(
            resolve_execution_profile(Some("plan"), Some(policy::ExecutionProfile::FullAccess))
                .unwrap(),
            policy::ExecutionProfile::Plan
        );
    }

    #[test]
    fn agent_defaults_auto_and_full_access_must_be_explicit() {
        assert_eq!(
            resolve_execution_profile(Some("agent"), None).unwrap(),
            policy::ExecutionProfile::Auto
        );
        assert_eq!(
            resolve_execution_profile(Some("agent"), Some(policy::ExecutionProfile::FullAccess))
                .unwrap(),
            policy::ExecutionProfile::FullAccess
        );
        assert_eq!(
            resolve_execution_profile(None, Some(policy::ExecutionProfile::Plan)).unwrap(),
            policy::ExecutionProfile::Plan
        );
        assert_eq!(
            resolve_execution_profile(Some("agent"), Some(policy::ExecutionProfile::Chat)).unwrap(),
            policy::ExecutionProfile::Chat
        );
        assert!(resolve_execution_profile(Some("bogus"), None).is_err());
    }

    #[test]
    fn full_access_requires_the_native_session_grant() {
        assert!(require_profile_grant(policy::ExecutionProfile::FullAccess, false).is_err());
        assert_eq!(
            require_profile_grant(policy::ExecutionProfile::FullAccess, true).unwrap(),
            policy::ExecutionProfile::FullAccess
        );
        assert_eq!(
            require_profile_grant(policy::ExecutionProfile::Auto, false).unwrap(),
            policy::ExecutionProfile::Auto
        );
    }

    #[test]
    fn mutating_agent_rejects_chat_only_but_accepts_native_ollama_tools() {
        assert!(require_agent_loop_capability(
            policy::ExecutionProfile::Auto,
            "ollama",
            "gemma2:9b"
        )
        .is_err());
        assert!(require_agent_loop_capability(
            policy::ExecutionProfile::Auto,
            "ollama",
            "qwen2.5:32b"
        )
        .is_ok());
        assert!(require_agent_loop_capability(
            policy::ExecutionProfile::FullAccess,
            "codex",
            "gpt-5-codex"
        )
        .is_err());
        assert!(require_agent_loop_capability(
            policy::ExecutionProfile::Plan,
            "ollama",
            "gemma2:9b"
        )
        .is_ok());
        assert!(require_agent_loop_capability(
            policy::ExecutionProfile::Auto,
            "custom",
            "tool-model"
        )
        .is_ok());
    }

    #[test]
    fn restart_recovery_frees_hitl_claims_and_marks_isolation_unknown() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agents (
                id TEXT PRIMARY KEY, status TEXT, error TEXT, finished_at INTEGER,
                isolate INTEGER NOT NULL, isolation_status TEXT NOT NULL
             );
             CREATE TABLE agent_interactions (
                interaction_id TEXT PRIMARY KEY, answered_at INTEGER, claim_token TEXT
             );
             INSERT INTO agents VALUES ('a1','running',NULL,NULL,1,'active');
             INSERT INTO agents VALUES ('a2','complete',NULL,10,0,'none');
             INSERT INTO agent_interactions VALUES ('i1',NULL,'stale-token');
             INSERT INTO agent_interactions VALUES ('i2',123,'kept-token');",
        )
        .unwrap();

        let recovered = recover_orphans(&conn, 456).unwrap();
        assert_eq!(
            recovered,
            OrphanRecovery {
                agents: 1,
                interaction_claims: 1,
                goals_paused: 0,
            }
        );
        let agent: (String, i64, String) = conn
            .query_row(
                "SELECT status, finished_at, isolation_status FROM agents WHERE id='a1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(agent, ("error".into(), 456, "unknown".into()));
        let claims: Vec<Option<String>> = {
            let mut stmt = conn
                .prepare("SELECT claim_token FROM agent_interactions ORDER BY interaction_id")
                .unwrap();
            stmt.query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(claims, vec![None, Some("kept-token".into())]);
    }
}
