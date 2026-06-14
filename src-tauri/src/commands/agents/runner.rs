//! Phase 2 — real LLM call driver with tool-use loop.
//!
//! Phase 0 shipped a synthetic emitter. Phase 1 swapped it for a single
//! LLM call. Phase 2 wraps that call in a multi-turn loop where the
//! model can request tool invocations (`fs_read_file`, `fs_write_file`,
//! `fs_list_dir`) that we execute server-side, then feed the results
//! back as a follow-up message. Loop until the model returns content
//! without any tool_calls — that's the final answer the runner persists
//! as the agent's `output`.
//!
//! ## Conversation history shape
//!
//! `ChatMessage { role, content }` from `chat.rs` cannot represent an
//! assistant turn that includes tool_calls or a tool result message
//! (OpenAI's `role: "tool"` with `tool_call_id`, or Anthropic's
//! `content: [{type:"tool_result", ...}]`). We introduce an internal
//! `AgentMessage` enum here and translate it to the right wire format
//! per-provider via `build_openai_messages` / `build_anthropic_messages`.
//! `ChatMessage` stays untouched (shared with `chat_send`).
//!
//! ## Cancellation
//!
//! The entire tool-use loop runs inside one `tokio::select!` against
//! the abort token. If the user clicks "Kill" on the Agents panel
//! between an LLM call and the next tool execution, the select arm
//! fires and we transition to `mark_killed`. Mid-LLM-stream kill works
//! at the SSE chunk boundary (typically 10-50 ms latency).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::params;
use tauri::{AppHandle, Manager};

use super::tools::{execute_tool, ToolCall, ToolResult};
use super::{get_conn, now_ms, persist_and_emit, AgentEvent, AgentHandle};
use crate::commands::chat::{self, AssistantTurn, ChatMessage};

/// Maximum tool-use rounds per agent run. Unifié à 24 depuis le pivot
/// exec-directe (2026-06-10) : TOUT agent peut maintenant exécuter du code,
/// et chaque cycle write→run-test→fix coûte une itération — l'agent a besoin
/// de marge pour voir un échec réel, corriger, relancer. Sur la DERNIÈRE
/// itération on injecte un message "[Shugu system] FINAL iteration" et on
/// force-accepte ce que le modèle produit (même vide) plutôt qu'une erreur
/// "exceeded MAX_ITERATIONS" sans output.
const MAX_ITERATIONS: u32 = 24;

/// Native tools that MUTATE persistent state — removed from the manifest AND
/// refused by the dispatcher in plan mode (read-only). Includes `skill_save`
/// (writes to the shared skills DB → affects all future runs ; de-facto already
/// neutralised in plan mode since it requires a prior exit-0 `run_command`, but
/// we block it explicitly so plan mode never persists anything). MCP tools are
/// not classified (namespaced `mcp__…`, mutation unknown — see manifest filter).
fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "fs_write_file" | "fs_edit" | "fs_delete" | "fs_move" | "run_command" | "skill_save"
    )
}

/// Returned to the model if it invokes a write tool while in plan mode
/// (defense-in-depth — the tool is already absent from the manifest).
const PLAN_BLOCK_MSG: &str =
    "blocked: PLAN MODE is read-only — fs_write_file, fs_edit and run_command are disabled for this turn. Describe the change in your plan instead; the user will switch to Agent mode to execute it.";

/// Max `advisor` consultations per run (par-requête, façon `max_uses` de l'outil
/// officiel). Au-delà, l'appel renvoie une erreur et l'exécuteur continue seul —
/// borne le coût (chaque consultation est une sous-inférence complète).
const MAX_ADVISOR_CALLS: u32 = 6;

/// System prompt du CONSEILLER (sous-inférence sans outils). Recrée le rôle de
/// l'outil advisor officiel d'Anthropic, mais provider-agnostique : un « modèle
/// conseiller » qui voit toute la transcription de l'exécuteur et renvoie un
/// plan/correction de trajectoire concis. (v1 : le conseiller EST le modèle de
/// l'exécuteur — auto-consultation ; un modèle plus fort sera configurable.)
const ADVISOR_SYSTEM_PROMPT: &str = "You are an ADVISOR: a senior reviewer consulted mid-task by a coding agent (the \"executor\"). You see the executor's ENTIRE transcript above — the task, every tool call, every result. The executor has paused to ask for your strategic guidance.\n\nGive a CONCISE plan or course-correction — a focused starting point, not a comprehensive essay (aim for a few hundred words). Be specific to THIS task and what you actually see in the transcript: reference the real files, errors, and decisions.\n- If the executor is just starting: lay out the approach, the main risks, and the order of steps.\n- If it is mid-task or stuck: diagnose what's going wrong and give the next concrete move.\n- If it is about to finish: point out what is missing, unverified, or likely to break.\n\nYou have NO tools and cannot act — output plain text guidance only. The executor will weigh your advice and continue.";

/// Provider config d'un modèle CONSEILLER distinct (v2). Résolu côté TS
/// (`routing.advisorModel`) et passé au runner. `None` ⇒ auto-consultation : le
/// conseiller est le modèle de l'exécuteur (v1). `Some` ⇒ un modèle plus fort
/// conseille (l'idéal « advisor ≥ executor » de l'outil officiel).
#[derive(Clone)]
pub(crate) struct AdvisorConfig {
    pub model: String,
    pub protocol: String,
    pub base_url: String,
    pub api_key: String,
}

/// Max prior conversation turns reloaded into a delegated agent's history.
/// Bounds the token cost (M3 has 1M context, but lighter models don't).
const MAX_HISTORY_MESSAGES: u32 = 30;

/// Recharge les `limit` derniers messages NON supprimés de la conversation et
/// les mappe en `AgentMessage::Text`, en ordre chronologique (ancien→récent).
/// Miroir EXACT du mapping chat-direct (chat-sync.ts) : role "ai" → "assistant",
/// images remplacées par un placeholder (jamais de base64 dans l'historique
/// modèle), messages vides ignorés. DROP le dernier s'il est `user` : c'est le
/// message COURANT, déjà représenté par `task` (potentiellement enrichi du
/// contexte éditeur) — sans ce drop, le message courant apparaîtrait en double.
/// Dégrade silencieusement en `Vec::new()` (zéro régression) sur toute erreur DB.
fn load_conversation_history(app: &AppHandle, conversation_id: &str, limit: u32) -> Vec<AgentMessage> {
    let conn_mutex = match get_conn(app) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let guard = match conn_mutex.lock() {
        Ok(g) => g,
        Err(_) => return Vec::new(),
    };
    // ts DESC + LIMIT = les N plus récents ; on réinverse en ASC ensuite.
    // Tie-break sur `rowid` (ordre d'insertion) : deux messages au même ms ne
    // doivent pas avoir un ordre indéterminé — le plus récemment inséré (= le
    // message courant) doit rester en tête du DESC pour être droppé après.
    let mut stmt = match guard.prepare(
        "SELECT role, text, body, code_text, image FROM messages \
         WHERE conversation_id = ?1 AND deleted_at IS NULL \
         ORDER BY ts DESC, rowid DESC LIMIT ?2",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    type Row = (String, Option<String>, Option<String>, Option<String>, i64);
    let mapped = stmt.query_map(params![conversation_id, limit], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, i64>(4)?,
        ))
    });
    let mut rows: Vec<Row> = match mapped {
        Ok(it) => it.filter_map(|r| r.ok()).collect(),
        Err(_) => return Vec::new(),
    };
    rows.reverse(); // DESC → ASC (ancien → récent)
    // DROP le message courant (dernier, role=user) — déjà passé via `task`.
    if matches!(rows.last(), Some((role, ..)) if role == "user") {
        rows.pop();
    }
    let mut history: Vec<AgentMessage> = rows
        .into_iter()
        .filter_map(|(role, text, body, code_text, image)| {
            let mapped_role = if role == "ai" { "assistant" } else { role.as_str() };
            // Seuls user/assistant sont des tours de dialogue valides.
            if mapped_role != "user" && mapped_role != "assistant" {
                return None;
            }
            let text = text.unwrap_or_default();
            let content = if image == 1 {
                let t = text.trim();
                if t.is_empty() { "[image attached]".to_string() } else { t.to_string() }
            } else {
                let t = text.trim();
                if !t.is_empty() {
                    t.to_string()
                } else {
                    let body = body.unwrap_or_default();
                    let b = body.trim();
                    if !b.is_empty() {
                        b.to_string()
                    } else {
                        code_text.unwrap_or_default().trim().to_string()
                    }
                }
            };
            if content.is_empty() {
                return None;
            }
            Some(AgentMessage::Text { role: mapped_role.to_string(), content })
        })
        .collect();
    // Anthropic exige que le PREMIER message (après hoisting du system) soit
    // `user`. Si la fenêtre de 30 messages démarre sur un tour `assistant` (conv
    // ouverte par un message IA, ou coupe au milieu d'un échange), on retire les
    // tours assistant de tête pour ne jamais produire `[assistant, …]`.
    while matches!(history.first(), Some(AgentMessage::Text { role, .. }) if role == "assistant") {
        history.remove(0);
    }
    history
}

// web_search / web_fetch vivent désormais dans `commands::search` (moteur
// hybride Brave/Tavily + repli DuckDuckGo durci, et récupération de page). Le
// fork async du dispatch (plus bas) route `web_search` et `web_fetch` vers ce
// module via le client reqwest du streaming. Migré ici pour dédupliquer la
// logique réseau et la rendre réutilisable par le chat-direct.
use crate::commands::search;

// ────────────────────────────────────────────────────────────────────
// Internal conversation history shape
// ────────────────────────────────────────────────────────────────────

/// One turn in an agent conversation. Covers the three shapes the
/// multi-turn loop needs to track:
///
///   * `Text` — system / user / assistant text-only messages (maps
///     cleanly to `ChatMessage`).
///   * `AssistantWithTools` — the assistant returned tool_calls. The
///     `content` field may be empty (model invoked tools without
///     commentary) or non-empty (model spoke then called tools).
///   * `ToolResults` — one or more tool execution results, fed back
///     to the LLM as the user-side of the next turn. OpenAI uses
///     `role: "tool"` per result; Anthropic packs all results into a
///     single `role: "user"` message with `content: [tool_result, ...]`.
// `pub(crate)` (was `pub(super)`) so the chat tool loop in `commands::chat`
// reuses the SAME multi-turn history shape + provider builders instead of
// duplicating them (Lot A — Task 9/11, cleanup-on-replace / no-dup policy).
// The variant fields must be `pub` too so `chat.rs` can construct them.
#[derive(Clone)] // cloné par consult_advisor (rejoue la transcription au conseiller)
#[allow(dead_code)] // variants used in match arms but rustc sees only construction
pub(crate) enum AgentMessage {
    Text { role: String, content: String },
    AssistantWithTools { content: String, tool_calls: Vec<ToolCall> },
    ToolResults(Vec<ToolResult>),
    /// Screenshot de l'outil `capture_screen`, ré-injecté comme tour USER
    /// multimodal juste après les tool results — openai-compat n'accepte pas
    /// d'image dans un message `role:"tool"`, et côté Anthropic
    /// `push_coalesced` fusionne légalement ce tour avec le message
    /// tool_result précédent. `data_url` vidée par `prune_user_images`
    /// (anti-bloat) → le builder retombe alors sur un message texte simple.
    UserImage { text: String, data_url: String },
}

// ────────────────────────────────────────────────────────────────────
// Provider-specific message builders
// ────────────────────────────────────────────────────────────────────

/// Normalise une chaîne d'arguments d'appel d'outil en JSON d'OBJET valide.
/// Garde la chaîne telle quelle si elle parse en objet JSON ; sinon (`""`,
/// fragment tronqué, valeur non-objet) renvoie `"{}"`. Évite les 400 des
/// providers stricts (MiniMax) quand on ré-injecte le tour d'appel d'outils.
fn normalize_tool_args(arguments: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(arguments) {
        Ok(v) if v.is_object() => arguments.to_string(),
        _ => "{}".to_string(),
    }
}

/// Translate `AgentMessage` history into OpenAI Chat Completions format
/// (native `assistant.tool_calls` + one `role:"tool"` message per result,
/// each carrying its `tool_call_id`). Lot 3 — now the active builder for the
/// openai/custom agent path via `call_openai_compat_structured`, replacing the
/// former text projection.
pub(crate) fn build_openai_messages(history: &[AgentMessage]) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    for msg in history {
        match msg {
            AgentMessage::Text { role, content } => {
                out.push(serde_json::json!({ "role": role, "content": content }));
            }
            AgentMessage::AssistantWithTools { content, tool_calls } => {
                let tc_json: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            // `arguments` DOIT être une chaîne JSON valide : MiniMax
                            // (et d'autres) rejettent la requête en 400 « invalid
                            // function arguments json string » sinon. Un appel sans
                            // argument streame souvent `""` (ou un fragment malformé)
                            // → on normalise vers un objet JSON valide. L'outil a de
                            // toute façon déjà été exécuté avec ces args (ou `{}`).
                            "function": { "name": tc.name, "arguments": normalize_tool_args(&tc.arguments) }
                        })
                    })
                    .collect();
                out.push(serde_json::json!({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": tc_json,
                }));
            }
            AgentMessage::ToolResults(results) => {
                // OpenAI expects one `role: "tool"` message per result,
                // each with its own tool_call_id pointing at the matching
                // call from the prior assistant turn.
                for r in results {
                    out.push(serde_json::json!({
                        "role": "tool",
                        "tool_call_id": r.id,
                        "content": r.content,
                    }));
                }
            }
            AgentMessage::UserImage { text, data_url } => {
                if data_url.is_empty() {
                    // Image élaguée (prune_user_images) → texte simple.
                    out.push(serde_json::json!({ "role": "user", "content": text }));
                } else {
                    out.push(serde_json::json!({
                        "role": "user",
                        "content": [
                            { "type": "text", "text": text },
                            { "type": "image_url", "image_url": { "url": data_url } }
                        ]
                    }));
                }
            }
        }
    }
    out
}

/// Normalise an Anthropic message `content` field (a string OR an array of
/// content blocks) to a Vec of blocks — used when coalescing same-role turns.
fn value_to_blocks(content: &serde_json::Value) -> Vec<serde_json::Value> {
    match content {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::String(s) => vec![serde_json::json!({ "type": "text", "text": s })],
        _ => Vec::new(),
    }
}

/// Append `blocks` as a `role` turn, MERGING into the previous turn when it has
/// the same role (Anthropic forbids two consecutive same-role messages, and a
/// single user turn may legally mix `tool_result` + `text` blocks).
fn push_coalesced(out: &mut Vec<serde_json::Value>, role: &str, blocks: Vec<serde_json::Value>) {
    if let Some(last) = out.last_mut() {
        if last["role"].as_str() == Some(role) {
            let mut merged = value_to_blocks(&last["content"]);
            merged.extend(blocks);
            last["content"] = serde_json::Value::Array(merged);
            return;
        }
    }
    out.push(serde_json::json!({ "role": role, "content": blocks }));
}

/// Translate `AgentMessage` history into NATIVE Anthropic Messages format:
/// assistant turns carry `tool_use` blocks (with `input` parsed to a JSON
/// OBJECT — Anthropic requires an object, not the raw arg string OpenAI uses);
/// tool results become ONE user message of `tool_result` blocks. Returns
/// `(messages, system)` — system is hoisted to the top-level field (Anthropic's
/// `messages` array has no system role). Consecutive same-role turns are
/// coalesced (the loop appends a system-nudge user message right after a
/// tool_results user message; Anthropic rejects two consecutive user turns).
/// Lot 3 — replaces the former JSON-in-text projection.
pub(crate) fn build_anthropic_native(
    history: &[AgentMessage],
) -> (Vec<serde_json::Value>, Option<String>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<serde_json::Value> = Vec::new();

    for msg in history {
        match msg {
            AgentMessage::Text { role, content } => {
                if role == "system" {
                    system_parts.push(content.clone());
                } else {
                    push_coalesced(
                        &mut out,
                        role,
                        vec![serde_json::json!({ "type": "text", "text": content })],
                    );
                }
            }
            AgentMessage::AssistantWithTools { content, tool_calls } => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !content.trim().is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": content }));
                }
                for tc in tool_calls {
                    // Anthropic `tool_use.input` is a parsed JSON object, NOT the
                    // raw argument string OpenAI uses. Bad/empty args → {} so the
                    // request stays well-formed and the model sees its own error.
                    let input: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or_else(|_| serde_json::json!({}));
                    blocks.push(serde_json::json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": input,
                    }));
                }
                push_coalesced(&mut out, "assistant", blocks);
            }
            AgentMessage::ToolResults(results) => {
                let blocks: Vec<serde_json::Value> = results
                    .iter()
                    .map(|r| {
                        let mut b = serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": r.id,
                            "content": r.content,
                        });
                        if r.is_error {
                            b["is_error"] = serde_json::Value::Bool(true);
                        }
                        b
                    })
                    .collect();
                push_coalesced(&mut out, "user", blocks);
            }
            AgentMessage::UserImage { text, data_url } => {
                let mut blocks = vec![serde_json::json!({ "type": "text", "text": text })];
                // `data:image/jpeg;base64,<b64>` → bloc image natif Anthropic.
                if let Some((media_type, b64)) = data_url
                    .strip_prefix("data:")
                    .and_then(|rest| rest.split_once(";base64,"))
                {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": media_type, "data": b64 }
                    }));
                }
                push_coalesced(&mut out, "user", blocks);
            }
        }
    }

    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n\n"))
    };
    (out, system)
}

// ────────────────────────────────────────────────────────────────────
// Workspace root resolution
// ────────────────────────────────────────────────────────────────────

/// Resolve the workspace root once per loop iteration so all parallel
/// tool calls share the same value. Returns `None` when no workspace
/// is open — the dispatcher then returns an "is_error: true" ToolResult
/// for every call this iteration so the model sees the situation and
/// can ask the user to open a workspace.
pub(crate) fn get_workspace_root(app: &AppHandle) -> Option<PathBuf> {
    let state = app.state::<Mutex<Option<PathBuf>>>();
    let guard = state.lock().ok()?;
    guard.clone()
}

// ────────────────────────────────────────────────────────────────────
// Run task (top-level entry)
// ────────────────────────────────────────────────────────────────────

/// Background task body for an orchestrator agent. Phase 2: runs the
/// multi-turn tool-use loop. The whole loop sits inside one
/// `tokio::select!` against the abort token — any kill at any iteration
/// boundary cleanly transitions to the killed state.
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_agent_task(
    app: AppHandle,
    state: Arc<Mutex<HashMap<String, AgentHandle>>>,
    agent_id: String,
    role: String,
    task: String,
    model: String,
    protocol: Option<String>,
    base_url: Option<String>,
    api_key_opt: Option<String>,
    chat_template_kwargs: Option<serde_json::Value>,
    design_context: Option<String>,
    abort: Arc<tokio::sync::Notify>,
    // Atelier : quand `Some`, l'agent travaille dans CE dossier (temp de
    // création) au lieu du workspace ouvert. `None` = workspace réel.
    workspace_override: Option<PathBuf>,
    system_prompt_override: Option<String>,
    // Mode Plan (sélecteur de chat) : lecture seule. Le manifest d'outils perd
    // fs_write_file/fs_edit/run_command et le dispatcher refuse toute mutation.
    read_only: bool,
    // Mémoire de conversation : quand `Some(id)`, on recharge les tours
    // précédents de CETTE conversation dans l'historique (parité avec le chemin
    // chat-direct). `None` (Atelier/Studio/Grounded) = pas de conversation liée.
    conversation_id: Option<String>,
    // Modèle conseiller distinct pour l'outil `advisor` (v2). `None` ⇒ le
    // conseiller est le modèle de l'exécuteur (auto-consultation).
    advisor: Option<AdvisorConfig>,
) {
    let start = std::time::Instant::now();
    let protocol = protocol.unwrap_or_else(|| "openai".to_string());
    let base_url = base_url.unwrap_or_default();

    // System prompt : l'Atelier passe un override par tâche ; sinon le seed
    // STATIQUE du rôle. (Le Refiner qui faisait évoluer le prompt par
    // « génération » est retiré — plus d'indirection ActiveHarness/generation.)
    let mut system_prompt = system_prompt_override.unwrap_or_else(|| seed_prompt(&role));
    // Mode Plan → on rappelle au modèle qu'il est en lecture seule : explorer +
    // proposer un plan, ne rien écrire ni exécuter. Le filtrage d'outils (plus
    // bas, dans tool_use_loop) est l'enforcement DUR ; ceci aligne juste le
    // comportement pour qu'il ne PROMETTE pas d'écrire ce qu'il ne peut pas.
    if read_only {
        system_prompt.push_str(PLAN_MODE_PROMPT);
    }
    // Phase A (Design Studio) — when the Studio passes a design-system context,
    // append GENERATION MODE so the agent writes a complete styled project to
    // `.shugu-forge/preview/` (served live by the preview:// protocol). Chat
    // delegation never sets `design_context`, so the normal path is unchanged.
    if let Some(ctx) = design_context.as_deref() {
        if !ctx.trim().is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(GENERATION_MODE_PROMPT);
            system_prompt.push_str("\n\nGENERATION CONTEXT (apply the design system and/or colour direction below, honour the user preferences, and select the most relevant design skill):\n");
            system_prompt.push_str(ctx);
        }
    }

    // Emit the initial Message events for the audit trail.
    let _ = persist_and_emit(
        &app,
        &AgentEvent::Message {
            agent_id: agent_id.clone(),
            role: "system".to_string(),
            content: system_prompt.clone(),
        },
    );
    let _ = persist_and_emit(
        &app,
        &AgentEvent::Message {
            agent_id: agent_id.clone(),
            role: "user".to_string(),
            content: task.clone(),
        },
    );

    let api_key = match chat::resolve_key(&protocol, &api_key_opt) {
        Ok(k) => k,
        Err(e) => {
            finish_error(&app, &state, &agent_id, &e);
            return;
        }
    };

    // Seed the agent's conversation history with the system prompt, THEN the
    // prior turns of this conversation (so the agent has memory of the dialogue
    // — parité avec le chemin chat-direct), THEN the current user task.
    // Subsequent turns (assistant responses + tool results) are appended in the
    // loop. Sans le bloc prior, chaque message délégué repartait de zéro
    // (l'agent « n'avait aucun souvenir des tours précédents »).
    let mut history: Vec<AgentMessage> = vec![AgentMessage::Text {
        role: "system".to_string(),
        content: system_prompt,
    }];
    if let Some(cid) = conversation_id.as_deref() {
        let prior = load_conversation_history(&app, cid, MAX_HISTORY_MESSAGES);
        history.extend(prior);
    }
    history.push(AgentMessage::Text {
        role: "user".to_string(),
        content: task,
    });

    // Client borné (lot timeouts) : connect 15 s + 300 s de silence max entre
    // deux chunks — un provider mort ne pend plus l'agent indéfiniment.
    let client = match chat::streaming_client() {
        Ok(c) => c,
        Err(e) => {
            finish_error(&app, &state, &agent_id, &e);
            return;
        }
    };

    // Whole loop racing the abort token. Inside, the multi-turn loop
    // body (`tool_use_loop`) calls the LLM, executes tools, appends to
    // history, repeats. The abort branch wins if the user kills the
    // agent mid-flight.
    let mut loop_metrics = LoopMetrics::default();
    let loop_result = tokio::select! {
        r = tool_use_loop(
            &app,
            &client,
            &protocol,
            &base_url,
            &model,
            &api_key,
            &chat_template_kwargs,
            &agent_id,
            &role,
            &mut history,
            &mut loop_metrics,
            workspace_override,
            read_only,
            advisor.as_ref(),
        ) => r,
        _ = abort.notified() => {
            mark_killed(&app, &agent_id);
            return;
        }
    };

    let ms = start.elapsed().as_millis() as u64;

    // Télémétrie par run (succès / blocage / itérations). Écrit pour succès ET
    // échec ; un abort (killed) sort plus tôt et n'est pas scoré.
    record_outcome(&app, &agent_id, &role, loop_result.is_ok(), &loop_metrics);

    match loop_result {
        Ok((output, reasoning)) => {
            if let Ok(conn_mutex) = get_conn(&app) {
                if let Ok(conn) = conn_mutex.lock() {
                    let _ = conn.execute(
                        "UPDATE agents
                            SET status = 'complete',
                                finished_at = ?1,
                                output = ?2
                          WHERE id = ?3",
                        params![now_ms(), output, agent_id],
                    );
                }
            }
            let _ = persist_and_emit(
                &app,
                &AgentEvent::Complete {
                    agent_id: agent_id.clone(),
                    output,
                    tokens_used: None,
                    reasoning: if reasoning.trim().is_empty() { None } else { Some(reasoning) },
                    ms,
                },
            );
            if let Ok(mut g) = state.lock() {
                g.remove(&agent_id);
            }
        }
        Err(e) => {
            finish_error(&app, &state, &agent_id, &e);
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Tool-use loop (the heart of Phase 2)
// ────────────────────────────────────────────────────────────────────

/// Per-run loop metrics, filled in-place by `tool_use_loop` and recorded
/// against the run's `agent_outcomes` row (Continual Harness P1). `stuck_reason`
/// keeps the FIRST stall signature detected; in lot 1 it is purely
/// observational, in P2 it becomes the trigger for harness evolution.
#[derive(Default)]
pub(super) struct LoopMetrics {
    pub(super) iterations: u32,
    pub(super) tool_errors: u32,
    pub(super) stuck_reason: Option<String>,
}

/// Multi-turn loop body. Returns the final answer text when the LLM
/// produces a turn without tool_calls. Returns Err when the iteration
/// budget is exhausted or any underlying call fails.
#[allow(clippy::too_many_arguments)]
pub(super) async fn tool_use_loop(
    app: &AppHandle,
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    agent_id: &str,
    role: &str,
    history: &mut Vec<AgentMessage>,
    metrics: &mut LoopMetrics,
    // When `Some`, tool calls resolve against THIS root instead of the global
    // open workspace (the Atelier's throwaway creation dir). `None` = the
    // real open workspace.
    workspace_override: Option<PathBuf>,
    // Plan mode : lecture seule. Retire les outils mutants du manifest envoyé au
    // modèle ET refuse leur exécution si le modèle les invoque quand même.
    read_only: bool,
    // Modèle conseiller distinct pour l'outil `advisor` (v2). `None` ⇒ le
    // conseiller est le modèle de l'exécuteur (auto-consultation).
    advisor: Option<&AdvisorConfig>,
) -> Result<(String, String), String> {
    // Stall-detection state: repeated identical tool-call signatures and
    // consecutive tool-error rounds are the two cheap "stuck" signals, recorded
    // as telemetry on `metrics.stuck_reason`; budget exhaustion is handled in the
    // `last_iteration` branch.
    let mut last_sig: Option<String> = None;
    let mut repeat_count: u32 = 0;
    let mut err_streak: u32 = 0;
    // Consultations advisor consommées ce run (cap MAX_ADVISOR_CALLS).
    let mut advisor_calls: u32 = 0;
    // Iteration budget — unified now that every agent can exec (each
    // write→run-test→fix cycle costs one iteration).
    let budget = MAX_ITERATIONS;
    let mut iteration: u32 = 0;

    // Load this role's learned skills (Voyager/Hermes) into context, right after
    // the system prompt — so the agent applies what it has already figured out
    // instead of re-deriving it. No-op when the role has no skills yet. This is
    // the reuse half of skill-learning; `skill_save` is the capture half.
    let skills_block = super::skills::skills_prompt_block(app, role);
    if !skills_block.is_empty() {
        let pos = history.len().min(1);
        history.insert(
            pos,
            AgentMessage::Text {
                role: "system".to_string(),
                content: skills_block,
            },
        );
    }

    // S3 — Closed-loop lesson injection: retrieve validated past-run reviews
    // for tasks semantically similar to this one and prepend them to context.
    // Injected AFTER skills (position 2) so both blocks ride behind the system
    // prompt without displacing each other. Degrades silently on any error.
    let task_text: String = history
        .iter()
        .find_map(|m| match m {
            AgentMessage::Text { role: r, content } if r.as_str() == "user" => {
                Some(content.clone())
            }
            _ => None,
        })
        .unwrap_or_default();
    let (lessons_block, lessons_count) =
        super::lessons::lessons_prompt_block(app, role, &task_text);
    if !lessons_block.is_empty() {
        // Insérer AVANT le message user (comme le bloc skills) : un message
        // role="system" placé APRÈS un message user est rejeté par Anthropic.
        let pos = history.len().min(1);
        history.insert(
            pos,
            AgentMessage::Text {
                role: "system".to_string(),
                content: lessons_block,
            },
        );
        let _ = persist_and_emit(
            app,
            &AgentEvent::LessonsInjected {
                agent_id: agent_id.to_string(),
                role: role.to_string(),
                count: lessons_count,
            },
        );
    }

    // Env-verified skill gate: `run_command` writes its exit code here; the
    // `skill_save` tool refuses unless the LAST run was exit 0. A skill is thus
    // only ever born from a test the REAL environment confirmed — never an LLM
    // opinion. Sentinel i64::MIN = "no command run yet". Shared (Arc) into
    // each parallel tool task.
    let last_exec_exit = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(i64::MIN));

    // Lot C — MCP : assemble the tools manifest ONCE per run (not per iteration).
    // `enabled_tools_json` does real I/O — it connects to each ENABLED MCP server
    // and lists its tools — so we pay that cost a single time. The merged array is
    // `native tools (tools_json_*) ++ MCP tools (enabled servers)`, rendered for
    // THIS protocol. With no enabled server, `enabled_tools_json` returns `[]` and
    // the array is byte-identical to the native default — the no-MCP path is
    // unchanged. `None` is threaded for the `ollama` branch (which ignores tools).
    let agent_tools: Option<serde_json::Value> = if protocol == "ollama" {
        None
    } else {
        let mut arr = if protocol == "anthropic" {
            super::tools::tools_json_anthropic()
        } else {
            super::tools::tools_json_openai()
        };
        let mgr = app.state::<crate::commands::mcp::McpManager>();
        let mcp_tools = crate::commands::mcp::enabled_tools_json(app, &mgr, protocol).await;
        if let Some(a) = arr.as_array_mut() {
            a.extend(mcp_tools);
        }
        // Mode Plan (lecture seule) : retire les outils NATIFS mutants du manifest
        // — le modèle ne les voit pas, donc ne les planifie pas. Enforcement DUR
        // doublé d'une garde au dispatch (plus bas). NB : on ne classe pas les
        // outils MCP (noms namespacés `mcp__…`, mutation inconnue) ; un MCP en
        // écriture resterait visible — limite assumée du v1 (le plan part du
        // cockpit où aucun MCP mutant n'est branché par défaut).
        if read_only {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| {
                    let name = t["name"].as_str().or_else(|| t["function"]["name"].as_str());
                    !name.is_some_and(is_write_tool)
                });
            }
        }
        // Gate vie privée : `agents.allowScreenCapture = "false"` retire
        // l'outil de capture d'écran du manifest (défaut ON — clé absente ou
        // toute autre valeur laisse l'outil). Advisory : le réglage gouverne
        // ce que le modèle VOIT, pas le dispatcher.
        if crate::commands::mcp::read_setting(app, "agents.allowScreenCapture").as_deref()
            == Some("false")
        {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| {
                    let name = t["name"].as_str().or_else(|| t["function"]["name"].as_str());
                    name != Some("capture_screen")
                });
            }
        }
        // Recherche NATIVE du provider : si le réglage `search.preferNative` est
        // ON (défaut) et que le modèle a sa propre recherche serveur, on
        // REMPLACE notre `web_search` client par l'outil serveur du provider —
        // le modèle exécute la recherche lui-même (résultats frais + citations).
        // On GARDE `web_fetch` client pour lire les pages (hybride sûr). Le
        // parseur SSE abandonne déjà en silence les blocs serveur, donc aucun
        // changement de parsing. Gate conservateur (cf. search.rs) → jamais de
        // 400 sur un modèle incapable ; sinon notre recherche client reste.
        let prefer_native = crate::commands::mcp::read_setting(app, "search.preferNative")
            .as_deref()
            != Some("false");
        if prefer_native
            && protocol == "anthropic"
            && search::model_supports_native_search("anthropic", &model)
        {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| t["name"].as_str() != Some("web_search"));
                a.extend(search::anthropic_server_web_tools());
            }
        }
        Some(arr)
    };

    while iteration < budget {
        metrics.iterations = iteration + 1;
        // ── 0. Inject "approaching budget" nudge messages — aide les
        //       modèles moins capables (DeepSeek V4 Flash, Mistral 7B…)
        //       à converger vers une réponse au lieu de tool-call à
        //       l'infini. Le pénultième round avertit, le dernier round
        //       FORCE la réponse en texte.
        let last_iteration = iteration == budget - 1;
        if iteration + 2 == budget {
            history.push(AgentMessage::Text {
                role: "user".to_string(),
                content: format!(
                    "[Shugu system] You've used {} of {} tool-use iterations. Plan to produce the final answer in 1-2 more rounds — don't keep exploring indefinitely.",
                    iteration, budget,
                ),
            });
        } else if last_iteration {
            history.push(AgentMessage::Text {
                role: "user".to_string(),
                content: "[Shugu system] This is the FINAL iteration. Do NOT call any more tools. Produce the final answer in plain text, synthesizing everything you've learned so far. Even partial findings are valuable — the user needs SOMETHING from you.".to_string(),
            });
        }

        // ── 1. Call the LLM with the current history + tools manifest ──
        let (turn, reasoning) =
            call_agent_llm_with_tools(app, client, protocol, base_url, model, history, api_key, chat_template_kwargs, agent_id, &agent_tools).await?;

        // ── 2. Persist Message event for this assistant turn ───────────
        let _ = persist_and_emit(
            app,
            &AgentEvent::Message {
                agent_id: agent_id.to_string(),
                role: "assistant".to_string(),
                content: turn.content.clone(),
            },
        );

        // ── 3. No tool_calls = final answer ────────────────────────────
        //    PLUS, sur la dernière itération, on force-accept ce que le
        //    modèle produit, même s'il a tenté plus de tool calls. Mieux
        //    vaut un answer partiel qu'une erreur "exceeded iterations".
        if turn.tool_calls.is_empty() {
            return Ok((turn.content, reasoning));
        }
        if last_iteration {
            // Budget exhausted with the model still wanting tools = stuck.
            metrics
                .stuck_reason
                .get_or_insert_with(|| "max_iterations".to_string());
            let content = if turn.content.trim().is_empty() {
                format!(
                    "⚠ L'orchestrateur a épuisé son budget ({MAX_ITERATIONS} itérations) en tool-calls sans produire de réponse. \
                     Essaye un modèle plus capable (Claude Sonnet, DeepSeek V4 Pro, GPT-5…) dans Settings → Connections → Routing, \
                     ou reformule ta demande de manière plus ciblée."
                )
            } else {
                turn.content
            };
            return Ok((content, reasoning));
        }

        // Stall signal #1 — same tool-call signature repeated across rounds.
        let sig = turn
            .tool_calls
            .iter()
            .map(|tc| format!("{}:{}", tc.name, tc.arguments))
            .collect::<Vec<_>>()
            .join("|");
        if last_sig.as_deref() == Some(sig.as_str()) {
            repeat_count += 1;
        } else {
            repeat_count = 0;
            last_sig = Some(sig);
        }
        if repeat_count >= 2 {
            metrics
                .stuck_reason
                .get_or_insert_with(|| "repeat".to_string());
        }

        // ── 4. Emit ToolCall events BEFORE executing — gives the UI a
        //       chance to render "this tool is about to fire" even if
        //       the execution is fast. Args are emitted as parsed JSON
        //       so the panel renders pretty.
        for tc in &turn.tool_calls {
            let args_value: serde_json::Value =
                serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
            let _ = persist_and_emit(
                app,
                &AgentEvent::ToolCall {
                    agent_id: agent_id.to_string(),
                    tool_call_id: tc.id.clone(),
                    tool: tc.name.clone(),
                    args: args_value,
                },
            );
        }

        // ── 5. Resolve workspace + execute tools ───────────────────────
        let workspace_root = workspace_override
            .as_ref()
            .cloned()
            .or_else(|| get_workspace_root(app));

        // Lot C — MCP routing. MCP tools (`mcp__server__tool`) are executed via
        // `mcp::mcp_execute`, which is ASYNC and CANNOT run inside the sync
        // `spawn_blocking` closure used for the native fs tools. So when at least
        // ONE call this round is an MCP tool, we drop to a SEQUENTIAL path that
        // handles both kinds in their original order (the order matters: OpenAI
        // pairs each result to its `tool_call_id`, Anthropic batches them but all
        // ids must be present). Simplicity over parallelism here — the plan
        // explicitly blesses sequential-when-any-MCP. MCP tools act OUTSIDE the
        // workspace, so they run even when no workspace is open (routed BEFORE the
        // workspace-root gate). When NO call is MCP, the original parallel block
        // runs VERBATIM → the no-MCP hot path (and its tests) is unchanged.
        // MCP ET web_search ont besoin d'I/O réseau ASYNC (impossible dans le
        // spawn_blocking sync des outils fs natifs) → quand au moins un appel de
        // ce tour en a besoin, on bascule sur le chemin SÉQUENTIEL qui gère les
        // deux genres dans l'ordre. Sans aucun appel async, le bloc parallèle
        // tourne VERBATIM (hot path no-MCP inchangé).
        let any_async = turn
            .tool_calls
            .iter()
            .any(|tc| {
                tc.name.starts_with("mcp__")
                    || tc.name == "web_search"
                    || tc.name == "web_fetch"
                    || tc.name == "advisor"
            });

        let results: Vec<ToolResult> = if any_async {
            let mgr = app.state::<crate::commands::mcp::McpManager>();
            let mut acc: Vec<ToolResult> = Vec::with_capacity(turn.tool_calls.len());
            for tc in &turn.tool_calls {
                if tc.name == "web_search" {
                    // Recherche web async via le client reqwest (Brave/Tavily si
                    // clé, sinon DuckDuckGo durci). Read-only → dispo en Plan.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let query = args["query"].as_str().unwrap_or("").trim();
                    let max = args["max_results"].as_u64().unwrap_or(5).clamp(1, 10) as usize;
                    let (content, is_error) = if query.is_empty() {
                        ("web_search: missing required field: query".to_string(), true)
                    } else {
                        search::web_search(client, query, max).await
                    };
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error,
                        content,
                    });
                } else if tc.name == "web_fetch" {
                    // Récupération de page async (HTML→texte). Read-only → Plan OK.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let url = args["url"].as_str().unwrap_or("").trim();
                    let max_chars =
                        args["max_chars"].as_u64().unwrap_or(48_000).clamp(500, 200_000) as usize;
                    let (content, is_error) = if url.is_empty() {
                        ("web_fetch: missing required field: url".to_string(), true)
                    } else {
                        search::web_fetch(client, url, max_chars).await
                    };
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error,
                        content,
                    });
                } else if tc.name == "advisor" {
                    // Outil advisor (façon Claude Code, provider-agnostique) :
                    // sous-inférence sur le modèle conseiller avec toute la
                    // transcription. Read-only → dispo aussi en mode Plan. Borné
                    // par MAX_ADVISOR_CALLS pour le coût.
                    advisor_calls += 1;
                    let (content, is_error) = if advisor_calls > MAX_ADVISOR_CALLS {
                        (
                            format!(
                                "advisor: max_uses_exceeded ({MAX_ADVISOR_CALLS} consultations per run) — proceed with your own judgement."
                            ),
                            true,
                        )
                    } else {
                        // v2 : modèle conseiller distinct si configuré, sinon
                        // auto-consultation (le modèle de l'exécuteur).
                        let (a_proto, a_base, a_model, a_key) = match advisor {
                            Some(a) => (a.protocol.as_str(), a.base_url.as_str(), a.model.as_str(), a.api_key.as_str()),
                            None => (protocol, base_url, model, api_key),
                        };
                        consult_advisor(
                            client, a_proto, a_base, a_model, a_key, chat_template_kwargs, history,
                        )
                        .await
                    };
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error,
                        content,
                    });
                } else if tc.name.starts_with("mcp__") {
                    // MCP tool: async dispatch, no workspace needed. Parse args
                    // like the native path (runner.rs ToolCall events) — bad/empty
                    // args become `{}` so the call stays well-formed.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let (content, is_error) =
                        crate::commands::mcp::mcp_execute(app, &mgr, &tc.name, &args).await;
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error,
                        content,
                    });
                } else if read_only && is_write_tool(&tc.name) {
                    // Plan mode : outil mutant refusé (defense-in-depth — déjà
                    // hors manifest, mais M3 peut l'émettre en texte).
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content: PLAN_BLOCK_MSG.to_string(),
                    });
                } else if let Some(root) = workspace_root.as_ref() {
                    // Native fs tool: sync dispatch on a blocking thread, same as
                    // the parallel path but awaited one at a time.
                    let tc_clone = tc.clone();
                    let fallback_id = tc_clone.id.clone();
                    let fallback_name = tc_clone.name.clone();
                    let root_clone = Arc::new(root.clone());
                    let app_clone = app.clone();
                    let role_clone = role.to_string();
                    let last_exec_clone = last_exec_exit.clone();
                    let agent_id_clone = agent_id.to_string();
                    let r = tokio::task::spawn_blocking(move || {
                        execute_tool(&tc_clone, &root_clone, &app_clone, &role_clone, &last_exec_clone, &agent_id_clone)
                    })
                    .await
                    .unwrap_or_else(|join_err| ToolResult {
                        id: fallback_id,
                        name: fallback_name,
                        is_error: true,
                        content: format!("tool execution panicked: {join_err}"),
                    });
                    acc.push(r);
                } else {
                    // Native tool but no workspace open — same clean error as the
                    // parallel else-branch below.
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content: "no workspace open".to_string(),
                    });
                }
            }
            acc
        } else if let Some(root) = workspace_root {
            let root_arc = Arc::new(root);
            let futures = turn.tool_calls.iter().map(|tc| {
                let tc_clone = tc.clone();
                // Capture id + name BEFORE moving tc_clone into the
                // spawn_blocking closure — we'll need them again in the
                // fallback path if the blocking task panics (rare but
                // possible if std::fs hits a corrupt FS). Without these
                // captures the unwrap_or_else closure can't construct
                // a ToolResult because tc_clone has already moved.
                let fallback_id = tc_clone.id.clone();
                let fallback_name = tc_clone.name.clone();
                // Plan mode : refuse les outils mutants (defense-in-depth).
                let blocked = read_only && is_write_tool(&tc_clone.name);
                let root_clone = root_arc.clone();
                let app_clone = app.clone();
                let role_clone = role.to_string();
                let last_exec_clone = last_exec_exit.clone();
                let agent_id_clone = agent_id.to_string();
                async move {
                    if blocked {
                        return ToolResult {
                            id: fallback_id,
                            name: fallback_name,
                            is_error: true,
                            content: PLAN_BLOCK_MSG.to_string(),
                        };
                    }
                    // `spawn_blocking` because the fs ops are synchronous —
                    // running them on the async runtime thread would starve
                    // other tokio tasks. `unwrap_or_else` defends against
                    // a JoinError (panic in the closure); `execute_tool`
                    // itself never panics for normal fs failures.
                    tokio::task::spawn_blocking(move || {
                        execute_tool(&tc_clone, &root_clone, &app_clone, &role_clone, &last_exec_clone, &agent_id_clone)
                    })
                        .await
                        .unwrap_or_else(|join_err| ToolResult {
                            id: fallback_id,
                            name: fallback_name,
                            is_error: true,
                            content: format!("tool execution panicked: {join_err}"),
                        })
                }
            });
            futures_util::future::join_all(futures).await
        } else {
            // No workspace open — surface as a clean ToolResult per call
            // so the LLM sees the situation in the next turn and can
            // ask the user to open a workspace.
            turn.tool_calls
                .iter()
                .map(|tc| ToolResult {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    is_error: true,
                    content: "no workspace open".to_string(),
                })
                .collect()
        };

        // ── 6. Persist ToolResult events ───────────────────────────────
        for r in &results {
            let (result_val, error_val) = if r.is_error {
                (serde_json::json!(null), Some(r.content.clone()))
            } else {
                (serde_json::json!(r.content), None)
            };
            let _ = persist_and_emit(
                app,
                &AgentEvent::ToolResult {
                    agent_id: agent_id.to_string(),
                    tool_call_id: r.id.clone(),
                    result: result_val,
                    error: error_val,
                },
            );
        }

        // Stall signal #2 — consecutive rounds where at least one tool errored.
        let round_errors = results.iter().filter(|r| r.is_error).count() as u32;
        metrics.tool_errors += round_errors;
        if round_errors > 0 {
            err_streak += 1;
        } else {
            err_streak = 0;
        }
        if err_streak >= 2 {
            metrics
                .stuck_reason
                .get_or_insert_with(|| "tool_errors".to_string());
        }

        // Skill captured — emit SkillLearned for each `skill_save` the gate
        // ACCEPTED (env-verified: the last run_command exited 0), so the chat UI
        // shows the inline "🎓 appris" badge. A surfaced skill was confirmed by a
        // real passing test, not an LLM opinion. Done here (loop has agent_id +
        // role) while `turn.tool_calls` is still in scope, before it moves below.
        for tc in &turn.tool_calls {
            if tc.name != "skill_save" {
                continue;
            }
            let accepted = results.iter().any(|r| r.id == tc.id && !r.is_error);
            if !accepted {
                continue;
            }
            if let Some(name) = serde_json::from_str::<serde_json::Value>(&tc.arguments)
                .ok()
                .and_then(|v| {
                    v.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                })
            {
                let _ = persist_and_emit(
                    app,
                    &AgentEvent::SkillLearned {
                        agent_id: agent_id.to_string(),
                        role: role.to_string(),
                        name,
                        source: "agent".to_string(),
                    },
                );
            }
        }

        // Vérification visuelle : un résultat `SCREENSHOT_SAVED:<path>` veut
        // dire que l'agent vient de capturer l'écran (outil capture_screen).
        // L'image ne peut pas voyager dans un message role:"tool" → on la
        // ré-injecte comme tour USER multimodal juste après les tool results.
        let screenshot_paths: Vec<String> = results
            .iter()
            .filter(|r| !r.is_error)
            .filter_map(|r| r.content.strip_prefix("SCREENSHOT_SAVED:").map(str::to_string))
            .collect();

        // ── 7. Append to history for the next iteration ────────────────
        history.push(AgentMessage::AssistantWithTools {
            content: turn.content,
            tool_calls: turn.tool_calls,
        });
        history.push(AgentMessage::ToolResults(results));

        for path in screenshot_paths {
            match std::fs::read(&path) {
                Ok(bytes) => {
                    use base64::Engine as _;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    history.push(AgentMessage::UserImage {
                        text: "[Shugu system] Screenshot captured — attached below. LOOK at it: \
                               does the rendered UI match what you intended? State what you \
                               observe before continuing."
                            .to_string(),
                        data_url: format!("data:image/jpeg;base64,{b64}"),
                    });
                }
                Err(e) => {
                    history.push(AgentMessage::Text {
                        role: "user".to_string(),
                        content: format!("[Shugu system] screenshot read failed ({path}): {e}"),
                    });
                }
            }
        }
        // Anti-bloat contexte : seules les 2 dernières captures restent en
        // image (~400-600 Ko base64 chacune) ; les plus vieilles redeviennent
        // du texte.
        prune_user_images(history, 2);

        iteration += 1;
    }

    Err(format!(
        "agent exceeded MAX_ITERATIONS ({MAX_ITERATIONS}) — unreachable in practice (cf. last_iteration force-return)"
    ))
}

/// Anti-bloat : vide la `data_url` des screenshots les plus anciens en ne
/// gardant que les `keep` derniers en image. Le texte reste (avec une note de
/// retrait) pour que le modèle sache qu'une capture a existé à ce tour.
fn prune_user_images(history: &mut [AgentMessage], keep: usize) {
    let idxs: Vec<usize> = history
        .iter()
        .enumerate()
        .filter_map(|(i, m)| match m {
            AgentMessage::UserImage { data_url, .. } if !data_url.is_empty() => Some(i),
            _ => None,
        })
        .collect();
    if idxs.len() <= keep {
        return;
    }
    for &i in &idxs[..idxs.len() - keep] {
        if let AgentMessage::UserImage { text, data_url } = &mut history[i] {
            data_url.clear();
            text.push_str("\n[ancien screenshot retiré du contexte]");
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Per-iteration LLM dispatch
// ────────────────────────────────────────────────────────────────────

/// Call the LLM for one tool-use iteration. Dispatches to the protocol
/// helper, supplying an `on_chunk` callback that emits AgentEvent::Delta
/// for content + reasoning (Tool-call deltas are silently consumed — the
/// authoritative ToolCall event is emitted post-stream, after the
/// accumulator has produced complete calls).
///
/// Always passes `with_tools: true` — the runner is only called from the
/// agent path. The helpers handle the request body shaping.
#[allow(clippy::too_many_arguments)]
async fn call_agent_llm_with_tools(
    app: &AppHandle,
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    history: &[AgentMessage],
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    agent_id: &str,
    // Lot C — merged tools manifest (native ++ enabled MCP) for THIS protocol,
    // assembled once per run by the caller. `None` only for the `ollama` branch
    // (which ignores tools). Passed through to the structured helpers, replacing
    // the former hard-coded `tools: None` (= native-default) so MCP tools reach
    // the model's request body.
    tools: &Option<serde_json::Value>,
) -> Result<(AssistantTurn, String), String> {
    // Live streaming restauré post-migration TanStack (2026-05-17).
    //
    // L'ancien bug (cascade de re-renders → freeze WebView2) venait du
    // Zustand store custom + applyEvent qui faisait un set() par token.
    // Avec TanStack, le listener côté frontend fait `setQueryData` partiel
    // sur la queryKey du transcript (pas un invalidate → pas de refetch
    // SQL). React 18 batche les updates dans une frame. Le coût est
    // borné même à 30+ tokens/seconde.
    //
    // On droppe encore `tool_call_delta` et `tool_use_block` (fragments
    // de JSON tool-call qu'on assemble côté Rust via ToolCallAccumulator
    // — non utile en live au frontend). Seuls `content` et `reasoning`
    // sont émis comme Delta events.
    let app_for_chunks = app.clone();
    let aid = agent_id.to_string();
    // Accumulate reasoning chunks (hot-path-safe: one push_str per chunk) so the
    // final turn's thinking can ride on the durable Complete event. Arc<Mutex>
    // (not &mut) because the closure lives across the streaming .await and must
    // be Send. The live Delta emit below is unchanged.
    let reasoning_acc = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let reasoning_for_chunks = reasoning_acc.clone();
    let mut on_chunk = move |kind: &str, chunk: &str| {
        match kind {
            "tool_call_delta" | "tool_use_block" => {
                // Fragments tool-call — assemblés par ToolCallAccumulator
                // côté Rust, émis comme un seul ToolCall event quand
                // l'accumulateur termine. Pas besoin live au frontend.
            }
            _ => {
                let delta_kind = if kind == "reasoning" {
                    if let Ok(mut g) = reasoning_for_chunks.lock() {
                        g.push_str(chunk);
                    }
                    "reasoning".to_string()
                } else {
                    "content".to_string()
                };
                let _ = persist_and_emit(
                    &app_for_chunks,
                    &AgentEvent::Delta {
                        agent_id: aid.clone(),
                        chunk: chunk.to_string(),
                        delta_kind,
                    },
                );
            }
        }
    };

    let turn = match protocol {
        "anthropic" => {
            // Lot 3 — native Anthropic multi-turn: tool_use / tool_result
            // content blocks (was: tool_calls serialized into assistant text).
            let (messages, system) = build_anthropic_native(history);
            chat::call_anthropic_structured(
                client, base_url, model, messages, system, api_key,
                /* with_tools */ true,
                /* tools (native ++ enabled MCP) */ tools.clone(),
                /* abort */ None,
                &mut on_chunk,
            )
            .await
        }
        "openai" | "custom" => {
            // Lot 3 — native OpenAI multi-turn: assistant.tool_calls + per-result
            // role:"tool" messages with tool_call_id (was: text projection).
            let messages = build_openai_messages(history);
            chat::call_openai_compat_structured(
                client,
                base_url,
                model,
                messages,
                api_key,
                protocol,
                chat_template_kwargs,
                /* with_tools */ true,
                /* tools (native ++ enabled MCP) */ tools.clone(),
                /* abort */ None,
                &mut on_chunk,
            )
            .await
        }
        "ollama" => {
            // Ollama tool-use is model-specific and not handled in Phase 2.
            // We pass the text projection so the agent at least gets a
            // chat-shaped response, but it won't be able to actually invoke
            // tools. The tool_use_loop will see `tool_calls.is_empty()` and
            // exit on the first iteration with whatever Ollama produced.
            let messages: Vec<ChatMessage> = history
                .iter()
                .filter_map(|m| match m {
                    AgentMessage::Text { role, content } => Some(ChatMessage {
                        role: role.clone(),
                        content: content.clone(),
                    }),
                    _ => None,
                })
                .collect();
            chat::call_ollama(client, base_url, model, &messages, None, &mut on_chunk).await
        }
        other => Err(format!("unsupported protocol for agent: {other}")),
    }?;
    let reasoning = reasoning_acc.lock().map(|g| g.clone()).unwrap_or_default();
    Ok((turn, reasoning))
}

/// Sous-inférence du CONSEILLER (outil `advisor`). Recrée le mécanisme de l'outil
/// advisor officiel d'Anthropic, mais PROVIDER-AGNOSTIQUE : on rejoue la
/// transcription de l'exécuteur à un modèle conseiller (v1 : le même modèle),
/// précédée du system prompt advisor, SANS outils, et on renvoie son texte comme
/// conseil. Dégrade en `(message, is_error=true)` sur échec — l'exécuteur continue.
async fn consult_advisor(
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    history: &[AgentMessage],
) -> (String, bool) {
    // Vue du conseiller : son system prompt, puis la conversation de l'exécuteur
    // SANS ses messages role="system" (seed/skills/lessons) — sinon ils seraient
    // hoistés dans le system param et noieraient l'instruction advisor. On garde
    // tous les tours user/assistant/tool pour qu'il voie le travail réel.
    let mut advisor_history: Vec<AgentMessage> = Vec::with_capacity(history.len() + 1);
    advisor_history.push(AgentMessage::Text {
        role: "system".to_string(),
        content: ADVISOR_SYSTEM_PROMPT.to_string(),
    });
    for m in history {
        // Saute les messages role="system" de l'exécuteur (seed/skills/lessons).
        if let AgentMessage::Text { role, .. } = m {
            if role == "system" {
                continue;
            }
        }
        advisor_history.push(m.clone());
    }

    // Garde-fou : si rien d'autre que le system advisor (transcript 100% system),
    // l'API rejetterait un `messages` vide (400). On renvoie un message clair
    // plutôt qu'une erreur opaque. (En pratique le user(task) est toujours là.)
    if advisor_history.len() <= 1 {
        return (
            "advisor: no conversation turns yet — call advisor after at least one step.".to_string(),
            true,
        );
    }

    // Pas de streaming live pour le conseiller : la sortie arrive en un bloc.
    let mut sink = |_kind: &str, _chunk: &str| {};

    let turn = match protocol {
        "anthropic" => {
            let (messages, system) = build_anthropic_native(&advisor_history);
            chat::call_anthropic_structured(
                client, base_url, model, messages, system, api_key,
                /* with_tools */ false,
                /* tools */ None,
                /* abort */ None,
                &mut sink,
            )
            .await
        }
        "openai" | "custom" => {
            let messages = build_openai_messages(&advisor_history);
            chat::call_openai_compat_structured(
                client, base_url, model, messages, api_key, protocol, chat_template_kwargs,
                /* with_tools */ false,
                /* tools */ None,
                /* abort */ None,
                &mut sink,
            )
            .await
        }
        "ollama" => {
            let messages: Vec<ChatMessage> = advisor_history
                .iter()
                .filter_map(|m| match m {
                    AgentMessage::Text { role, content } => Some(ChatMessage {
                        role: role.clone(),
                        content: content.clone(),
                    }),
                    _ => None,
                })
                .collect();
            chat::call_ollama(client, base_url, model, &messages, None, &mut sink).await
        }
        other => return (format!("advisor: unsupported protocol '{other}'"), true),
    };

    match turn {
        Ok(t) => {
            let advice = t.content.trim().to_string();
            if advice.is_empty() {
                ("advisor returned empty guidance — proceed with your own judgement.".to_string(), false)
            } else {
                (advice, false)
            }
        }
        Err(e) => (format!("advisor call failed: {e} — proceed with your own judgement."), true),
    }
}

// ────────────────────────────────────────────────────────────────────
// System prompt + error helpers (unchanged from Phase 1)
// ────────────────────────────────────────────────────────────────────

/// Appended to the agent's system prompt when a design system is active
/// (Studio "Generate"). Turns the agent into a UI generator that writes a
/// complete static project to `.shugu-forge/preview/` so the live preview
/// (`preview://` protocol) can render it. Kept as a const so the large role
/// strings in `seed_prompt` stay untouched.
const GENERATION_MODE_PROMPT: &str = "=== GENERATION MODE (a design system is active) ===\nWhen the task asks you to build, generate, create, or design a page, site, landing page, dashboard, component, or any UI, you MUST produce a COMPLETE, SELF-CONTAINED static web project WRITTEN TO DISK using `fs_write_file` — NOT a chat answer and NOT a single fenced code block.\n\nBefore writing files, call `todo_write` with a short checklist (3-6 steps) of your plan, then update the statuses as you complete each step.\n\nRules:\n1. Write the entry point at `.shugu-forge/preview/index.html`.\n2. Put CSS in `.shugu-forge/preview/styles.css` and JS in `.shugu-forge/preview/script.js`, linked from index.html with RELATIVE paths (href=\"styles.css\", src=\"script.js\").\n3. Apply the design context below (a design system and/or a colour direction): declare its color / typography / spacing tokens as CSS custom properties in `:root { ... }`, and follow the visual direction, component patterns, and anti-patterns.\n4. Produce real, polished, responsive markup with enough sections to demonstrate the design (e.g. hero, content sections, footer). No placeholder-only output.\n5. Always (over)write the files under `.shugu-forge/preview/` so the live preview reflects the latest version; read existing files first when iterating.\n6. After writing, reply with ONE short line: what you built, which design skill(s) you applied, + the entry path `.shugu-forge/preview/index.html`.";

/// Appended to the agent's system prompt in PLAN MODE (the chat's read-only
/// selector). Behaviour mirror of Claude Code's plan mode: the agent explores
/// and proposes, but never mutates. The HARD enforcement is tool filtering +
/// the dispatch guard in `tool_use_loop`; this just keeps the model honest so
/// it doesn't promise edits it cannot perform.
const PLAN_MODE_PROMPT: &str = "\n\n=== PLAN MODE (READ-ONLY) ===\nYou are in PLAN MODE. The write/exec tools (fs_write_file, fs_edit, run_command) are DISABLED for this turn — calling them will fail. Do NOT promise to write files or run commands.\n\nYour job is to UNDERSTAND and PROPOSE, not to act:\n1. Use the read tools (fs_list_dir, fs_read_file, fs_search) to investigate the real code as needed.\n2. Optionally use todo_write to sketch the steps you WOULD take.\n3. Finish with a clear, concrete PLAN in plain text: which files you'd create/change, what each change does, and how you'd verify it. The user will switch you to Agent mode to actually execute it.";

/// System prompt for a Grounded Run — the env-grounded loop on the user's REAL
/// project (exec directe depuis le pivot 2026-06-10 ; le filet de sécurité est
/// git, visible dans l'onglet Git de l'app).
pub(super) const GROUNDED_PROMPT: &str = r#"You are Shugu's Grounded agent. You work DIRECTLY on the user's real project, with execution enabled on their machine. Git is the safety net: every change you make is visible in the app's Git panel, where the user can review and discard it. Your job: make the requested change AND prove it works by running the project's own checks.

LOOP (DeepSWE-shaped):
1. UNDERSTAND before editing. Use fs_search and fs_read_file to locate the relevant code and read it FULLY. Never edit a file you have not read.
2. EDIT surgically: fs_edit for changes to existing files, fs_write_file for new ones.
3. VERIFY after every change with run_command. If a verification command was provided below, run EXACTLY that. Otherwise read package.json / Cargo.toml to find the project's own check (typecheck, test, build) and run it. For UI changes you can also SEE the result: after launching/refreshing the UI, call capture_screen — the screenshot comes back as an image you can actually look at, and it shows the user visual proof in the chat.
4. READ the failure. A non-zero exit is INFORMATION, not defeat: read stderr, find the root cause, fix it, then run the check AGAIN.
5. Declare done ONLY when the check passes (exit 0). End with a short plain-text summary of what you changed and why.

TOOLCHAIN: you run on the user's real machine — `node`, `pnpm`, `npm`, `npx`, `cargo`, `git`, etc. resolve exactly as in their terminal, network included.

RULES (you are editing the REAL project — be surgical):
- NEVER run destructive commands outside the task scope: no `rm`/`del` sweeps, no `git commit`, `git push`, `git checkout`, `git reset` unless the task EXPLICITLY asks for it.
- Do not install global tools or modify files outside the workspace unless the task explicitly requires it.
- No drive-by refactors: change what the task needs, nothing else.
- Keep going until the check is green or you exhaust your iteration budget. Honest partial progress beats a confident wrong answer.
"#;

pub(super) const ATELIER_PROMPT: &str = r#"You are Shugu's Atelier agent. You build a small WEB UI and then PROVE it works by actually driving a real browser — never by claiming it looks correct.

You work in a THROWAWAY creation directory (empty temp dir), never the user's real project. All file paths are workspace-relative POSIX paths (e.g. `index.html`, `app.js`). Your tools: `fs_write_file(path, content)`, `fs_read_file(path)`, `fs_edit(path, old_string, new_string)`, `fs_list_dir(path)`, `run_command(command)`, and `skill_save(name, when_to_use, body)`. Commands run directly on the user's machine (real node/npm toolchain, network available), cwd = your creation directory.

THE LOOP — follow it exactly:
1. BUILD the app: write a self-contained static web app to disk — `index.html` plus optional `styles.css` / `app.js` linked with relative paths. Vanilla HTML/CSS/JS only: NO build step, NO frameworks.
2. WRITE a browser test that DRIVES the UI. Create a CommonJS file `test.cjs` that uses Playwright for real interaction:
   - first check Playwright resolves: `run_command("node -e \"require('playwright')\"")`. If it fails, install it locally: `run_command("npm init -y && npm install playwright && npx playwright install chromium", timeoutSecs: 300)`.
   - `const { chromium } = require('playwright');` and `chromium.launch()`,
   - open the page with an ABSOLUTE file URL built from the cwd: `const url = 'file:///' + process.cwd().replace(/\\/g, '/').replace(/^\//, '') + '/index.html'; await page.goto(url);`,
   - interact for real: `await page.click('#add')`, `await page.fill('#name', 'x')`, etc.,
   - ASSERT the resulting DOM, e.g. `const n = await page.locator('.item').count();` then `if (n !== 1) { console.error('FAIL: expected 1, got ' + n); process.exit(1); }`,
   - `await browser.close();` and finish with exit 0 on success. Wrap in `.catch(e => { console.error(e); process.exit(1); })`.
3. RUN it: call `run_command("node test.cjs")`. You get the REAL exit code + stdout + stderr.
4. If it FAILS (non-zero exit): read the actual error, FIX the app or the test with `fs_edit`, and run it again. Repeat until it passes. NEVER claim success without a passing run.
5. When the test PASSES (exit 0): call `skill_save` to capture the REUSABLE approach — a concise, generalizable recipe (how to build + test this kind of UI), NOT this one app's full source. The skill loads automatically into future runs so you get faster over time. NOTE: `skill_save` is REFUSED unless your last `run_command` exited 0 — the environment must confirm it works first.

Rules:
- Keep the app small but genuinely INTERACTIVE (the point is to test behavior, not render static text).
- Finish with ONE short line: what you built and that its browser test passes."#;

/// Seed system prompt STATIQUE pour un rôle. Le Refiner qui le faisait évoluer
/// est retiré ; l'apprentissage vit désormais dans la skill library.
pub(crate) fn seed_prompt(role: &str) -> String {
    // Why this prompt is so directive: cloud LLMs (DeepSeek, GLM, Kimi, …) tend
    // to default to "respond from training data" when the system prompt is soft
    // ("you have access to tools, use them when needed"). The user repeatedly
    // sees the model reply with disclaimers like "I cannot see your files"
    // EVEN THOUGH tools are wired and `tool_choice: "auto"` is set — because
    // the model's instinct is "answer from priors first, call tools second."
    // The fix is to MAKE TOOL USE THE DEFAULT BEHAVIOR for any task about the
    // user's workspace, and to FORBID training-data answers about local files.
    //
    // Three rules drive the new prompt:
    //   1. NEVER answer from training data about the user's project. The model
    //      doesn't know what's in this specific repo — it must read.
    //   2. ALWAYS use the tools to gather evidence before answering ANY
    //      question that names a file, directory, function, class, module.
    //   3. The first tool call on an unfamiliar workspace SHOULD be
    //      `fs_list_dir` at the relevant path — cheap, gives a tree to
    //      reason from, prevents hallucinated filenames.
    match role {
        "orchestrator" => "You are Shugu — a helpful, friendly coding companion that lives IN the user's app and works ON their real machine. You are conversational AND capable: you talk naturally, and when there is real work to do you actually DO it.\n\nADAPT to the message:\n- Greeting / thanks / chit-chat / a simple question you can answer directly → just reply, warmly and concisely. Do NOT call tools, do NOT write a plan. (e.g. « merci », « ça va ? », « c'est quoi un closure ? ».)\n- A real task — build / create / fix / modify / refactor / explore this project / anything multi-step → switch into work mode below: plan, read, write, run, verify.\n\nWhen there IS work to do, you don't just answer — you DO it: plan, read, write code, run it, verify, fix, repeat, until the task is actually finished.\n\nYour tools (all act on the REAL project; paths are WORKSPACE-RELATIVE POSIX, e.g. `src/main.js`, `.` — absolute paths and `..` are rejected):\n- `fs_list_dir(path)`, `fs_read_file(path)`, `fs_search(query)` — explore & locate BEFORE editing.\n- `fs_write_file(path, content)`, `fs_edit(path, old_string, new_string)` — create / modify files.\n- `run_command(command)` — run the project's REAL toolchain (node, pnpm, npm, cargo, git, python…) with network. Use it to install deps, build, run, and TEST what you produce.\n- `code_search(query)` — SEMANTIC search over the project's vector index; use it when you don't know the exact identifier (smarter than fs_search's literal/regex).\n- `web_search(query)` — search the public web for up-to-date info, library docs, or an error message that isn't in the local project.\n- `advisor()` — consult a senior reviewer that sees your FULL transcript; takes NO parameters. Call it BEFORE substantive work (before writing/editing or committing to an approach), when STUCK, and BEFORE declaring done. Weigh its advice, then continue.\n- `todo_write(todos)` — record and update your plan as a checklist.\n- `skill_save(...)` — save a reusable recipe after a test passes.\n\nABSOLUTE RULES — they override any other reflex:\n\n1. NEVER answer from training data about THIS project. You only know what you read via the tools in THIS conversation. If about to say \"a file like this typically contains…\" or \"I can't see your files\" — STOP and call `fs_list_dir`/`fs_read_file`/`fs_search` instead. That is what they are for.\n\n2. PLAN FIRST. For ANY build or multi-step task, call `todo_write` with a short checklist (3-7 steps) BEFORE doing the work, then update each step's status (in_progress → completed) AS YOU GO. Keep the list current — it is how the user follows your progress. On a non-trivial task, call `advisor()` for a strategic check BEFORE committing to an approach (after a little orientation, before the first write), and again BEFORE declaring done.\n\n3. EXPLORE before editing: `fs_list_dir` / `fs_search` / `fs_read_file` the relevant code. NEVER edit a file you have not read.\n\n4. BUILD IT FOR REAL, then VERIFY. After writing files, use `run_command` to install/build/run/test. A non-zero exit is INFORMATION, not defeat: read stderr, find the cause, fix it, run AGAIN. Do not declare done until it actually runs.\n\n5. Building a whole app / game / site FROM SCRATCH: create the COMPLETE project (entry point, modules, assets, a way to run it), make it runnable, and run it to prove it works. No stubs, no \"the rest is similar\", no placeholder TODOs — write complete files.\n\n6. Be surgical on EXISTING projects (git is the safety net — change only what the task needs); be COMPLETE on NEW ones.\n\n7. Finish with a SHORT plain-text summary: what you built and how you verified it (the command you ran + that it passed).".to_string(),
        other => format!(
            "You are a Shugu sub-agent with role '{other}', running on the user's machine. You have three filesystem tools: `fs_read_file(path)`, `fs_write_file(path, content)`, `fs_list_dir(path)`. All paths are workspace-relative.\n\nRULE: never answer from training data about the user's project. Always use the tools to gather evidence first. If the task is about a file or directory, your first action is `fs_list_dir` or `fs_read_file`. Output only the final result."
        ),
    }
}

/// Persist the per-run outcome row (telemetry par run : succès, raison de
/// blocage, itérations). La colonne `generation` est conservée pour compat de
/// schéma mais vaut toujours 0 (le Refiner « par génération » est retiré).
/// INSERT OR REPLACE : un run écrit son outcome une seule fois à la fin.
fn record_outcome(
    app: &AppHandle,
    agent_id: &str,
    role: &str,
    success: bool,
    metrics: &LoopMetrics,
) {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO agent_outcomes
                    (agent_id, role, generation, success, stuck_reason,
                     iterations, tool_errors, ts)
                 VALUES (?1, ?2, 0, ?3, ?4, ?5, ?6, ?7)",
                params![
                    agent_id,
                    role,
                    success as i64,
                    metrics.stuck_reason.as_deref(),
                    metrics.iterations as i64,
                    metrics.tool_errors as i64,
                    now_ms(),
                ],
            );
            // S3 — la promotion `validated=1` se fait côté TS au moment où la
            // review est créée (superviseDeliverable lit `transcript.agent.status`).
            // Elle ne peut PAS se faire ici : la review n'existe pas encore à ce
            // point (produite après ce run par un reviewer asynchrone).
        }
    }
}

fn finish_error(
    app: &AppHandle,
    state: &Arc<Mutex<HashMap<String, AgentHandle>>>,
    agent_id: &str,
    err: &str,
) {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let _ = conn.execute(
                "UPDATE agents
                    SET status = 'error',
                        finished_at = ?1,
                        error = ?2
                  WHERE id = ?3",
                params![now_ms(), err, agent_id],
            );
        }
    }
    let _ = persist_and_emit(
        app,
        &AgentEvent::Error {
            agent_id: agent_id.to_string(),
            error: err.to_string(),
        },
    );
    if let Ok(mut g) = state.lock() {
        g.remove(agent_id);
    }
}

fn mark_killed(app: &AppHandle, agent_id: &str) {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let _ = conn.execute(
                "UPDATE agents
                    SET status = 'killed',
                        finished_at = ?1,
                        error = COALESCE(error, 'killed by user')
                  WHERE id = ?2",
                params![now_ms(), agent_id],
            );
        }
    }
    let _ = persist_and_emit(
        app,
        &AgentEvent::Error {
            agent_id: agent_id.to_string(),
            error: "killed by user".to_string(),
        },
    );
}

// ────────────────────────────────────────────────────────────────────
// Tests — native message builders (Lot 3). Pure functions, no I/O.
// ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tc(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall { id: id.into(), name: name.into(), arguments: args.into() }
    }
    fn tr(id: &str, name: &str, is_error: bool, content: &str) -> ToolResult {
        ToolResult { id: id.into(), name: name.into(), is_error, content: content.into() }
    }

    // ── OpenAI ────────────────────────────────────────────────────────
    #[test]
    fn openai_text_history() {
        let h = vec![
            AgentMessage::Text { role: "system".into(), content: "sys".into() },
            AgentMessage::Text { role: "user".into(), content: "hi".into() },
        ];
        assert_eq!(
            build_openai_messages(&h),
            vec![
                json!({ "role": "system", "content": "sys" }),
                json!({ "role": "user", "content": "hi" }),
            ]
        );
    }

    #[test]
    fn openai_assistant_tool_calls() {
        let h = vec![AgentMessage::AssistantWithTools {
            content: "reading".into(),
            tool_calls: vec![tc("call_1", "fs_read_file", r#"{"path":"a.ts"}"#)],
        }];
        assert_eq!(
            build_openai_messages(&h)[0],
            json!({
                "role": "assistant",
                "content": "reading",
                "tool_calls": [{
                    "id": "call_1",
                    "type": "function",
                    "function": { "name": "fs_read_file", "arguments": r#"{"path":"a.ts"}"# }
                }]
            })
        );
    }

    #[test]
    fn normalize_tool_args_coerces_invalid_to_empty_object() {
        assert_eq!(normalize_tool_args(r#"{"path":"a.ts"}"#), r#"{"path":"a.ts"}"#);
        assert_eq!(normalize_tool_args(""), "{}"); // no-arg call → "" rejeté par MiniMax
        assert_eq!(normalize_tool_args(r#"{"path":"trunc"#), "{}"); // streaming coupé
        assert_eq!(normalize_tool_args("\"bare string\""), "{}"); // JSON valide mais pas objet
        assert_eq!(normalize_tool_args("42"), "{}");
    }

    #[test]
    fn openai_tool_calls_empty_args_become_object() {
        // Régression 400 MiniMax : un appel d'outil sans arguments streamés (`""`)
        // doit être ré-injecté avec `"{}"`, pas `""` (sinon « invalid function
        // arguments json string »).
        let h = vec![AgentMessage::AssistantWithTools {
            content: "".into(),
            tool_calls: vec![tc("call_function_x", "list_factions", "")],
        }];
        let out = build_openai_messages(&h);
        assert_eq!(out[0]["tool_calls"][0]["function"]["arguments"], "{}");
    }

    #[test]
    fn openai_tool_results_one_message_each() {
        let h = vec![AgentMessage::ToolResults(vec![
            tr("call_1", "fs_read_file", false, "FILE"),
            tr("call_2", "fs_list_dir", false, "[]"),
        ])];
        let out = build_openai_messages(&h);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], json!({ "role": "tool", "tool_call_id": "call_1", "content": "FILE" }));
        assert_eq!(out[1], json!({ "role": "tool", "tool_call_id": "call_2", "content": "[]" }));
    }

    // ── Anthropic ─────────────────────────────────────────────────────
    #[test]
    fn anthropic_system_hoisted_user_blocks() {
        let h = vec![
            AgentMessage::Text { role: "system".into(), content: "S".into() },
            AgentMessage::Text { role: "user".into(), content: "U".into() },
        ];
        let (msgs, system) = build_anthropic_native(&h);
        assert_eq!(system, Some("S".to_string()));
        assert_eq!(msgs, vec![json!({ "role": "user", "content": [{ "type": "text", "text": "U" }] })]);
    }

    #[test]
    fn anthropic_tool_use_input_is_parsed_object() {
        let h = vec![AgentMessage::AssistantWithTools {
            content: "".into(),
            tool_calls: vec![tc("tu_1", "fs_read_file", r#"{"path":"a.ts"}"#)],
        }];
        let (msgs, _) = build_anthropic_native(&h);
        assert_eq!(
            msgs,
            vec![json!({
                "role": "assistant",
                "content": [{ "type": "tool_use", "id": "tu_1", "name": "fs_read_file", "input": { "path": "a.ts" } }]
            })]
        );
        // Landmine #1: input must be an OBJECT, not the raw arg string.
        assert!(msgs[0]["content"][0]["input"].is_object());
    }

    #[test]
    fn anthropic_tool_result_shape_and_error_flag() {
        let h = vec![AgentMessage::ToolResults(vec![
            tr("tu_1", "x", false, "ok"),
            tr("tu_2", "y", true, "boom"),
        ])];
        let (msgs, _) = build_anthropic_native(&h);
        // Landmine #2: ALL results batch into ONE user message.
        assert_eq!(
            msgs,
            vec![json!({
                "role": "user",
                "content": [
                    { "type": "tool_result", "tool_use_id": "tu_1", "content": "ok" },
                    { "type": "tool_result", "tool_use_id": "tu_2", "content": "boom", "is_error": true }
                ]
            })]
        );
    }

    #[test]
    fn anthropic_coalesces_consecutive_user_turns() {
        // tool_results (user) then a system-nudge user Text → ONE user message
        // (Anthropic rejects two consecutive user turns).
        let h = vec![
            AgentMessage::ToolResults(vec![tr("tu_1", "x", false, "ok")]),
            AgentMessage::Text { role: "user".into(), content: "[Shugu] final".into() },
        ];
        let (msgs, _) = build_anthropic_native(&h);
        assert_eq!(msgs.len(), 1);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[1], json!({ "type": "text", "text": "[Shugu] final" }));
    }

    #[test]
    fn anthropic_alternation_preserved_full_loop() {
        // user → assistant(tool_use) → user(tool_result) → assistant(text)
        let h = vec![
            AgentMessage::Text { role: "user".into(), content: "task".into() },
            AgentMessage::AssistantWithTools { content: "".into(), tool_calls: vec![tc("t", "n", "{}")] },
            AgentMessage::ToolResults(vec![tr("t", "n", false, "r")]),
            AgentMessage::Text { role: "assistant".into(), content: "done".into() },
        ];
        let (msgs, _) = build_anthropic_native(&h);
        let roles: Vec<&str> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
        assert_eq!(roles, vec!["user", "assistant", "user", "assistant"]);
    }

    #[test]
    fn anthropic_empty_assistant_text_omitted() {
        let h = vec![AgentMessage::AssistantWithTools {
            content: "   ".into(),
            tool_calls: vec![tc("t", "n", "{}")],
        }];
        let (msgs, _) = build_anthropic_native(&h);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0]["type"], "tool_use");
    }

    #[test]
    fn anthropic_bad_args_fallback_empty_object() {
        let h = vec![AgentMessage::AssistantWithTools {
            content: "".into(),
            tool_calls: vec![tc("t", "n", "not valid json")],
        }];
        let (msgs, _) = build_anthropic_native(&h);
        assert_eq!(msgs[0]["content"][0]["input"], json!({}));
    }

    // ── UserImage (vérification visuelle agent) ───────────────────────
    #[test]
    fn openai_user_image_multimodal_blocks() {
        let h = vec![AgentMessage::UserImage {
            text: "look".into(),
            data_url: "data:image/jpeg;base64,AAAA".into(),
        }];
        let out = build_openai_messages(&h);
        assert_eq!(
            out[0],
            json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "look" },
                    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,AAAA" } }
                ]
            })
        );
    }

    #[test]
    fn openai_user_image_pruned_becomes_text() {
        let h = vec![AgentMessage::UserImage { text: "look".into(), data_url: "".into() }];
        assert_eq!(
            build_openai_messages(&h)[0],
            json!({ "role": "user", "content": "look" })
        );
    }

    #[test]
    fn anthropic_user_image_coalesces_with_tool_results() {
        // tool_result (user) puis UserImage → UN SEUL message user, blocs
        // tool_result + text + image (Anthropic rejette 2 tours user de suite).
        let h = vec![
            AgentMessage::ToolResults(vec![tr("tu_1", "capture_screen", false, "SCREENSHOT_SAVED:/x.jpg")]),
            AgentMessage::UserImage {
                text: "look".into(),
                data_url: "data:image/jpeg;base64,AAAA".into(),
            },
        ];
        let (msgs, _) = build_anthropic_native(&h);
        assert_eq!(msgs.len(), 1);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(blocks[1]["type"], "text");
        assert_eq!(
            blocks[2],
            json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/jpeg", "data": "AAAA" }
            })
        );
    }

    #[test]
    fn prune_keeps_only_last_n_images() {
        let img = |t: &str| AgentMessage::UserImage {
            text: t.into(),
            data_url: "data:image/jpeg;base64,AAAA".into(),
        };
        let mut h = vec![img("a"), img("b"), img("c")];
        prune_user_images(&mut h, 2);
        let urls: Vec<bool> = h
            .iter()
            .map(|m| match m {
                AgentMessage::UserImage { data_url, .. } => !data_url.is_empty(),
                _ => unreachable!(),
            })
            .collect();
        assert_eq!(urls, vec![false, true, true]);
        // Le texte du plus ancien signale le retrait.
        if let AgentMessage::UserImage { text, .. } = &h[0] {
            assert!(text.contains("retiré"));
        }
    }
}
