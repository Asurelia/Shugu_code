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

/// Maximum tool-use rounds per agent run. 8 ≈ "read 3-5 files, write 1-2,
/// verify, summarize" with comfortable headroom. Beyond 8 we treat the
/// agent as wedged but RETURN whatever content it produced rather than
/// erroring (cf. logic in `tool_use_loop`) — see below.
///
/// 2026-05-17 — bumped from 6 to 8 after a real test where DeepSeek V4
/// Flash kept calling tools (22 in a single iteration) without producing
/// a final answer. Plus on the LAST iteration, we inject a synthetic
/// "[Shugu system] FINAL iteration" message and force-accept whatever
/// content the model returns — even empty — so the user gets SOME
/// signal instead of "agent exceeded MAX_ITERATIONS" with no output.
const MAX_ITERATIONS: u32 = 8;

/// Extra tool-use iterations granted once, after a successful mid-run harness
/// evolution, so the freshly-evolved prompt is actually exercised this run.
const EVOLVE_BONUS_ITERATIONS: u32 = 4;

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
#[allow(dead_code)] // variants used in match arms but rustc sees only construction
pub(super) enum AgentMessage {
    Text { role: String, content: String },
    AssistantWithTools { content: String, tool_calls: Vec<ToolCall> },
    ToolResults(Vec<ToolResult>),
}

// ────────────────────────────────────────────────────────────────────
// Provider-specific message builders
// ────────────────────────────────────────────────────────────────────

/// Translate `AgentMessage` history into OpenAI Chat Completions format.
/// Each `AgentMessage` becomes 1+ JSON objects in the returned vec.
///
/// **Not used in Phase 2** — we ship the text-projection variant
/// ([`build_openai_text_projection`]) for now because `call_openai_compat`
/// takes `&[ChatMessage]` (a flat role/content shape) and patching its
/// signature to accept structured Value-array messages is a larger
/// refactor than Phase 2 should carry. Phase 3 wires this up by adding
/// a separate `call_openai_compat_structured` path that accepts the
/// JSON-array body and forwards through the same SSE parser.
#[allow(dead_code)]
fn build_openai_messages(history: &[AgentMessage]) -> Vec<serde_json::Value> {
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
                            "function": { "name": tc.name, "arguments": tc.arguments }
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
        }
    }
    out
}

/// Translate `AgentMessage` history into Anthropic Messages API format.
/// System messages are dropped here — the caller must pass them in the
/// top-level `system` field (handled inside `call_anthropic`).
#[allow(dead_code)] // wired by call_agent_llm_with_tools below
fn build_anthropic_messages(history: &[AgentMessage]) -> Vec<ChatMessage> {
    // Anthropic's `messages` array doesn't include system. Our `call_anthropic`
    // already extracts system from a `&[ChatMessage]` input by filtering, so
    // the easiest interop is to return a `Vec<ChatMessage>` here and let the
    // existing extraction do its job. For AssistantWithTools / ToolResults
    // we serialize the structured content blocks INTO the `content` field as
    // a JSON string — Anthropic accepts content as either a string (text-only)
    // or an array of blocks (mixed). To keep this simple, the runner uses the
    // OpenAI dialect for both providers in Phase 2 by routing both through
    // `build_openai_messages` for OpenAI-compat protocols and using a plain
    // text-only ChatMessage list for Anthropic until a Phase 3 refactor adds
    // structured-content support. See note below.
    let mut out: Vec<ChatMessage> = Vec::new();
    for msg in history {
        match msg {
            AgentMessage::Text { role, content } => {
                out.push(ChatMessage { role: role.clone(), content: content.clone() });
            }
            AgentMessage::AssistantWithTools { content, tool_calls } => {
                // Phase 2 best-effort: serialize tool_calls into the
                // assistant text. Anthropic native tool_use will come in
                // Phase 3 via structured content blocks.
                let mut s = content.clone();
                for tc in tool_calls {
                    s.push_str(&format!("\n[tool_call:{}] {}\n", tc.name, tc.arguments));
                }
                out.push(ChatMessage { role: "assistant".into(), content: s });
            }
            AgentMessage::ToolResults(results) => {
                let mut s = String::new();
                for r in results {
                    s.push_str(&format!(
                        "[tool_result:{}] {}{}\n",
                        r.name,
                        if r.is_error { "(error) " } else { "" },
                        r.content
                    ));
                }
                out.push(ChatMessage { role: "user".into(), content: s });
            }
        }
    }
    out
}

// ────────────────────────────────────────────────────────────────────
// Workspace root resolution
// ────────────────────────────────────────────────────────────────────

/// Resolve the workspace root once per loop iteration so all parallel
/// tool calls share the same value. Returns `None` when no workspace
/// is open — the dispatcher then returns an "is_error: true" ToolResult
/// for every call this iteration so the model sees the situation and
/// can ask the user to open a workspace.
fn get_workspace_root(app: &AppHandle) -> Option<PathBuf> {
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
) {
    let start = std::time::Instant::now();
    let protocol = protocol.unwrap_or_else(|| "openai".to_string());
    let base_url = base_url.unwrap_or_default();

    // Continual Harness (lot 1) — load the active harness generation for this
    // role instead of a hard-coded prompt. First use of a role seeds
    // generation 0 from `seed_prompt`, so behaviour is unchanged until a
    // Refiner evolves the harness. `active_generation` is recorded against the
    // run's outcome (P1) so per-generation metrics can be computed.
    let harness = load_active_harness(&app, &role);
    let active_generation = harness.generation;
    let mut system_prompt = harness.system_prompt;
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

    // Seed the agent's conversation history with the system prompt + the
    // user task. Subsequent turns (assistant responses + tool results)
    // are appended inside the loop.
    let mut history: Vec<AgentMessage> = vec![
        AgentMessage::Text {
            role: "system".to_string(),
            content: system_prompt,
        },
        AgentMessage::Text {
            role: "user".to_string(),
            content: task,
        },
    ];

    let client = reqwest::Client::new();

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
            None,
        ) => r,
        _ = abort.notified() => {
            mark_killed(&app, &agent_id);
            return;
        }
    };

    let ms = start.elapsed().as_millis() as u64;

    // Record the run outcome for per-generation metrics (Continual Harness P1).
    // Written for both success and failure; abort (killed) returns earlier and
    // is intentionally not scored.
    record_outcome(
        &app,
        &agent_id,
        &role,
        active_generation,
        loop_result.is_ok(),
        &loop_metrics,
    );

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
    // open workspace — the measurement bench points it at a copied fixture so a
    // run never touches the user's real project. `None` = current behaviour.
    workspace_override: Option<PathBuf>,
) -> Result<(String, String), String> {
    // Stall-detection state (P1): repeated identical tool-call signatures and
    // consecutive tool-error rounds are the two cheap "stuck" signals; the
    // third (budget exhaustion) is handled in the `last_iteration` branch.
    let mut last_sig: Option<String> = None;
    let mut repeat_count: u32 = 0;
    let mut err_streak: u32 = 0;
    let mut evolved = false;
    // Dynamic budget (Continual Harness P2): a successful mid-run evolution adds
    // bonus iterations so the freshly-evolved harness is actually exercised in
    // THIS run (reset-free resumption). Every budget comparison below uses
    // `budget`, NEVER the MAX_ITERATIONS const — otherwise the force-answer
    // mechanism would silently break after a budget bump.
    let mut budget = MAX_ITERATIONS;
    let mut iteration: u32 = 0;
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
            call_agent_llm_with_tools(app, client, protocol, base_url, model, history, api_key, chat_template_kwargs, agent_id).await?;

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

        // ── 5. Resolve workspace + execute tools in parallel ───────────
        let workspace_root = workspace_override
            .as_ref()
            .cloned()
            .or_else(|| get_workspace_root(app));
        let results: Vec<ToolResult> = if let Some(root) = workspace_root {
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
                let root_clone = root_arc.clone();
                async move {
                    // `spawn_blocking` because the fs ops are synchronous —
                    // running them on the async runtime thread would starve
                    // other tokio tasks. `unwrap_or_else` defends against
                    // a JoinError (panic in the closure); `execute_tool`
                    // itself never panics for normal fs failures.
                    tokio::task::spawn_blocking(move || execute_tool(&tc_clone, &root_clone))
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

        // ── 7. Append to history for the next iteration ────────────────
        history.push(AgentMessage::AssistantWithTools {
            content: turn.content,
            tool_calls: turn.tool_calls,
        });
        history.push(AgentMessage::ToolResults(results));

        // ── 8. Continual Harness (P2) — on the FIRST in-loop stall with budget
        //       to spare, evolve the harness and resume (reset-free). Only
        //       `repeat`/`tool_errors` are handled here; `max_iterations` is
        //       caught at last_iteration (too late to re-plan this run). Capped
        //       at one evolution per run to avoid a stuck→evolve→stuck cascade.
        if !evolved {
            if let Some(reason) = metrics.stuck_reason.clone() {
                let evolvable = reason == "repeat" || reason == "tool_errors";
                let budget_left = budget.saturating_sub(iteration + 1);
                if evolvable && budget_left >= 3 {
                    // Stage 1 — signal the (5-30s) Refiner call has started so
                    // the UI never looks hung.
                    let _ = persist_and_emit(
                        app,
                        &AgentEvent::HarnessEvolved {
                            agent_id: agent_id.to_string(),
                            role: role.to_string(),
                            status: "evolving".to_string(),
                            reason: Some(reason.clone()),
                            from_generation: None,
                            to_generation: None,
                            summary: None,
                        },
                    );
                    let digest = build_trajectory_digest(history);
                    match super::harness::evolve_harness(
                        app,
                        client,
                        role,
                        &reason,
                        &digest,
                        protocol,
                        base_url,
                        model,
                        api_key,
                        chat_template_kwargs,
                    )
                    .await
                    {
                        Ok(outcome) => {
                            // Stage 2 — applied. Inject a corrective system
                            // message (NOT a rewrite of history[0]) + grant
                            // bonus iterations so the new harness gets used.
                            let _ = persist_and_emit(
                                app,
                                &AgentEvent::HarnessEvolved {
                                    agent_id: agent_id.to_string(),
                                    role: role.to_string(),
                                    status: "applied".to_string(),
                                    reason: Some(reason.clone()),
                                    from_generation: Some(outcome.from_generation),
                                    to_generation: Some(outcome.to_generation),
                                    summary: Some(outcome.summary.clone()),
                                },
                            );
                            history.push(AgentMessage::Text {
                                role: "system".to_string(),
                                content: format!(
                                    "[Shugu] {} Applique cette guidance révisée et reprends la tâche au lieu de répéter la même action.",
                                    outcome.summary
                                ),
                            });
                            budget += EVOLVE_BONUS_ITERATIONS;
                            evolved = true;
                        }
                        Err(e) => {
                            // Evolution failed — never block the run. Flag the
                            // attempt and carry on with the current harness; set
                            // `evolved` so we don't retry every iteration.
                            let _ = persist_and_emit(
                                app,
                                &AgentEvent::HarnessEvolved {
                                    agent_id: agent_id.to_string(),
                                    role: role.to_string(),
                                    status: "failed".to_string(),
                                    reason: Some(format!("{reason}: {e}")),
                                    from_generation: None,
                                    to_generation: None,
                                    summary: None,
                                },
                            );
                            evolved = true;
                        }
                    }
                }
            }
        }

        iteration += 1;
    }

    Err(format!(
        "agent exceeded MAX_ITERATIONS ({MAX_ITERATIONS}) — unreachable in practice (cf. last_iteration force-return)"
    ))
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
            let messages = build_anthropic_messages(history);
            chat::call_anthropic(
                client, base_url, model, &messages, api_key, /* with_tools */ true,
                /* attached_image */ None,
                /* abort */ None,
                &mut on_chunk,
            )
            .await
        }
        "openai" | "custom" => {
            // For OpenAI we build the full structured history (assistant+tool_calls,
            // tool result messages with tool_call_id). We bypass the &[ChatMessage]
            // input of `call_openai_compat` because that path can't carry tool_calls.
            // Instead we build the messages JSON directly and call a small inline
            // adapter that posts to the same endpoint with the same SSE parsing.
            //
            // Implementation note: rather than fork the helper, we project our
            // AgentMessage history into a Vec<ChatMessage> text-only view for the
            // helper signature, but we patch the messages_json INSIDE the helper.
            // To minimize chat.rs surface changes, we use the text-projection here
            // and accept that OpenAI sees a slightly degraded history (tool_calls
            // serialized as text). The actual provider-native multi-turn fix lands
            // in Phase 3.
            //
            // For Phase 2's smoke test (1 round of tool-use → answer) this is
            // sufficient: the first round has only Text history (system+user),
            // the tool result re-prompt sees the assistant text + tool result
            // text — degraded but functional.
            let messages = build_openai_text_projection(history);
            chat::call_openai_compat(
                client,
                base_url,
                model,
                &messages,
                api_key,
                protocol,
                chat_template_kwargs,
                /* with_tools */ true,
                /* attached_image */ None,
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

/// One-shot LLM call for the harness Refiner (Continual Harness P2). No tools,
/// no streaming — we only need the rewritten text back. Mirrors the dispatch in
/// `call_agent_llm_with_tools` (`with_tools = false`, no-op chunk sink). Lives
/// in runner.rs so it can reuse the private message builders; `harness.rs`
/// orchestrates the evolution and calls this.
#[allow(clippy::too_many_arguments)]
pub(super) async fn call_refiner(
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let history = vec![
        AgentMessage::Text {
            role: "system".to_string(),
            content: system.to_string(),
        },
        AgentMessage::Text {
            role: "user".to_string(),
            content: user.to_string(),
        },
    ];
    let mut sink = |_kind: &str, _chunk: &str| {};
    let turn = match protocol {
        "anthropic" => {
            let messages = build_anthropic_messages(&history);
            chat::call_anthropic(
                client, base_url, model, &messages, api_key, false, None, None, &mut sink,
            )
            .await?
        }
        "openai" | "custom" => {
            let messages = build_openai_text_projection(&history);
            chat::call_openai_compat(
                client,
                base_url,
                model,
                &messages,
                api_key,
                protocol,
                chat_template_kwargs,
                false,
                None,
                None,
                &mut sink,
            )
            .await?
        }
        "ollama" => {
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
            chat::call_ollama(client, base_url, model, &messages, None, &mut sink).await?
        }
        other => return Err(format!("unsupported refiner protocol: {other}")),
    };
    Ok(turn.content)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max).collect();
        t.push('…');
        t
    }
}

/// Build a SAFE textual digest of the recent trajectory for the Refiner.
///
/// SECURITY (prompt-injection): this NEVER includes file CONTENTS returned by
/// tools — only the tool name, its arguments, and whether the call errored.
/// That collapses the injection surface from "any file in the workspace" (a
/// malicious file could try to rewrite the agent's system prompt) to "the
/// agent's own tool-call arguments". The whole digest is length-capped.
fn build_trajectory_digest(history: &[AgentMessage]) -> String {
    const MAX: usize = 6000;
    let mut out = String::new();
    for msg in history {
        match msg {
            AgentMessage::AssistantWithTools {
                content,
                tool_calls,
            } => {
                if !content.trim().is_empty() {
                    out.push_str(&format!("assistant: {}\n", truncate_chars(content, 200)));
                }
                for tc in tool_calls {
                    out.push_str(&format!(
                        "  call {}({})\n",
                        tc.name,
                        truncate_chars(&tc.arguments, 200)
                    ));
                }
            }
            AgentMessage::ToolResults(results) => {
                for r in results {
                    if r.is_error {
                        out.push_str(&format!(
                            "  result {} ERROR: {}\n",
                            r.name,
                            truncate_chars(&r.content, 160)
                        ));
                    } else {
                        // Success: name only, NEVER the returned content.
                        out.push_str(&format!("  result {} ok\n", r.name));
                    }
                }
            }
            // Text turns (system prompt, user task, our own nudges) carry no
            // tool-trajectory signal and may contain large pasted content — skip.
            _ => {}
        }
        if out.len() > MAX {
            out.truncate(MAX);
            out.push_str("\n…(troncature)\n");
            break;
        }
    }
    out
}

/// Text-only projection of AgentMessage history for the existing
/// `call_openai_compat` signature. AssistantWithTools is serialized
/// inline (tool_calls become a `[tool_call:NAME] {ARGS}` text fragment),
/// ToolResults become a synthetic user message. This is a Phase 2
/// compromise — Phase 3 will pass the structured `tool_calls` field
/// through to the OpenAI body for native multi-turn.
fn build_openai_text_projection(history: &[AgentMessage]) -> Vec<ChatMessage> {
    let mut out: Vec<ChatMessage> = Vec::new();
    for msg in history {
        match msg {
            AgentMessage::Text { role, content } => {
                out.push(ChatMessage {
                    role: role.clone(),
                    content: content.clone(),
                });
            }
            AgentMessage::AssistantWithTools { content, tool_calls } => {
                let mut s = content.clone();
                for tc in tool_calls {
                    s.push_str(&format!("\n[tool_call:{}] {}\n", tc.name, tc.arguments));
                }
                out.push(ChatMessage {
                    role: "assistant".into(),
                    content: s,
                });
            }
            AgentMessage::ToolResults(results) => {
                let mut s = String::from("[tool_results]\n");
                for r in results {
                    s.push_str(&format!(
                        "{}{}: {}\n",
                        if r.is_error { "(error) " } else { "" },
                        r.name,
                        r.content
                    ));
                }
                out.push(ChatMessage {
                    role: "user".into(),
                    content: s,
                });
            }
        }
    }
    out
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

/// Seed harness prompt (generation 0) for a role. Continual Harness serves the
/// ACTIVE generation from the DB via `load_active_harness`; this hard-coded text
/// is only the fallback the first time a role is seen — it is then persisted as
/// generation 0, after which a Refiner may evolve it.
fn seed_prompt(role: &str) -> String {
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
        "orchestrator" => "You are Shugu's orchestrator agent, running on the user's machine with direct access to their workspace files via three tools: `fs_read_file(path)`, `fs_write_file(path, content)`, and `fs_list_dir(path)`. All paths are WORKSPACE-RELATIVE POSIX paths (e.g. `src/lib/db.ts`, `.`, `src/features/agents`). Absolute paths and `..` traversals are rejected.\n\nABSOLUTE RULES — these override any other reflex you have:\n\n1. NEVER answer from your training data about the user's project. You do not know what is in this specific repository. You only know what you have read via `fs_read_file` in THIS conversation.\n\n2. ANY task that mentions a file, directory, function, class, module, service, or component of the user's project REQUIRES tool use. You MUST call the tools — refusing to call them and instead describing what such a file \"typically contains\" is a failure mode and is explicitly forbidden.\n\n3. When a task asks you to list, explore, summarize, analyze, or describe code in a directory: your FIRST action is `fs_list_dir` on that path. Then for each relevant file, call `fs_read_file`. Only after you have read actual content do you produce your final answer.\n\n4. When a task asks you to modify or create a file: read the existing file (if any) with `fs_read_file` first to understand the surrounding code, then call `fs_write_file` with the complete new content.\n\n5. Once you have gathered enough evidence via tools, produce ONLY the final answer — no meta-commentary about your process, no \"here is what I did\". Just the result the user asked for.\n\nIf you find yourself about to say \"I cannot see your files\" or \"I don't have access to your code\" or describing what a directory \"typically contains\" — STOP. Call `fs_list_dir` or `fs_read_file` instead. That is literally what those tools are for.".to_string(),
        other => format!(
            "You are a Shugu sub-agent with role '{other}', running on the user's machine. You have three filesystem tools: `fs_read_file(path)`, `fs_write_file(path, content)`, `fs_list_dir(path)`. All paths are workspace-relative.\n\nRULE: never answer from training data about the user's project. Always use the tools to gather evidence first. If the task is about a file or directory, your first action is `fs_list_dir` or `fs_read_file`. Output only the final result."
        ),
    }
}

/// One active harness generation, as served to a running agent.
pub(super) struct ActiveHarness {
    /// Generation number — recorded against the run's outcome (P1) so
    /// per-generation metrics can be computed.
    pub(super) generation: i64,
    /// Assembled system prompt `p` for this generation.
    pub(super) system_prompt: String,
}

/// Format the long-term memory JSON (array of `{title, content}`) as a compact
/// bullet overview injected into the assembled prompt. Best-effort: invalid
/// JSON yields an empty overview rather than an error.
fn format_memory_overview(memory_json: &str) -> String {
    let entries: Vec<serde_json::Value> = serde_json::from_str(memory_json).unwrap_or_default();
    let mut out = String::new();
    for e in entries.iter().take(50) {
        let title = e.get("title").and_then(|x| x.as_str()).unwrap_or("");
        let content = e.get("content").and_then(|x| x.as_str()).unwrap_or("");
        if content.is_empty() {
            continue;
        }
        if title.is_empty() {
            out.push_str(&format!("- {content}\n"));
        } else {
            out.push_str(&format!("- {title}: {content}\n"));
        }
    }
    out
}

/// Assemble the prompt served to the agent: the stored system prompt plus a
/// long-term memory overview (P3) when memory is non-empty.
fn assemble_prompt(prompt: &str, memory_json: &str) -> String {
    let overview = format_memory_overview(memory_json);
    if overview.is_empty() {
        prompt.to_string()
    } else {
        format!("{prompt}\n\n=== LONG-TERM MEMORY (lessons learned across runs) ===\n{overview}")
    }
}

/// Load the ACTIVE harness generation for `role` from `harness_generations`.
///
/// On the first run of a role no row exists yet, so we SEED generation 0 from
/// `seed_prompt` and persist it (`active = 1`). Behaviour is therefore identical
/// to the pre-Continual-Harness build until a Refiner writes a newer generation.
/// Any DB error degrades gracefully to an in-memory seed WITHOUT persisting —
/// we never block an agent run on harness storage, and not persisting means the
/// next run retries the seed rather than masking the failure.
pub(super) fn load_active_harness(app: &AppHandle, role: &str) -> ActiveHarness {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let existing = conn.query_row(
                "SELECT generation, system_prompt, memory
                   FROM harness_generations
                  WHERE role = ?1 AND active = 1
                  LIMIT 1",
                params![role],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                },
            );
            match existing {
                Ok((generation, system_prompt, memory)) => {
                    return ActiveHarness {
                        generation,
                        // P3: long-term memory is appended to the stored prompt
                        // at assembly time. The `system_prompt` COLUMN stays pure
                        // (no memory) so the Refiner evolves prompt and memory
                        // independently.
                        system_prompt: assemble_prompt(&system_prompt, &memory),
                    };
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    let seed = seed_prompt(role);
                    let _ = conn.execute(
                        "INSERT OR IGNORE INTO harness_generations
                            (id, role, generation, parent_generation, trigger_reason,
                             created_by, system_prompt, memory, subagents, skills,
                             active, created_at)
                         VALUES (?1, ?2, 0, NULL, 'seed', 'seed', ?3,
                                 '[]', '[]', '[]', 1, ?4)",
                        params![format!("{role}-gen0"), role, seed, now_ms()],
                    );
                    return ActiveHarness {
                        generation: 0,
                        system_prompt: seed,
                    };
                }
                Err(_) => {
                    return ActiveHarness {
                        generation: 0,
                        system_prompt: seed_prompt(role),
                    };
                }
            }
        }
    }
    ActiveHarness {
        generation: 0,
        system_prompt: seed_prompt(role),
    }
}

/// Load a SPECIFIC harness generation for `role` (not necessarily the active
/// one) — used by the measurement bench to replay a fixed task against gen 0,
/// gen N, … for A/B comparison. Returns `None` when that (role, generation) row
/// does not exist; the bench caller decides how to handle a missing generation
/// (skip + report). Memory is assembled into the prompt exactly like
/// `load_active_harness`, so a pinned run is byte-identical to how that
/// generation actually ran.
#[allow(dead_code)] // consumed by the bench runner (agents::bench), landing next.
pub(super) fn load_harness_generation(
    app: &AppHandle,
    role: &str,
    generation: i64,
) -> Option<ActiveHarness> {
    let conn_mutex = get_conn(app).ok()?;
    let conn = conn_mutex.lock().ok()?;
    conn.query_row(
        "SELECT generation, system_prompt, memory
           FROM harness_generations
          WHERE role = ?1 AND generation = ?2
          LIMIT 1",
        params![role, generation],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        },
    )
    .ok()
    .map(|(generation, system_prompt, memory)| ActiveHarness {
        generation,
        system_prompt: assemble_prompt(&system_prompt, &memory),
    })
}

/// Persist the per-run outcome row consumed by per-generation metrics (P1).
/// `user_feedback` is left untouched here — it is set later from the UI; a run
/// records its outcome exactly once at completion, so INSERT OR REPLACE is safe.
fn record_outcome(
    app: &AppHandle,
    agent_id: &str,
    role: &str,
    generation: i64,
    success: bool,
    metrics: &LoopMetrics,
) {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO agent_outcomes
                    (agent_id, role, generation, success, stuck_reason,
                     iterations, tool_errors, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    agent_id,
                    role,
                    generation,
                    success as i64,
                    metrics.stuck_reason.as_deref(),
                    metrics.iterations as i64,
                    metrics.tool_errors as i64,
                    now_ms(),
                ],
            );
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
