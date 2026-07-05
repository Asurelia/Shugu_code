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
        "fs_write_file"
            | "fs_edit"
            | "fs_delete"
            | "fs_move"
            | "run_command"
            | "skill_save"
            | "delegate"
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

// ────────────────────────────────────────────────────────────────────
// AM-2 — Orchestrated memory tuning constants
// ────────────────────────────────────────────────────────────────────

/// How many memories the `recall()` hook injects before a turn. Small — the
/// point is the few MOST relevant facts/episodes, not a context dump.
const RECALL_TOP_K: u32 = 4;

/// A recalled memory farther than this cosine-ish distance is dropped as noise.
/// AllMiniLML6V2 distances cluster well below this for genuine matches; the gate
/// keeps an empty/young index from injecting irrelevant rows.
const RECALL_MAX_DISTANCE: f32 = 1.15;

/// Per-recalled-memory text budget (Unicode scalar values, not bytes — French
/// text is multi-byte). Keeps the injected block bounded.
const RECALL_SNIPPET_CHARS: usize = 600;

// ────────────────────────────────────────────────────────────────────
// COMPACTION — token-aware trigger gated on the model's context window.
//
// The trigger is NO LONGER a fixed turn count: an 8k-context local model blows
// past its window long before any turn count, while a 1M model would compact
// far too early and waste capacity. Instead we estimate the live history's token
// footprint and compact once it crosses a budget derived from the REAL window
// (probed for local servers, table for cloud). 100% token-driven — no magic turn
// number gates the decision. Robustness comes from an exact/conservative window,
// a pessimistic char→token estimate, and an absolute response margin.
// ────────────────────────────────────────────────────────────────────

/// chars→tokens divisor. Deliberately pessimistic: JSON / code / paths (the bulk
/// of tool results) tokenise at ~2–3 chars/token, not 4. Over-estimating compacts
/// a little early — the safe side of the error (a provider 400 "context exceeded"
/// kills the run; one extra compaction only costs a summary).
const CHARS_PER_TOKEN: usize = 3;

/// Token cost of an image (screenshot) still carried as a `data_url`. We NEVER
/// count the base64 length (over-counts 10–50×). Flat estimate ≈ real visual cost
/// (Anthropic ≈ (w·h)/750 ; OpenAI high-detail ≈ 1–2k). `prune_user_images` caps
/// the history at 2 live images → worst case ≈ 4000 tokens.
const IMAGE_TOKENS: usize = 2000;

/// Fraction of the window past which we compact.
const COMPACTION_BUDGET_FRACTION: f64 = 0.75;

/// Absolute token margin always reserved under the window, for the current turn's
/// response + estimation error. Dominates on a small window (8k → budget 5192,
/// margin 3000); irrelevant on a large one (1M → the fraction dominates).
const COMPACTION_BUDGET_MARGIN_TOKENS: usize = 3000;

/// After compacting, aim for this ratio of the budget (anti-churn hysteresis: we
/// trigger AT the budget but relax well below it, so the next turn doesn't
/// immediately re-trigger).
const COMPACTION_RELAX_FRACTION: f64 = 0.70;

/// Most recent dialogue turns kept VERBATIM (the model needs fresh detail).
const COMPACTION_KEEP_TAIL_TURNS: usize = 4;

/// Minimum size of one fold: a useful compaction, not a micro-summary of 1–2 turns.
const COMPACTION_FOLD_MIN_TURNS: usize = 6;

/// Estimated weight of the recap message that replaces the folded slab (used when
/// computing the cut point). Bounded by what the summariser returns.
const RECAP_EST_TOKENS: usize = 400;

/// Conservative fallback when the window is unknown (local server not probable /
/// unknown model) — the cited "8k local" case. A genuinely smaller local model is
/// still protected by the absolute margin + the pessimistic ÷3 estimate.
const LOCAL_WINDOW_FALLBACK: usize = 8192;

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

// ────────────────────────────────────────────────────────────────────
// AM-2 — Orchestrated memory: recall (before) · remember (after) · compaction
//
// These three hooks turn the flat tool-use loop into a memory-aware one:
//   - `recall_block`  builds a system block of the most relevant past facts +
//                     episodes for the current task, injected before the loop.
//   - `remember_run`  extracts the salient result after the run and writes it
//                     to the `memory` vector collection for future recall.
//   - `maybe_compact` summarises the oldest live turns into one episodic memory
//                     when history outgrows its window — instead of dropping
//                     them, it KEEPS a recallable summary in context.
//
// Every hook is best-effort and INFALLIBLE-FRIENDLY: any failure degrades to a
// no-op so a memory hiccup never breaks the agent loop (zero-regression rule,
// same contract as skills/lessons injection).
// ────────────────────────────────────────────────────────────────────

/// Build the `recall()` system block: search the `memory` collection for the
/// `RECALL_TOP_K` entries most relevant to `task`, filter by distance, and
/// render them as a compact, role-prefixed block. Returns `(block, count)` —
/// `("", 0)` when nothing relevant (empty index, all hits too far, or any
/// error). Never panics, never blocks.
fn recall_block(app: &AppHandle, task: &str) -> (String, usize) {
    if task.trim().is_empty() {
        return (String::new(), 0);
    }
    let hits = match crate::commands::vector::memory_recall(app, task, RECALL_TOP_K) {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[memory] recall failed, skipping injection: {e}");
            return (String::new(), 0);
        }
    };
    let relevant: Vec<crate::commands::vector::MemoryHit> = hits
        .into_iter()
        .filter(|h| h.distance <= RECALL_MAX_DISTANCE)
        .collect();
    if relevant.is_empty() {
        return (String::new(), 0);
    }
    let count = relevant.len();
    let mut block = String::from(
        "[Mémoire — rappels de sessions passées]\n\
         Des faits et résumés pertinents pour cette tâche ont été retrouvés dans ta mémoire. \
         Utilise-les si utiles ; ignore-les s'ils ne s'appliquent pas.\n\n",
    );
    for h in &relevant {
        let label = match h.kind.as_str() {
            "episode" => "Résumé épisodique",
            _ => "Fait",
        };
        let snippet: String = h.text.chars().take(RECALL_SNIPPET_CHARS).collect();
        block.push_str(&format!("### {label}\n{snippet}\n\n"));
    }
    (block, count)
}

/// `remember()` — write the salient result of a finished run into episodic/fact
/// memory so a future run can recall it. We store the final OUTPUT, prefixed
/// with the task it answered (so the embedding captures both the question and
/// the answer). Best-effort: logs and returns on any failure. Skips trivial
/// outputs (empty or a bare error sentinel) — nothing worth remembering.
fn remember_run(
    app: &AppHandle,
    role: &str,
    conversation_id: Option<&str>,
    task: &str,
    output: &str,
) {
    let out = output.trim();
    // Don't memorialise the "budget exhausted" sentinel or empty answers.
    if out.is_empty() || out.starts_with('⚠') {
        return;
    }
    let task_line = task.trim();
    let text = if task_line.is_empty() {
        out.to_string()
    } else {
        // Keep the stored fact bounded; the embedding is computed on this text.
        let task_snip: String = task_line.chars().take(280).collect();
        let out_snip: String = out.chars().take(1600).collect();
        format!("Tâche : {task_snip}\nRésultat : {out_snip}")
    };
    if let Err(e) =
        crate::commands::vector::memory_remember(app, "fact", role, conversation_id, &text)
    {
        eprintln!("[memory] remember failed (non-fatal): {e}");
    }
}

/// Render a slice of history turns into a plain-text transcript the summariser
/// (and the episodic-memory embedding) can read. Tool calls/results are
/// flattened to short lines so the summary captures WHAT happened without the
/// full payloads.
fn transcript_excerpt(turns: &[AgentMessage]) -> String {
    let mut s = String::new();
    for m in turns {
        match m {
            AgentMessage::Text { role, content } => {
                if role == "system" {
                    continue; // seed/skills/lessons — not part of the episode
                }
                let c: String = content.chars().take(800).collect();
                s.push_str(&format!("{role}: {c}\n"));
            }
            AgentMessage::AssistantWithTools { content, tool_calls } => {
                if !content.trim().is_empty() {
                    let c: String = content.chars().take(400).collect();
                    s.push_str(&format!("assistant: {c}\n"));
                }
                for tc in tool_calls {
                    let args: String = tc.arguments.chars().take(160).collect();
                    s.push_str(&format!("  → tool {}({args})\n", tc.name));
                }
            }
            AgentMessage::ToolResults(results) => {
                for r in results {
                    let head: String = r.content.chars().take(200).collect();
                    let tag = if r.is_error { "error" } else { "ok" };
                    s.push_str(&format!("  ← {} [{tag}]: {head}\n", r.name));
                }
            }
            AgentMessage::UserImage { text, .. } => {
                let t: String = text.chars().take(120).collect();
                s.push_str(&format!("user(image): {t}\n"));
            }
        }
    }
    s
}

/// Estimation pessimiste du coût en tokens d'UN message (cf. `CHARS_PER_TOKEN`).
/// `chars().count()` = scalaires Unicode (pas bytes) : le français accentué ne
/// sur-compte pas (cohérent avec `RECALL_SNIPPET_CHARS`).
fn estimate_msg_tokens(m: &AgentMessage) -> usize {
    match m {
        AgentMessage::Text { role, content } => {
            (role.chars().count() + content.chars().count()) / CHARS_PER_TOKEN
        }
        AgentMessage::AssistantWithTools { content, tool_calls } => {
            let chars = content.chars().count()
                + tool_calls
                    .iter()
                    .map(|tc| tc.name.chars().count() + tc.arguments.chars().count())
                    .sum::<usize>();
            chars / CHARS_PER_TOKEN
        }
        AgentMessage::ToolResults(results) => results
            .iter()
            .map(|r| (r.name.chars().count() + r.content.chars().count()) / CHARS_PER_TOKEN)
            .sum(),
        AgentMessage::UserImage { text, data_url } => {
            text.chars().count() / CHARS_PER_TOKEN
                + if data_url.is_empty() { 0 } else { IMAGE_TOKENS }
        }
    }
}

/// Estimation du coût total d'un historique — tête système INCLUSE (elle consomme
/// la fenêtre même si elle n'est jamais repliée).
fn estimate_tokens(history: &[AgentMessage]) -> usize {
    history.iter().map(estimate_msg_tokens).sum()
}

/// Budget de déclenchement : `fraction × fenêtre`, plafonné par `fenêtre − marge`.
/// La marge absolue domine sur petite fenêtre (réserve pour la réponse + l'erreur
/// d'estimation : 8k → 5192) ; la fraction domine sur grande fenêtre (1M → 750k).
fn compaction_budget(window: usize) -> usize {
    let frac = (window as f64 * COMPACTION_BUDGET_FRACTION) as usize;
    frac.min(window.saturating_sub(COMPACTION_BUDGET_MARGIN_TOKENS))
}

/// Décide PUREMENT (sans I/O ni LLM) si/où compacter. Renvoie `Some(cut)` —
/// l'indice de fin (exclusif) du slab des plus vieux tours à replier en un seul
/// résumé — ou `None` si rien à faire. Pur ⇒ testable en isolation.
fn plan_compaction_cut(history: &[AgentMessage], window: usize) -> Option<usize> {
    // La tête système (seed + skills + lessons + recall) n'est JAMAIS repliée :
    // c'est le contexte permanent de l'agent. Tout ce qui suit est un vrai tour
    // de dialogue éligible à la compaction.
    let head = history
        .iter()
        .take_while(|m| matches!(m, AgentMessage::Text { role, .. } if role == "system"))
        .count();
    let dialogue_len = history.len().saturating_sub(head);
    if dialogue_len <= COMPACTION_KEEP_TAIL_TURNS {
        return None; // pas assez de dialogue pour replier quoi que ce soit
    }

    let budget = compaction_budget(window);
    let total = estimate_tokens(history);
    if total < budget {
        return None; // sous le budget → no-op
    }

    // Fold ADAPTATIF : replier les plus vieux tours jusqu'à repasser sous la cible
    // d'hystérésis, en gardant les `KEEP_TAIL` derniers verbatim et en repliant au
    // moins `FOLD_MIN` tours. Trigger ET fold en tokens (même unité) ⇒ une passe
    // ramène le cas courant nettement sous le budget. Cas limites (slab très lourd
    // borné par `max_cut`, ou walk-back orphan qui recule la coupe) : on peut
    // re-déclencher au tour suivant, mais chaque passe remplace le slab par un
    // recap plus court → `total` décroît, ça converge (pas de churn non borné).
    let target = (budget as f64 * COMPACTION_RELAX_FRACTION) as usize;
    let max_cut = history.len() - COMPACTION_KEEP_TAIL_TURNS;
    let mut folded_tokens = 0usize;
    let mut cut = head;
    while cut < max_cut {
        folded_tokens += estimate_msg_tokens(&history[cut]);
        cut += 1;
        let kept = total.saturating_sub(folded_tokens) + RECAP_EST_TOKENS;
        if kept <= target && (cut - head) >= COMPACTION_FOLD_MIN_TURNS {
            break;
        }
    }

    // A compacted slab MUST NOT end on an assistant turn that opened tool_calls
    // without its matching tool results in the SAME slab — otherwise the kept
    // tail would start with orphan ToolResults (no preceding tool_use → provider
    // 400). Walk the cut point back until it lands AFTER a complete pair.
    while cut > head + 1 {
        let dangling_call = matches!(history[cut - 1], AgentMessage::AssistantWithTools { .. });
        let orphan_result = matches!(history.get(cut), Some(AgentMessage::ToolResults(_)));
        if dangling_call || orphan_result {
            cut -= 1;
        } else {
            break;
        }
    }
    if cut <= head + 1 {
        return None; // couldn't find a clean cut — skip this round
    }
    Some(cut)
}

/// Un endpoint local (sondable) : Ollama, ou une base_url qui pointe sur la
/// machine (llama.cpp openai-compat tourne sur 127.0.0.1:8090 par défaut).
fn is_local_endpoint(protocol: &str, base_url: &str) -> bool {
    protocol == "ollama"
        || ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]
            .iter()
            .any(|h| base_url.contains(h))
}

/// Sonde best-effort le vrai n_ctx d'un serveur local. `None` sur toute erreur
/// (serveur éteint, format inattendu, timeout) ⇒ l'appelant retombe sur le repli.
/// - Ollama (`/api/show`)  : `parameters` « num_ctx N » (runtime, préféré car
///   Ollama peut charger un n_ctx inférieur au max de l'archi), sinon
///   `model_info["<arch>.context_length"]`.
/// - llama.cpp (`/props`)  : `n_ctx` (top-level ou `default_generation_settings`)
///   = le n_ctx RÉELLEMENT chargé pour ce GGUF.
/// URL racine = `base_url` sans suffixe `/v1`. Timeout court (3 s).
async fn probe_local_context_window(
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
) -> Option<usize> {
    let trimmed = base_url.trim_end_matches('/');
    let root = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    let timeout = std::time::Duration::from_secs(3);

    if protocol == "ollama" {
        let resp = client
            .post(format!("{root}/api/show"))
            .json(&serde_json::json!({ "model": model, "name": model }))
            .timeout(timeout)
            .send()
            .await
            .ok()?;
        let v: serde_json::Value = resp.json().await.ok()?;
        // 1) parameters : blob texte multi-lignes « clé valeur ».
        if let Some(params) = v.get("parameters").and_then(|p| p.as_str()) {
            for line in params.lines() {
                let mut it = line.split_whitespace();
                if it.next() == Some("num_ctx") {
                    if let Some(n) = it.next().and_then(|s| s.parse::<usize>().ok()) {
                        return Some(n);
                    }
                }
            }
        }
        // 2) model_info : clé se terminant par « .context_length ».
        if let Some(info) = v.get("model_info").and_then(|m| m.as_object()) {
            for (k, val) in info {
                if k.ends_with(".context_length") {
                    if let Some(n) = val.as_u64() {
                        return Some(n as usize);
                    }
                }
            }
        }
        return None;
    }

    // llama.cpp (openai-compat) : GET /props.
    let resp = client
        .get(format!("{root}/props"))
        .timeout(timeout)
        .send()
        .await
        .ok()?;
    let v: serde_json::Value = resp.json().await.ok()?;
    if let Some(n) = v.get("n_ctx").and_then(|x| x.as_u64()) {
        return Some(n as usize);
    }
    if let Some(n) = v
        .get("default_generation_settings")
        .and_then(|g| g.get("n_ctx"))
        .and_then(|x| x.as_u64())
    {
        return Some(n as usize);
    }
    None
}

/// Résout la fenêtre de contexte du modèle actif, UNE fois par run : sonde locale
/// → source de vérité `model_capabilities` pour le distant. Best-effort : ne
/// bloque jamais le run.
async fn resolve_context_window(
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
) -> usize {
    // Endpoints LOCAUX d'abord : on sonde le VRAI n_ctx. Un GGUF servi en local
    // peut porter un nom « claude-… » / « gpt-… » / « …-gemini » (distill, merge,
    // alias) ; le matcher par nom renverrait une grande fenêtre cloud et on ne
    // compacterait jamais une fenêtre réelle de 8k → précisément le 400 « context
    // exceeded » que cette feature existe pour empêcher. Si la sonde échoue, repli
    // conservateur (et NON la valeur model_capabilities, qui suppose « fort » pour
    // un nom inconnu en openai-compat → trop grande pour un local).
    if is_local_endpoint(protocol, base_url) {
        if let Some(w) = probe_local_context_window(client, protocol, base_url, model).await {
            // Garde-fou contre une valeur aberrante (0, ou un chiffre délirant).
            return w.clamp(2048, 2_000_000);
        }
        return LOCAL_WINDOW_FALLBACK;
    }
    // Cloud / distant : la fenêtre vient de la SOURCE DE VÉRITÉ unique
    // (`model_capabilities`, calquée sur le nom de modèle) — pas de table dupliquée
    // ici (cf. la lane « capacité par modèle »).
    crate::commands::model_capabilities::capabilities(protocol, model).context_window as usize
}

/// COMPACTION — once the live history's estimated token footprint crosses the
/// budget derived from the model's context `window`, fold the oldest dialogue
/// turns (after the leading system blocks) into ONE episodic summary, write that
/// summary to memory, and REPLACE the folded turns with a single recap message
/// kept in context. Token-driven trigger AND fold (adaptive size via
/// `plan_compaction_cut`) — no fixed turn count. Old turns are RESUMED, not
/// dropped at a hard limit.
///
/// `summarise` is the async closure that turns the transcript excerpt into a
/// summary (an LLM sub-call). It is invoked at most once per compaction. On any
/// failure (summary errored/empty) we DON'T mutate history — better to keep the
/// full (bloated) history one more turn than to silently lose context.
///
/// Returns `true` when a compaction actually happened (history mutated).
async fn maybe_compact<F, Fut>(
    app: &AppHandle,
    history: &mut Vec<AgentMessage>,
    agent_id: &str,
    role: &str,
    conversation_id: Option<&str>,
    window: usize,
    summarise: F,
) -> bool
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    // Pure decision (trigger + adaptive fold cut). `None` ⇒ nothing to do.
    let cut = match plan_compaction_cut(history, window) {
        Some(c) => c,
        None => return false,
    };
    // `fold_start` = leading system blocks (seed + skills + lessons + recall):
    // NEVER folded. Recomputed here — identical to the `head` `plan_compaction_cut`
    // used (history is unchanged between the two).
    let fold_start = history
        .iter()
        .take_while(|m| matches!(m, AgentMessage::Text { role, .. } if role == "system"))
        .count();

    let excerpt = transcript_excerpt(&history[fold_start..cut]);
    if excerpt.trim().is_empty() {
        return false;
    }
    let summary = match summarise(excerpt).await {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        Ok(_) => return false,
        Err(e) => {
            eprintln!("[memory] compaction summary failed (keeping full history): {e}");
            return false;
        }
    };

    // Persist the episode to memory so it's recallable in FUTURE runs too.
    if let Err(e) =
        crate::commands::vector::memory_remember(app, "episode", role, conversation_id, &summary)
    {
        eprintln!("[memory] compaction episode write failed (non-fatal): {e}");
    }

    // Replace the folded slab with ONE recap message kept in context. role=user
    // so it slots in legally between the system head and the kept dialogue tail
    // (and coalesces cleanly with Anthropic alternation downstream).
    let recap = AgentMessage::Text {
        role: "user".to_string(),
        content: format!(
            "[Mémoire — résumé des tours précédents (compactés pour tenir en contexte)]\n{summary}"
        ),
    };
    let folded = cut - fold_start;
    history.splice(fold_start..cut, std::iter::once(recap));
    let _ = persist_and_emit(
        app,
        &AgentEvent::MemoryCompacted {
            agent_id: agent_id.to_string(),
            role: role.to_string(),
            folded,
        },
    );
    true
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
    // Phase 3 — worktree-per-agent isolation. When `true`, the agent runs inside
    // a FRESH git worktree on its own branch (off the committed HEAD); all its
    // tools + the run_command sandbox retarget there automatically (via
    // `workspace_override`), and after the run its changes are merged back into
    // the user's tree (or kept for manual review on conflict). DEFAULT `false`
    // everywhere — no current caller opts in, so the in-place flow is unchanged.
    // Ignored when `workspace_override` is already Some (Atelier) or `read_only`
    // (Plan): those never isolate.
    isolate: bool,
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
    // AM-2 — keep a copy of the seed task before it moves into history; the
    // `remember()` hook (after the run) labels the stored result with it.
    let remember_task = task.clone();
    history.push(AgentMessage::Text {
        role: "user".to_string(),
        content: task,
    });

    // Phase 3 — worktree-per-agent isolation. When the caller opted in
    // (`isolate=true`) AND we are on the real workspace (no override) AND we are
    // allowed to mutate (not read_only), spin up a FRESH git worktree on its own
    // branch off the committed HEAD and retarget the whole run there by setting
    // `workspace_override`. Every tool + the run_command LOW-integrity sandbox
    // then resolves against the worktree automatically (no tool-code change), and
    // the checkpoint block below auto-skips (worktree IS the rollback unit).
    //
    // Strictly best-effort and NEVER blocking: a missing workspace, a non-git
    // dir, or a worktree-creation failure logs and continues IN-PLACE (the exact
    // pre-Phase-3 behaviour). `iso_root`/`iso_entry` carry the merge-back context
    // to `finalize_isolation` after the run; they stay `None` when we didn't
    // isolate, so the finalize step is a no-op on every existing path.
    let mut workspace_override = workspace_override;
    let mut iso_root: Option<PathBuf> = None;
    let mut iso_entry: Option<crate::commands::worktree::WorktreeEntry> = None;
    if isolate && workspace_override.is_none() && !read_only {
        if let Some(root) = get_workspace_root(&app) {
            if root.join(".git").exists() {
                match crate::commands::worktree::create_inner(&root, None, Some(&role)).await {
                    Ok(entry) => {
                        eprintln!(
                            "[agents] isolation: worktree {} on branch {} (agent={agent_id})",
                            entry.path, entry.branch
                        );
                        let _ = persist_and_emit(
                            &app,
                            &AgentEvent::WorktreeStarted {
                                agent_id: agent_id.clone(),
                                path: entry.path.clone(),
                                branch: entry.branch.clone(),
                            },
                        );
                        workspace_override = Some(PathBuf::from(&entry.path));
                        iso_root = Some(root);
                        iso_entry = Some(entry);
                    }
                    Err(e) => {
                        eprintln!("[agents] isolation skipped (worktree create failed): {e}");
                        let _ = persist_and_emit(
                            &app,
                            &AgentEvent::WorktreeSkipped {
                                agent_id: agent_id.clone(),
                                reason: format!("espace isolé indisponible ({e})"),
                            },
                        );
                    }
                }
            } else {
                eprintln!(
                    "[agents] isolation skipped: workspace is not a git repo (agent={agent_id})"
                );
                let _ = persist_and_emit(
                    &app,
                    &AgentEvent::WorktreeSkipped {
                        agent_id: agent_id.clone(),
                        reason: "ce dossier n'est pas encore suivi par git".to_string(),
                    },
                );
            }
        } else {
            eprintln!("[agents] isolation skipped: no workspace open (agent={agent_id})");
            let _ = persist_and_emit(
                &app,
                &AgentEvent::WorktreeSkipped {
                    agent_id: agent_id.clone(),
                    reason: "aucun workspace ouvert".to_string(),
                },
            );
        }
    }

    // Lot 0 — auto-checkpoint du working-tree AVANT que l'agent agisse, pour que
    // l'utilisateur puisse annuler tout le run d'un clic (« laisse tourner, annule
    // si moche »). Ref fantôme refs/shugu/turn/<agent_id> — ne touche jamais
    // l'index/HEAD/branches de l'utilisateur (cf. snapshot.rs). Sauté pour le
    // dossier jetable de l'Atelier (workspace_override Some) et les runs Plan
    // (read_only, aucune mutation). Sauté aussi quand on isole (workspace_override
    // devient Some ci-dessus → le worktree EST l'unité de rollback). Best-effort :
    // un échec (pas de workspace, pas un dépôt git) est loggé et le run continue —
    // un checkpoint ne doit JAMAIS bloquer un agent. Récupérable via
    // `shugu_snapshot_list`, annulable via `shugu_snapshot_revert` (turn_id =
    // agent_id).
    if workspace_override.is_none() && !read_only {
        if let Some(root) = get_workspace_root(&app) {
            if root.join(".git").exists() {
                match crate::commands::snapshot::checkpoint_inner(&root, &agent_id).await {
                    Ok(snap) => eprintln!(
                        "[agents] checkpoint {} (turn_id={})",
                        snap.ref_name, snap.turn_id
                    ),
                    Err(e) => eprintln!("[agents] checkpoint ignoré: {e}"),
                }
            }
        }
    }

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
            conversation_id.as_deref(),
            0, // depth racine — un run top-level n'est jamais lui-même un sous-agent
        ) => r,
        _ = abort.notified() => {
            mark_killed(&app, &agent_id);
            // Phase 3 — killed mid-flight: DISCARD the isolated worktree (its
            // edits are abandoned with the run). No-op when not isolating.
            // Best-effort + non-panicking on the kill path.
            if let (Some(root), Some(entry)) = (iso_root.as_ref(), iso_entry.as_ref()) {
                let _ = crate::commands::worktree::cleanup_inner(
                    root,
                    Some(&entry.id),
                    true,
                    false,
                )
                .await;
                let _ = persist_and_emit(
                    &app,
                    &AgentEvent::WorktreeFinalized {
                        agent_id: agent_id.clone(),
                        outcome: "discarded".to_string(),
                        branch: None,
                        path: None,
                        commit: None,
                        diff: None,
                        reason: None,
                    },
                );
            }
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
            // AM-2 — remember() hook: write the salient result of this run into
            // the orchestrated `memory` collection so a future run can recall it.
            // Best-effort; runs BEFORE `output` is moved into the Complete event.
            remember_run(
                &app,
                &role,
                conversation_id.as_deref(),
                &remember_task,
                &output,
            );
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
            // Phase 3 — run succeeded: commit the worktree and merge it back into
            // the user's tree (or keep it for manual review on conflict/dirty).
            // No-op when not isolating.
            if let (Some(root), Some(entry)) = (iso_root.as_ref(), iso_entry.as_ref()) {
                finalize_isolation(&app, root, entry, &agent_id, IsolationKind::Success).await;
            }
            if let Ok(mut g) = state.lock() {
                g.remove(&agent_id);
            }
        }
        Err(e) => {
            finish_error(&app, &state, &agent_id, &e);
            // Phase 3 — run errored: commit whatever the agent produced and KEEP
            // the worktree + branch for manual review (never auto-merge a failed
            // run). No-op when not isolating.
            if let (Some(root), Some(entry)) = (iso_root.as_ref(), iso_entry.as_ref()) {
                finalize_isolation(&app, root, entry, &agent_id, IsolationKind::Error).await;
            }
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Phase 3 — worktree isolation finalize
// ────────────────────────────────────────────────────────────────────

/// How the isolated run ended — decides the merge-back policy.
enum IsolationKind {
    /// The tool loop returned `Ok` — we may attempt a merge-back.
    Success,
    /// The tool loop returned `Err` — never auto-merge; keep for review.
    Error,
}

/// Finalize an isolated agent run: commit its worktree, then either merge the
/// branch back into the user's tree (on success + a clean merge) or KEEP the
/// worktree + branch for manual review (on conflict, dirty target, error, or a
/// commit/merge failure). Emits exactly one `AgentEvent::WorktreeFinalized`
/// describing the outcome. Entirely best-effort and non-panicking: any git
/// failure degrades to "keep + review" rather than disturbing the user's tree.
///
/// Only ever called when the run actually isolated (`iso_root`/`iso_entry` are
/// `Some`); on every non-isolated path this code never runs.
async fn finalize_isolation(
    app: &AppHandle,
    root: &std::path::Path,
    entry: &crate::commands::worktree::WorktreeEntry,
    agent_id: &str,
    kind: IsolationKind,
) {
    use crate::commands::worktree::{
        cleanup_inner, commit_worktree, current_branch, diff_summary,
    };

    let wt_path = PathBuf::from(&entry.path);

    // Helper: emit a "keep for manual review" finalize carrying the branch diff.
    // Used for every non-merge outcome (conflict, dirty target, detached HEAD,
    // errors). The worktree + branch are intentionally left on disk.
    //
    // The review diff is computed against the root's CURRENT branch (or `HEAD`
    // when detached), NOT the stale fork OID `entry.base` (M1): `diff_summary`
    // uses the three-dot range so only the agent's own commits show, never work
    // the user's branch already has from advancing after the worktree was
    // created.
    async fn emit_keep_for_review(
        app: &AppHandle,
        root: &std::path::Path,
        entry: &crate::commands::worktree::WorktreeEntry,
        agent_id: &str,
        reason: &str,
    ) {
        let target = current_branch(root).await.unwrap_or_else(|| "HEAD".to_string());
        let diff = diff_summary(root, &entry.branch, &target)
            .await
            .unwrap_or_default();
        let _ = persist_and_emit(
            app,
            &AgentEvent::WorktreeFinalized {
                agent_id: agent_id.to_string(),
                outcome: "diff".to_string(),
                branch: Some(entry.branch.clone()),
                path: Some(entry.path.clone()),
                commit: None,
                diff: if diff.trim().is_empty() { None } else { Some(diff) },
                reason: Some(reason.to_string()),
            },
        );
    }

    // 1. Commit whatever the agent left in the worktree.
    let committed = commit_worktree(&wt_path, &format!("shugu agent {agent_id}")).await;

    match (kind, committed) {
        // ── Run errored — never auto-merge. Commit what exists (best-effort),
        //    keep the worktree, surface the diff so the user can review it. ──
        (IsolationKind::Error, _) => {
            emit_keep_for_review(app, root, entry, agent_id, "error — review manually").await;
        }

        // ── Success, but the commit step itself failed — keep for review. ──
        (IsolationKind::Success, Err(e)) => {
            eprintln!("[agents] isolation commit failed (agent={agent_id}): {e}");
            emit_keep_for_review(app, root, entry, agent_id, "commit failed — review manually")
                .await;
        }

        // ── Success with nothing to commit — clean up silently. ──
        (IsolationKind::Success, Ok(None)) => {
            let _ = cleanup_inner(root, Some(&entry.id), true, false).await;
            let _ = persist_and_emit(
                app,
                &AgentEvent::WorktreeFinalized {
                    agent_id: agent_id.to_string(),
                    outcome: "no-changes".to_string(),
                    branch: None,
                    path: None,
                    commit: None,
                    diff: None,
                    reason: None,
                },
            );
        }

        // ── Success with a commit — MERGE-BACK OPT-IN (choix utilisateur). ──
        //    On NE merge PLUS automatiquement. Le worktree est commité (ci-dessus)
        //    et on émet le diff pour REVUE : l'utilisateur déclenche le merge réel
        //    (commande `worktree_merge_back`) ou le rejet (`worktree_discard`)
        //    depuis l'UI. Son checkout principal reste INTACT entre-temps. Tout le
        //    merge réel (MergeLock, HEAD-détachée, conflits) vit désormais dans la
        //    commande Tauri user-initiated, plus ici → « ton agent travaille seul,
        //    tu relis le diff, tu merges ou tu jettes ».
        (IsolationKind::Success, Ok(Some(_oid))) => {
            emit_keep_for_review(
                app,
                root,
                entry,
                agent_id,
                "prêt — relis le diff, puis merge ou jette",
            )
            .await;
        }
    }
}

// ────────────────────────────────────────────────────────────────────
// Délégation : sous-agent à contexte isolé (Phase B)
// ────────────────────────────────────────────────────────────────────

/// Profondeur de délégation max (0 = run racine). À 2 : racine → enfant →
/// petit-enfant (qui ne voit plus `delegate`). Borne mécaniquement l'explosion.
const MAX_DELEGATION_DEPTH: u32 = 2;

/// Timeout d'un sous-run délégué (s). Un sous-agent qui patine ne pend pas le
/// parent indéfiniment (le parent occupe un slot pendant qu'il attend).
const DELEGATE_TIMEOUT_SECS: u64 = 600;

/// System prompt du sous-agent délégué : contexte isolé + contrat de handoff.
const DELEGATE_CHILD_PROMPT: &str = "Tu es un SOUS-AGENT à contexte ISOLÉ, lancé par un agent parent pour une sous-tâche précise et auto-suffisante. Tu n'as AUCUN accès à la conversation du parent — tout ce dont tu as besoin est dans la tâche ci-dessous. Exécute-la, VÉRIFIE ton travail avec run_command (build/tests) quand c'est pertinent, puis termine par un bloc :\n\n## RÉSULTAT\n<2-4 phrases : ce que tu as fait + le verdict de ta vérification>\n\n## FAITS\n- fichiers : <file:line des points clés à inspecter>\n- vérif : <commande lancée → résultat observé>\n\nLes FAITS seront RE-VÉRIFIÉS par l'environnement (delta du statut git réel) — ne prétends pas un succès que tu n'as pas obtenu.";

/// Compose le handoff renvoyé au PARENT : prose compressée (étiquetée NON
/// vérifiée) + bloc FAITS capté de l'environnement (le delta du statut git —
/// chemins touchés PENDANT le sous-run — est la vérité-terrain que la prose
/// de l'enfant ne peut pas falsifier).
fn format_delegate_handoff(
    output: &str,
    diff_stat: Option<&str>,
    child_branch: Option<&str>,
    iterations: u32,
    tool_errors: u32,
    error: Option<&str>,
) -> String {
    let prose: String = output.chars().take(800).collect();
    let mut s = String::from("## RÉSULTAT (sous-agent — prose, NON vérifiée)\n");
    s.push_str(prose.trim());
    s.push_str("\n\n## FAITS (capturés de l'environnement — vérifiables)\n");
    match diff_stat {
        Some(d) if !d.trim().is_empty() => {
            s.push_str("- fichiers touchés pendant le sous-run (delta git status) :\n");
            for line in d.lines() {
                s.push_str("    ");
                s.push_str(line);
                s.push('\n');
            }
        }
        _ => s.push_str("- fichiers touchés pendant le sous-run : AUCUN\n"),
    }
    s.push_str(&format!(
        "- itérations : {iterations}   tool errors : {tool_errors}\n"
    ));
    if let Some(b) = child_branch {
        s.push_str(&format!(
            "- branche worktree : {b}  (relis/merge via la tuile Git)\n"
        ));
    }
    if let Some(e) = error {
        s.push_str(&format!(
            "\n⚠ Le sous-agent n'a PAS terminé normalement : {e}\n"
        ));
    }
    s
}

/// Insère un handle agent dans le registre global. Forme `match`+`return` (et
/// non `if let` traînant) pour un drop order propre du `MutexGuard` (évite E0597).
fn registry_insert(app: &AppHandle, id: &str, handle: super::AgentHandle) {
    let registry = app.state::<super::AgentManagerState>().0.clone();
    let mut g = match registry.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    g.insert(id.to_string(), handle);
}

/// Retire un handle agent du registre global (best-effort).
fn registry_remove(app: &AppHandle, id: &str) {
    let registry = app.state::<super::AgentManagerState>().0.clone();
    let mut g = match registry.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    g.remove(id);
}

/// Lance un SOUS-AGENT délégué à contexte ISOLÉ, l'attend (timeout + abort en
/// cascade), et renvoie un HANDOFF machine-vérifiable. Réutilise `tool_use_loop`
/// (le cœur awaitable) — ne touche PAS `run_agent_task` (zéro régression du
/// chemin agent principal). L'enfant : conversation_id=None (contexte vierge),
/// worktree frais (jamais auto-mergé → keep-for-review), provider/modèle hérités.
/// Hors du cap `MAX_CONCURRENT_AGENTS` (continuation du parent, bornée par depth).
#[allow(clippy::too_many_arguments)]
pub(super) async fn run_delegated_child(
    app: &AppHandle,
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    parent_id: &str,
    depth: u32,
    task: String,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    let child_id = uuid::Uuid::new_v4().to_string();
    let child_abort = std::sync::Arc::new(tokio::sync::Notify::new());

    // Registre : insérer le handle enfant SANS le check de capacité
    // (MAX_CONCURRENT_AGENTS). L'enfant est une CONTINUATION du parent (qui
    // occupe déjà un slot et attend) — la profondeur le borne. Permet aussi au
    // cascade kill (agent_kill) de le retrouver et l'abort.
    registry_insert(
        app,
        &child_id,
        super::AgentHandle {
            role: "delegate".to_string(),
            abort: child_abort.clone(),
        },
    );

    // INSERT de la row enfant (parent_id → arbre UI ; conversation_id NULL →
    // contexte vierge). Parité avec agent_spawn : un échec d'INSERT rollback le
    // handle ET fait échouer la délégation proprement (pas d'orphelin registre).
    let insert_res: Result<(), String> = (|| {
        let conn_mutex = get_conn(app)?;
        let conn = conn_mutex.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO agents
                (id, role, status, parent_id, model, task, conversation_id, created_at)
             VALUES (?1, 'delegate', 'running', ?2, ?3, ?4, NULL, ?5)",
            params![child_id, parent_id, model, task, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })();
    if let Err(e) = insert_res {
        registry_remove(app, &child_id);
        return Err(format!("insert sous-agent : {e}"));
    }
    let _ = persist_and_emit(
        app,
        &AgentEvent::Spawn {
            agent_id: child_id.clone(),
            parent_id: Some(parent_id.to_string()),
            role: "delegate".to_string(),
            task: task.clone(),
            model: model.to_string(),
            conversation_id: None,
        },
    );

    // Exécution DIRECTE (comme le run parent — décision 2026-07-02) : le
    // sous-agent travaille sur le VRAI workspace, pas sur une photo du dernier
    // commit où les fichiers non commités du user n'existent pas (sous-agent
    // aveugle). Aucune écriture concurrente : le parent ATTEND son enfant
    // (doctrine single-writer). Pour les FAITS du handoff, on capture le statut
    // git AVANT le sous-run ; le delta après coup liste les chemins réellement
    // touchés pendant le run (vérité-terrain non falsifiable par la prose).
    let workspace_override: Option<PathBuf> = None;
    let ws_root = get_workspace_root(app);
    let dirty_before: std::collections::HashSet<String> = match ws_root.as_ref() {
        Some(root) if root.join(".git").exists() => {
            crate::commands::worktree::dirty_paths(root)
                .await
                .unwrap_or_default()
                .into_iter()
                .collect()
        }
        _ => Default::default(),
    };

    // Historique enfant : prompt de délégation + tâche (contexte vierge).
    let mut history: Vec<AgentMessage> = vec![
        AgentMessage::Text {
            role: "system".to_string(),
            content: DELEGATE_CHILD_PROMPT.to_string(),
        },
        AgentMessage::Text {
            role: "user".to_string(),
            content: task,
        },
    ];
    let mut metrics = LoopMetrics::default();

    // Boucle enfant en course contre le timeout ET l'abort en cascade. Le bloc
    // borne l'emprunt mutable de `history`/`metrics` par le future ; après, on
    // lit `metrics` librement.
    let outcome: Result<(String, String), String> = {
        let loop_fut = tool_use_loop(
            app,
            client,
            protocol,
            base_url,
            model,
            api_key,
            chat_template_kwargs,
            &child_id,
            "delegate",
            &mut history,
            &mut metrics,
            workspace_override.clone(),
            false, // read_only : un sous-agent peut muter (déjà gardé par is_write_tool en mode Plan côté parent)
            None,  // advisor : pas de conseiller imbriqué en v1
            None,  // conversation_id : contexte vierge
            depth,
        );
        tokio::select! {
            r = tokio::time::timeout(
                std::time::Duration::from_secs(DELEGATE_TIMEOUT_SECS),
                loop_fut,
            ) => match r {
                Ok(inner) => inner,
                Err(_) => Err(format!("timeout après {DELEGATE_TIMEOUT_SECS}s")),
            },
            _ = child_abort.notified() => Err("annulé (kill en cascade)".to_string()),
        }
    };

    // L'enfant a fini sa boucle (succès / timeout / abort) — retirer son handle
    // du registre AVANT le nettoyage async (diff/finalize), pour ne pas laisser
    // un handle « zombie » qu'un second agent_kill retrouverait.
    registry_remove(app, &child_id);

    // Faits objectifs : chemins passés « dirty » PENDANT le sous-run (delta de
    // `git status` avant/après). Moins riche qu'un diff de branche, mais honnête
    // pour une exécution directe — les fichiers déjà modifiés AVANT le run sont
    // exclus, et la prose de l'enfant ne peut pas inventer ce delta.
    let mut diff_stat: Option<String> = None;
    let child_branch: Option<String> = None;
    if let Some(root) = ws_root.as_ref() {
        if root.join(".git").exists() {
            if let Ok(after) = crate::commands::worktree::dirty_paths(root).await {
                let delta: Vec<String> = after
                    .into_iter()
                    .filter(|p| !dirty_before.contains(p))
                    .collect();
                if !delta.is_empty() {
                    diff_stat = Some(delta.join("\n"));
                }
            }
        }
    }

    // MAJ DB + event terminal + handoff.
    let ms = start.elapsed().as_millis() as u64;
    let handoff = match &outcome {
        Ok((output, _reasoning)) => {
            if let Ok(conn_mutex) = get_conn(app) {
                if let Ok(conn) = conn_mutex.lock() {
                    let _ = conn.execute(
                        "UPDATE agents SET status='complete', finished_at=?1, output=?2 WHERE id=?3",
                        params![now_ms(), output, child_id],
                    );
                }
            }
            let _ = persist_and_emit(
                app,
                &AgentEvent::Complete {
                    agent_id: child_id.clone(),
                    output: output.clone(),
                    tokens_used: None,
                    reasoning: None,
                    ms,
                },
            );
            format_delegate_handoff(
                output,
                diff_stat.as_deref(),
                child_branch.as_deref(),
                metrics.iterations,
                metrics.tool_errors,
                None,
            )
        }
        Err(e) => {
            if let Ok(conn_mutex) = get_conn(app) {
                if let Ok(conn) = conn_mutex.lock() {
                    let _ = conn.execute(
                        "UPDATE agents SET status='error', finished_at=?1, error=?2 WHERE id=?3",
                        params![now_ms(), e, child_id],
                    );
                }
            }
            let _ = persist_and_emit(
                app,
                &AgentEvent::Error {
                    agent_id: child_id.clone(),
                    error: e.clone(),
                },
            );
            format_delegate_handoff(
                "(le sous-agent n'a pas produit de résultat)",
                diff_stat.as_deref(),
                child_branch.as_deref(),
                metrics.iterations,
                metrics.tool_errors,
                Some(e),
            )
        }
    };

    Ok(handoff)
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
    // AM-2 — conversation this run belongs to (chat delegation passes it; Atelier
    // / Grounded leave it None). Scopes the memories written by remember/compaction
    // so a future run in the SAME chat can recall them with conversation context.
    conversation_id: Option<&str>,
    // Profondeur de délégation (0 = run racine). Borne la récursion de l'outil
    // `delegate` (cf. MAX_DELEGATION_DEPTH) et conditionne sa présence au manifest.
    depth: u32,
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

    // AM-2 — recall() hook: BEFORE the first turn, search the orchestrated
    // `memory` collection for facts + episodic summaries relevant to this task
    // and inject them as a system block. Inserted at the same head position as
    // skills/lessons (a system message AFTER the user turn is rejected by
    // Anthropic). This is the half that makes long-session knowledge resurface
    // instead of evaporating; `remember_run` + compaction are the write halves.
    let (recall_block_text, recall_count) = recall_block(app, &task_text);
    if !recall_block_text.is_empty() {
        let pos = history.len().min(1);
        history.insert(
            pos,
            AgentMessage::Text {
                role: "system".to_string(),
                content: recall_block_text,
            },
        );
        let _ = persist_and_emit(
            app,
            &AgentEvent::MemoryRecalled {
                agent_id: agent_id.to_string(),
                role: role.to_string(),
                count: recall_count,
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
    // Capacité du modèle (source unique : model_capabilities) — calculée UNE
    // fois par run. Pilote la réduction de toolset pour les petits modèles. La
    // fenêtre de contexte de la compaction token-aware est résolue séparément par
    // `resolve_context_window` (qui sonde EN PLUS le n_ctx réel des serveurs
    // locaux). Additif : un modèle fort n'est jamais affecté.
    let caps = crate::commands::model_capabilities::capabilities(protocol, model);

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
        // Réduction de toolset pour les PETITS modèles (recommended_toolset =
        // Reduced) : ne garder que les outils core — un petit modèle se noie dans
        // un gros set et hallucine les arguments d'outils. Miroir des gates
        // read_only / capture ci-dessus. Additif : un modèle fort (Full) n'est
        // jamais affecté.
        if caps.recommended_toolset
            == crate::commands::model_capabilities::Toolset::Reduced
        {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| {
                    let name = t["name"].as_str().or_else(|| t["function"]["name"].as_str());
                    name.is_some_and(crate::commands::model_capabilities::is_core_small_tool)
                });
            }
        }
        // Outil `delegate` : visible UNIQUEMENT si le modèle supporte la délégation
        // ET qu'on n'est pas déjà à la profondeur max (évite la récursion sans fin
        // + ne donne l'orchestration qu'aux modèles capables). Retiré sinon.
        let allow_delegate = depth < MAX_DELEGATION_DEPTH
            && crate::commands::model_capabilities::model_supports_delegation(protocol, model);
        if !allow_delegate {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| {
                    let name = t["name"].as_str().or_else(|| t["function"]["name"].as_str());
                    name != Some("delegate")
                });
            }
        }
        Some(arr)
    };

    // Prompt par PALIER (source unique : model_capabilities) : un PETIT modèle
    // reçoit en plus un fragment de consignes directives, cohérent avec le
    // toolset déjà réduit ci-dessus ; un modèle FORT n'est jamais affecté
    // (`tier_prompt` → None). `has_tools = agent_tools.is_some()` : sur ollama
    // l'agent n'a PAS d'outils (`agent_tools == None`) → variante « plain ».
    // Inséré comme message system À LA SUITE de la tête (seed + skills + lessons
    // + recall), donc compté par le `take_while role=="system"` de la compaction
    // (jamais replié) et hoisté avec les autres blocs système en aval. Couvre
    // orchestrateur + atelier + grounded + sous-agents délégués (qui réutilisent
    // tous tool_use_loop).
    if let Some(frag) =
        crate::commands::model_capabilities::tier_prompt(caps.tier, agent_tools.is_some())
    {
        let head = history
            .iter()
            .take_while(|m| matches!(m, AgentMessage::Text { role, .. } if role == "system"))
            .count();
        history.insert(
            head,
            AgentMessage::Text {
                role: "system".to_string(),
                content: frag.to_string(),
            },
        );
    }

    // Résout la fenêtre de contexte du modèle UNE fois par run (sonde réseau
    // best-effort pour les serveurs locaux ; table pour le cloud ; repli 8k). Le
    // déclencheur de compaction plus bas est gaté sur le budget token dérivé de
    // CETTE fenêtre, plus sur un compteur de tours fixe.
    let context_window = resolve_context_window(client, protocol, base_url, model).await;

    // LOT 1 — plan vivant : le dernier `todo_write` parsé en task-graph. Quand il
    // change, on le ré-injecte au tour suivant (step 0a) pour ANCRER la boucle sur
    // le graphe — c'est ce qui rend le plan « exécutable » plutôt qu'advisory : le
    // modèle revoit son plan + la prochaine action même après compaction.
    let mut current_plan: Option<super::plan::TaskGraph> = None;
    let mut plan_dirty = false;

    while iteration < budget {
        metrics.iterations = iteration + 1;

        // ── 0a. Ancrage du plan — après une mise à jour `todo_write`, on ré-énonce
        //        le graphe (compact : checklist + tâches bloquées + prochaine
        //        action). UNE injection par mise à jour (bornée), façon deep-agents.
        //        Sauté sur la DERNIÈRE itération (le nudge final dit « n'appelle plus
        //        d'outils » — inutile de réclamer une mise à jour du plan).
        if plan_dirty && iteration + 1 < budget {
            if let Some(p) = &current_plan {
                history.push(AgentMessage::Text {
                    role: "user".to_string(),
                    content: format!(
                        "[Shugu system] Plan en cours — garde les statuts à jour via todo_write au fil de l'avancée :\n{}",
                        p.reminder_block()
                    ),
                });
            }
            plan_dirty = false;
        }
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
                    || tc.name == "browser_test"
                    || tc.name == "delegate"
                    // HITL : ask_user / submit_plan n'écrivent qu'un event + sentinel
                    // et n'ont PAS besoin d'un workspace → routés sur le chemin
                    // séquentiel (traité AVANT le gate workspace), sinon un tour ne
                    // contenant qu'eux tomberait en « no workspace open » et casserait
                    // le mode Plan interactif sans dossier ouvert.
                    || tc.name == "ask_user"
                    || tc.name == "submit_plan"
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
                    // AM-3 : les résultats web sont du contenu EXTERNE non fiable
                    // (vecteur d'injection classique) — on les clôture en bloc
                    // DONNÉES via le même contrat que tools.rs/mcp.rs. Les erreurs
                    // (champ manquant / échec réseau) sont des messages construits
                    // par Shugu, laissés tels quels.
                    let content = if is_error {
                        content
                    } else {
                        super::tools::wrap_untrusted("web", &content)
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
                    // AM-3 : page web = contenu EXTERNE non fiable → clôture DONNÉES.
                    let content = if is_error {
                        content
                    } else {
                        super::tools::wrap_untrusted("web", &content)
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
                } else if tc.name == "browser_test" {
                    // Outil navigateur (façon Cursor 2.0) : navigateur headless qui
                    // ouvre l'app de l'utilisateur, exécute des actions, lit la
                    // console + le DOM et capture. Vérification READ-ONLY → dispo
                    // aussi en mode Plan (comme web_fetch/capture_screen). Le contenu
                    // (console/DOM) est EXTERNE non fiable → clôture DONNÉES (AM-3).
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let root_opt = workspace_root.as_ref().map(|p| p.as_path());
                    let outcome = crate::commands::browser::browser_test_run(
                        app, root_opt, agent_id, &args,
                    )
                    .await;
                    // Chaque capture devient un event Screenshot pour la timeline du fil.
                    for (path, thumb) in &outcome.screenshots {
                        let _ = super::persist_and_emit(
                            app,
                            &super::AgentEvent::Screenshot {
                                agent_id: agent_id.to_string(),
                                tool_call_id: tc.id.clone(),
                                path: path.clone(),
                                thumb_data_url: thumb.clone(),
                            },
                        );
                    }
                    let content = if outcome.is_error {
                        outcome.summary
                    } else {
                        super::tools::wrap_untrusted("browser", &outcome.summary)
                    };
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: outcome.is_error,
                        content,
                    });
                } else if tc.name == "delegate" {
                    // Offload vers un SOUS-AGENT à contexte isolé. Le parent attend
                    // (await) et reçoit un handoff machine-vérifiable (diff réel +
                    // itérations), pas une simple prose. Box::pin casse la récursion
                    // async tool_use_loop → enfant → tool_use_loop.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let task = args["task"].as_str().unwrap_or("").trim().to_string();
                    let focus = args["focus_hint"].as_str().unwrap_or("").trim();
                    let expected = args["expected_artifacts"].as_str().unwrap_or("").trim();
                    let (content, is_error) = if read_only {
                        // Defense-in-depth : Plan mode interdit un sous-agent mutant
                        // (delegate ∈ is_write_tool → déjà hors manifest, mais M3 peut
                        // l'émettre en texte XML).
                        (PLAN_BLOCK_MSG.to_string(), true)
                    } else if task.is_empty() {
                        ("delegate: missing required field: task".to_string(), true)
                    } else if depth >= MAX_DELEGATION_DEPTH {
                        // Garde profondeur (ceinture + bretelles avec le filtre manifest).
                        (
                            format!("delegate: profondeur max ({MAX_DELEGATION_DEPTH}) atteinte — fais la sous-tâche toi-même"),
                            true,
                        )
                    } else {
                        let mut child_task = task.clone();
                        if !focus.is_empty() {
                            child_task.push_str(&format!("\n\nPoint de départ : {focus}"));
                        }
                        if !expected.is_empty() {
                            child_task.push_str(&format!("\n\nLivrable attendu : {expected}"));
                        }
                        match Box::pin(run_delegated_child(
                            app,
                            client,
                            protocol,
                            base_url,
                            model,
                            api_key,
                            chat_template_kwargs,
                            agent_id,
                            depth + 1,
                            child_task,
                        ))
                        .await
                        {
                            Ok(handoff) => (handoff, false),
                            Err(e) => (format!("delegate: {e}"), true),
                        }
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
                } else if tc.name == "ask_user" || tc.name == "submit_plan" {
                    // HITL — émet l'event (carte question/plan) + renvoie le sentinel
                    // qui termine le tour (break plus bas). Aucun workspace requis,
                    // donc traité ICI, avant le gate `workspace_root`.
                    acc.push(super::tools::execute_hitl_tool(tc, app, agent_id));
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

        // Human-in-the-loop par FIN DE TOUR : `ask_user` / `submit_plan` ont émis
        // leur event au dispatch et renvoyé le sentinel. On termine le tour
        // proprement (pas de pause in-process) — l'utilisateur répond via
        // `agent_continue`, qui relance un nouvel agent. La carte est rendue depuis
        // le transcript (event déjà persisté), donc l'output vide n'efface rien.
        if results
            .iter()
            .any(|r| !r.is_error && r.content.starts_with(super::tools::AGENT_PAUSE_SENTINEL))
        {
            return Ok((String::new(), reasoning));
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

        // LOT 1 — capture du plan : le dernier `todo_write` de ce tour devient le
        // graphe vivant, ré-injecté au tour suivant (step 0a). Parsé ICI tant que
        // `turn.tool_calls` est encore empruntable (il est MOVÉ dans l'historique
        // juste en dessous). Best-effort : un graphe invalide laisse le plan tel quel.
        for tc in &turn.tool_calls {
            if tc.name == "todo_write" {
                if let Ok(args) = serde_json::from_str::<serde_json::Value>(&tc.arguments) {
                    if let Some(graph) = super::plan::TaskGraph::parse(&args) {
                        current_plan = Some(graph);
                        plan_dirty = true;
                    }
                }
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

        // AM-2 — COMPACTION: once the live history outgrows its window, summarise
        // the oldest turns into one episodic memory (written to the `memory`
        // collection AND kept in context as a recap) instead of letting the
        // history grow unbounded — the orchestrated replacement for the old
        // silent 30-message drop. The summariser is a tool-less LLM sub-call on
        // the SAME model; on any failure the history is left intact (the closure
        // errors → maybe_compact no-ops). Awaited inline — the loop is already
        // inside the abort `tokio::select!`, so a kill still wins at the next
        // turn boundary.
        let _ = maybe_compact(app, history, agent_id, role, conversation_id, context_window, |excerpt| {
            summarise_turns(client, protocol, base_url, model, api_key, chat_template_kwargs, excerpt)
        })
        .await;

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

/// System prompt for the COMPACTION summariser (AM-2). It turns a transcript
/// excerpt of older turns into a dense, factual recap that preserves anything a
/// continuation would need — decisions made, files touched, command results,
/// open threads — while shedding verbosity. Plain text, no tools.
const COMPACTION_SYSTEM_PROMPT: &str = "You are a CONTEXT COMPACTOR for a coding agent. You are given a transcript excerpt of the OLDEST turns of an in-progress task — they are about to be removed from the live context to make room. Write a DENSE factual summary that lets the agent continue WITHOUT having read the originals.\n\nPreserve, concisely:\n- the goal / sub-goals established so far,\n- concrete decisions and the rationale,\n- files created or edited (paths) and what changed,\n- commands run and their OUTCOME (pass/fail, key errors),\n- facts discovered about the project,\n- anything still OPEN or unverified.\n\nDrop: chit-chat, repeated boilerplate, full file contents, full command output. Output ONLY the summary as compact prose or terse bullet lines — no preamble, no meta-commentary.";

/// COMPACTION summariser — a tool-less LLM sub-call that condenses a transcript
/// excerpt into an episodic summary. Mirrors `consult_advisor`'s provider
/// dispatch (no streaming, no tools). Returns `Err` on any provider failure so
/// `maybe_compact` leaves the history intact rather than losing turns to a bad
/// summary.
#[allow(clippy::too_many_arguments)]
async fn summarise_turns(
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    excerpt: String,
) -> Result<String, String> {
    let summary_history = vec![
        AgentMessage::Text {
            role: "system".to_string(),
            content: COMPACTION_SYSTEM_PROMPT.to_string(),
        },
        AgentMessage::Text {
            role: "user".to_string(),
            content: format!("Transcript excerpt to compact:\n\n{excerpt}"),
        },
    ];
    let mut sink = |_kind: &str, _chunk: &str| {};
    let turn = match protocol {
        "anthropic" => {
            let (messages, system) = build_anthropic_native(&summary_history);
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
            let messages = build_openai_messages(&summary_history);
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
            let messages: Vec<ChatMessage> = summary_history
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
        other => return Err(format!("compaction: unsupported protocol '{other}'")),
    };
    turn.map(|t| t.content.trim().to_string())
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
const PLAN_MODE_PROMPT: &str = "\n\n=== PLAN MODE (READ-ONLY) ===\nYou are in PLAN MODE. The write/exec tools (fs_write_file, fs_edit, run_command) are DISABLED for this turn — calling them will fail. Do NOT promise to write files or run commands.\n\nYour job is to UNDERSTAND and PROPOSE, not to act:\n1. Use the read tools (fs_list_dir, fs_read_file, fs_search) to investigate the real code as needed.\n2. If a choice is genuinely ambiguous (which stack, scope, or design direction), call `ask_user` with 1-4 clickable questions BEFORE finalizing — your turn ends and you are resumed with the user's answers.\n3. Use `todo_write` to sketch the steps you would take (it renders as a live checklist).\n4. When your plan is concrete, FINISH by calling `submit_plan(plan, title)` with the full plan in Markdown (which files you'd create/change, what each change does, how you'd verify it). Do NOT end in free text — `submit_plan` presents the plan to the user with « Approuver et exécuter » / « Continuer à planifier » buttons; approving switches you to Agent mode to execute it.";

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

    // ── AM-2 : compaction transcript excerpt (pure, no I/O) ───────────
    #[test]
    fn transcript_excerpt_skips_system_and_flattens_tools() {
        let h = vec![
            AgentMessage::Text { role: "system".into(), content: "SEED PROMPT".into() },
            AgentMessage::Text { role: "user".into(), content: "build a todo app".into() },
            AgentMessage::AssistantWithTools {
                content: "reading".into(),
                tool_calls: vec![tc("c1", "fs_read_file", r#"{"path":"a.ts"}"#)],
            },
            AgentMessage::ToolResults(vec![tr("c1", "fs_read_file", false, "FILE CONTENTS")]),
            AgentMessage::Text { role: "assistant".into(), content: "done".into() },
        ];
        let ex = transcript_excerpt(&h);
        // System block is NOT part of the episode.
        assert!(!ex.contains("SEED PROMPT"));
        // User + assistant turns are present.
        assert!(ex.contains("user: build a todo app"));
        assert!(ex.contains("assistant: reading"));
        assert!(ex.contains("assistant: done"));
        // Tool call + result are flattened to short lines.
        assert!(ex.contains("→ tool fs_read_file"));
        assert!(ex.contains("← fs_read_file [ok]"));
    }

    #[test]
    fn transcript_excerpt_marks_tool_errors() {
        let h = vec![AgentMessage::ToolResults(vec![tr(
            "c1",
            "run_command",
            true,
            "exit 1: boom",
        )])];
        let ex = transcript_excerpt(&h);
        assert!(ex.contains("← run_command [error]"));
        assert!(ex.contains("boom"));
    }

    #[test]
    fn transcript_excerpt_truncates_long_content() {
        // 2000-char assistant message → flattened line caps the content at 400.
        let long = "x".repeat(2000);
        let h = vec![AgentMessage::Text { role: "user".into(), content: long }];
        let ex = transcript_excerpt(&h);
        // "user: " prefix + at most 800 chars for a Text turn + newline.
        assert!(ex.len() < 900, "excerpt should be bounded, got {}", ex.len());
    }

    // ── AM-2 : token-aware compaction trigger (pure, no I/O) ──────────
    fn txt(role: &str, content: &str) -> AgentMessage {
        AgentMessage::Text { role: role.into(), content: content.into() }
    }

    #[test]
    fn estimate_tokens_divides_chars_by_three() {
        // role "system" (6) + content "abcdef" (6) = 12 chars / 3 = 4 tokens.
        assert_eq!(estimate_tokens(&[txt("system", "abcdef")]), 4);
    }

    #[test]
    fn estimate_tokens_image_is_flat_not_base64_length() {
        // A LIVE image adds IMAGE_TOKENS, never the (huge) base64 length.
        let huge_b64 = "A".repeat(100_000);
        let h = vec![AgentMessage::UserImage {
            text: "look".into(),
            data_url: format!("data:image/jpeg;base64,{huge_b64}"),
        }];
        assert_eq!(estimate_tokens(&h), "look".len() / CHARS_PER_TOKEN + IMAGE_TOKENS);
        // A pruned image (empty data_url) carries no flat visual cost.
        let pruned = vec![AgentMessage::UserImage { text: "look".into(), data_url: "".into() }];
        assert_eq!(estimate_tokens(&pruned), "look".len() / CHARS_PER_TOKEN);
    }

    #[test]
    fn compaction_budget_margin_dominates_small_window() {
        assert_eq!(compaction_budget(8_192), 5_192); // min(6144, 8192-3000)
        assert_eq!(compaction_budget(200_000), 150_000); // fraction dominates
        assert_eq!(compaction_budget(1_000_000), 750_000);
    }

    #[test]
    fn is_local_endpoint_detects_local_servers() {
        assert!(is_local_endpoint("ollama", "http://localhost:11434"));
        assert!(is_local_endpoint("openai", "http://127.0.0.1:8090"));
        assert!(!is_local_endpoint("openai", "https://api.minimax.io"));
        assert!(!is_local_endpoint("anthropic", "https://api.anthropic.com"));
    }

    #[test]
    fn plan_cut_none_under_budget() {
        // Small history, huge window → nothing to compact.
        let h = vec![txt("system", "seed"), txt("user", "hi"), txt("assistant", "hello"),
            txt("user", "more"), txt("assistant", "ok"), txt("user", "again")];
        assert_eq!(plan_compaction_cut(&h, 1_000_000), None);
    }

    #[test]
    fn plan_cut_none_when_dialogue_at_or_below_keep_tail() {
        // dialogue_len <= KEEP_TAIL → None even with a tiny window ("over budget").
        let h = vec![txt("system", "seed"), txt("user", "a"), txt("assistant", "b"),
            txt("user", "c"), txt("assistant", "d")]; // 4 dialogue turns
        assert_eq!(plan_compaction_cut(&h, 2_048), None);
    }

    #[test]
    fn plan_cut_folds_oldest_keeps_tail_and_drops_under_budget() {
        // 20 fat user turns (~300 tokens each) cross an 8k budget (5192).
        let fat = "x".repeat(896); // role "user" (4) + 896 = 900 chars / 3 = 300 tok
        let mut h = vec![txt("system", "seed")];
        for _ in 0..20 {
            h.push(txt("user", &fat));
        }
        let window = 8_192;
        let cut = plan_compaction_cut(&h, window).expect("should compact when over budget");
        // head == 1 (single leading system block).
        assert!(cut - 1 >= COMPACTION_FOLD_MIN_TURNS, "must fold at least FOLD_MIN turns");
        // Keep the last KEEP_TAIL dialogue turns verbatim.
        assert!(cut <= h.len() - COMPACTION_KEEP_TAIL_TURNS, "must keep the recent tail");
        // After folding [1..cut] into one recap, the estimate drops under budget.
        let kept_after = estimate_tokens(&h[..1]) + RECAP_EST_TOKENS + estimate_tokens(&h[cut..]);
        assert!(
            kept_after < compaction_budget(window),
            "kept {} should be < budget {}",
            kept_after,
            compaction_budget(window)
        );
    }

    #[test]
    fn plan_cut_never_leaves_orphan_tool_results() {
        // A tool pair sits exactly where the token-driven cut would land; the
        // orphan walk-back must move the cut so the kept tail does NOT start on
        // ToolResults and the folded slab does NOT end on a dangling tool_call.
        let fat = "z".repeat(1_492); // ~500 tokens per turn
        let mut h = vec![txt("system", "seed")];
        for _ in 0..5 {
            h.push(txt("user", &fat)); // idx 1..5
        }
        h.push(AgentMessage::AssistantWithTools {
            content: fat.clone(),
            tool_calls: vec![tc("c", "fs_read_file", "{}")],
        }); // idx 6
        h.push(AgentMessage::ToolResults(vec![tr("c", "fs_read_file", false, &fat)])); // idx 7
        for _ in 0..5 {
            h.push(txt("user", &fat)); // tail
        }
        let cut = plan_compaction_cut(&h, 8_192).expect("should compact");
        assert!(
            !matches!(h.get(cut), Some(AgentMessage::ToolResults(_))),
            "kept tail must not start on orphan ToolResults"
        );
        assert!(
            !matches!(h[cut - 1], AgentMessage::AssistantWithTools { .. }),
            "folded slab must not end on a dangling tool_call"
        );
    }
}
