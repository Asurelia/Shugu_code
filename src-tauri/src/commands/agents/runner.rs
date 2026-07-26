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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::params;
use tauri::{AppHandle, Manager};

use super::policy::ExecutionProfile;
use super::tools::{execute_tool, ToolCall, ToolResult};
use super::{get_conn, now_ms, persist_and_emit, AgentEvent, AgentHandle};
use crate::commands::chat::{self, AssistantTurn, ChatMessage};

/// Maximum tool-use rounds per agent run. Unifié à 24 depuis le pivot
/// exec-directe (2026-06-10) : TOUT agent peut maintenant exécuter du code,
/// et chaque cycle write→run-test→fix coûte une itération — l'agent a besoin
/// de marge pour voir un échec réel, corriger, relancer. Sur la DERNIÈRE
/// itération on exige un bilan texte ; un modèle qui demande encore des outils
/// est marqué incomplet au lieu de transformer des actions non exécutées en
/// faux succès.
const MAX_ITERATIONS: u32 = 24;

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
fn load_conversation_history(
    app: &AppHandle,
    conversation_id: &str,
    limit: u32,
) -> Vec<AgentMessage> {
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
            let mapped_role = if role == "ai" {
                "assistant"
            } else {
                role.as_str()
            };
            // Seuls user/assistant sont des tours de dialogue valides.
            if mapped_role != "user" && mapped_role != "assistant" {
                return None;
            }
            let text = text.unwrap_or_default();
            let content = if image == 1 {
                let t = text.trim();
                if t.is_empty() {
                    "[image attached]".to_string()
                } else {
                    t.to_string()
                }
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
            Some(AgentMessage::Text {
                role: mapped_role.to_string(),
                content,
            })
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
fn recall_block(
    app: &AppHandle,
    task: &str,
    workspace_id: Option<&str>,
    conversation_id: Option<&str>,
    role: &str,
) -> (String, usize) {
    if task.trim().is_empty() {
        return (String::new(), 0);
    }
    let hits = match crate::commands::vector::memory_recall(
        app,
        task,
        RECALL_TOP_K,
        workspace_id,
        conversation_id,
        Some(role),
    ) {
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
    workspace_id: Option<&str>,
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
    if let Err(e) = crate::commands::vector::memory_remember(
        app,
        "fact",
        role,
        conversation_id,
        workspace_id,
        &text,
    ) {
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
            AgentMessage::AssistantWithTools {
                content,
                tool_calls,
            } => {
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

/// Some tool failures cannot be repaired by another model turn. In particular,
/// Auto execution is fail-closed when the native sandbox cannot arm. Feeding
/// that same result back to the model only makes it retry equivalent shell
/// commands and burns the user's iteration/token budget. Surface the required
/// user action immediately while preserving every ToolResult event emitted by
/// the caller.
fn hard_execution_blocker(results: &[ToolResult]) -> Option<String> {
    results
        .iter()
        .find(|result| result.is_error && result.content.contains("sandbox Auto indisponible ("))
        .map(|_| {
            "Le sandbox Auto ne peut pas s'armer pour ce workspace. Aucune commande n'a été \
             exécutée directement. Active Full Access une seule fois pour cette session, puis \
             reprends le Goal ; les commandes suivantes ne demanderont pas de confirmation \
             individuelle."
                .to_string()
        })
}

/// Estimation pessimiste du coût en tokens d'UN message (cf. `CHARS_PER_TOKEN`).
/// `chars().count()` = scalaires Unicode (pas bytes) : le français accentué ne
/// sur-compte pas (cohérent avec `RECALL_SNIPPET_CHARS`).
fn estimate_msg_tokens(m: &AgentMessage) -> usize {
    match m {
        AgentMessage::Text { role, content } => {
            (role.chars().count() + content.chars().count()) / CHARS_PER_TOKEN
        }
        AgentMessage::AssistantWithTools {
            content,
            tool_calls,
        } => {
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

/// The provider sends the tool manifest beside every history request. It is not
/// represented by an `AgentMessage`, so reserve its estimated token cost before
/// applying the history budget. Without this, a schema-heavy local request can
/// exceed a real 8k/16k llama.cpp context even while `estimate_tokens(history)`
/// still appears below the trigger.
fn effective_history_window(context_window: usize, tools: Option<&serde_json::Value>) -> usize {
    let tool_tokens = tools
        .map(|manifest| manifest.to_string().chars().count() / CHARS_PER_TOKEN)
        .unwrap_or(0);
    context_window.saturating_sub(tool_tokens).max(2048)
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
    workspace_id: Option<&str>,
    window: usize,
    execution_profile: ExecutionProfile,
    workspace_root: Option<&std::path::Path>,
    trust_root: Option<&std::path::Path>,
    allow_project_config: bool,
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

    // P6.4 — PreCompact hooks : la compaction va réellement se produire (cut
    // décidé). Fail-open ; leur additionalContext est joint à l'historique
    // AVANT le résumé — il voyage donc dans l'excerpt résumé, pas seulement
    // dans la queue conservée. Hooks rechargés ici (compaction rare — évite
    // de threader hook_defs depuis la boucle).
    if super::hooks::hooks_enabled_for_profile(execution_profile) {
        if let Some(ws) = workspace_root {
            if enforce_run_workspace_binding(
                app,
                agent_id,
                trust_root,
                !execution_profile.is_read_only() || allow_project_config,
            )
            .is_err()
            {
                return false;
            }
            let defs =
                super::hooks::load_hooks_with_project_trust(app, Some(ws), allow_project_config);
            if !defs.is_empty() {
                let payload = super::hooks::build_payload(
                    super::hooks::HookEvent::PreCompact,
                    agent_id,
                    Some(ws),
                    execution_profile,
                    None,
                    None,
                    None,
                );
                let fire = super::hooks::fire(
                    app,
                    &defs,
                    super::hooks::HookEvent::PreCompact,
                    payload,
                    ws,
                    execution_profile,
                    agent_id,
                    None,
                    trust_root,
                )
                .await;
                for ctx in fire.contexts {
                    history.push(AgentMessage::Text {
                        role: "user".to_string(),
                        content: format!("[Shugu hook PreCompact] {ctx}"),
                    });
                }
            }
        }
    }

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
    if let Err(e) = crate::commands::vector::memory_remember(
        app,
        "episode",
        role,
        conversation_id,
        workspace_id,
        &summary,
    ) {
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
    Text {
        role: String,
        content: String,
    },
    AssistantWithTools {
        content: String,
        tool_calls: Vec<ToolCall>,
    },
    ToolResults(Vec<ToolResult>),
    /// Screenshot de l'outil `capture_screen`, ré-injecté comme tour USER
    /// multimodal juste après les tool results — openai-compat n'accepte pas
    /// d'image dans un message `role:"tool"`, et côté Anthropic
    /// `push_coalesced` fusionne légalement ce tour avec le message
    /// tool_result précédent. `data_url` vidée par `prune_user_images`
    /// (anti-bloat) → le builder retombe alors sur un message texte simple.
    UserImage {
        text: String,
        data_url: String,
    },
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
                // Some OpenAI-compatible servers (notably llama.cpp with the
                // Mistral v3 template) accept one optional leading `system`
                // message, then require strict user/assistant alternation.
                // Shugu composes several independent system blocks (identity,
                // skills, lessons, runtime contract). Merge adjacent system
                // blocks on the wire while preserving their order and
                // boundaries; permissive providers see equivalent content and
                // strict templates no longer reject the request before
                // inference.
                if matches!(role.as_str(), "system" | "user" | "assistant") {
                    // Controller reminders are internal metadata, not a new
                    // human turn. A strict Mistral tool template treats a
                    // `tool` result as the user side of the alternation, so a
                    // separate user reminder immediately after it becomes an
                    // illegal user/user pair. Preserve the reminder by folding
                    // it into the last tool result on the wire.
                    if role == "user" && content.starts_with("[Shugu system]") {
                        if let Some(previous) = out.last_mut().filter(|message| {
                            message.get("role").and_then(serde_json::Value::as_str) == Some("tool")
                                && message
                                    .get("content")
                                    .is_some_and(serde_json::Value::is_string)
                        }) {
                            let prior = previous
                                .get("content")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or_default();
                            previous["content"] = serde_json::Value::String(format!(
                                "{prior}\n\n[Controller reminder]\n{content}"
                            ));
                            continue;
                        }
                    }
                    if let Some(previous) = out.last_mut().filter(|message| {
                        message.get("role").and_then(serde_json::Value::as_str)
                            == Some(role.as_str())
                            && message.get("tool_calls").is_none()
                            && message
                                .get("content")
                                .is_some_and(serde_json::Value::is_string)
                    }) {
                        let prior = previous
                            .get("content")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default();
                        previous["content"] =
                            serde_json::Value::String(format!("{prior}\n\n{content}"));
                        continue;
                    }
                }
                out.push(serde_json::json!({ "role": role, "content": content }));
            }
            AgentMessage::AssistantWithTools {
                content,
                tool_calls,
            } => {
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

/// Translate the shared agent history into Ollama's native chat/tool shape.
/// Ollama omits tool-call ids and links results through `tool_name`, so this
/// builder keeps an internal id-to-name map while the common runtime retains
/// ids for lifecycle events and dispatch.
pub(crate) fn build_ollama_messages(history: &[AgentMessage]) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    let mut call_names: HashMap<String, String> = HashMap::new();
    for msg in history {
        match msg {
            AgentMessage::Text { role, content } => {
                out.push(serde_json::json!({ "role": role, "content": content }));
            }
            AgentMessage::AssistantWithTools {
                content,
                tool_calls,
            } => {
                let calls: Vec<serde_json::Value> = tool_calls
                    .iter()
                    .map(|call| {
                        call_names.insert(call.id.clone(), call.name.clone());
                        let args = serde_json::from_str::<serde_json::Value>(&normalize_tool_args(
                            &call.arguments,
                        ))
                        .unwrap_or_else(|_| serde_json::json!({}));
                        serde_json::json!({
                            "function": { "name": call.name, "arguments": args }
                        })
                    })
                    .collect();
                out.push(serde_json::json!({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": calls,
                }));
            }
            AgentMessage::ToolResults(results) => {
                for result in results {
                    out.push(serde_json::json!({
                        "role": "tool",
                        "content": result.content,
                        "tool_name": call_names
                            .get(&result.id)
                            .map(String::as_str)
                            .unwrap_or("unknown_tool"),
                    }));
                }
            }
            AgentMessage::UserImage { text, .. } => {
                // Shugu stores screenshots as data URLs while Ollama expects
                // raw base64 in `images`; retain the grounded textual note.
                out.push(serde_json::json!({ "role": "user", "content": text }));
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
            AgentMessage::AssistantWithTools {
                content,
                tool_calls,
            } => {
                let mut blocks: Vec<serde_json::Value> = Vec::new();
                if !content.trim().is_empty() {
                    blocks.push(serde_json::json!({ "type": "text", "text": content }));
                }
                for tc in tool_calls {
                    // Anthropic `tool_use.input` is a parsed JSON object, NOT the
                    // raw argument string OpenAI uses. Bad/empty args → {} so the
                    // request stays well-formed and the model sees its own error.
                    let input: serde_json::Value = serde_json::from_str(&tc.arguments)
                        .unwrap_or_else(|_| serde_json::json!({}));
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

fn enforce_run_workspace_binding(
    app: &AppHandle,
    agent_id: &str,
    trust_root: Option<&Path>,
    requires_trust: bool,
) -> Result<(), String> {
    let Some(expected) = trust_root else {
        return Ok(());
    };
    if get_workspace_root(app).as_deref() != Some(expected) {
        super::processes::kill_run_all(app, agent_id);
        return Err(
            "Le workspace ouvert a changé pendant le run ; exécution interrompue avant tout nouvel outil."
                .to_string(),
        );
    }
    if requires_trust && !crate::commands::project_trust::is_trusted(app, expected) {
        super::processes::kill_run_all(app, agent_id);
        return Err(
            "La confiance de ce projet a été révoquée pendant le run ; exécution interrompue."
                .to_string(),
        );
    }
    Ok(())
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
    // Racine utilisateur canonique capturée par la commande AVANT toute
    // transaction/setup. Empêche un clic lancé sur A de démarrer sur B.
    expected_workspace_root: Option<PathBuf>,
    system_prompt_override: Option<String>,
    execution_profile: ExecutionProfile,
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
    // Claude-compatible selectors from a custom agent definition. When set,
    // this is enforced in both the request manifest and the dispatcher.
    definition_tools: Option<Vec<String>>,
) {
    let start = std::time::Instant::now();
    let protocol = protocol.unwrap_or_else(|| "openai".to_string());
    let base_url = base_url.unwrap_or_default();

    // A custom/builtin role supplies only identity and task-specific guidance.
    // The effective profile, exact tools and project rules are composed later,
    // after the final manifest exists, by the versioned prompt module.
    let mut system_prompt =
        system_prompt_override.unwrap_or_else(|| super::prompts::seed_prompt(&role));
    let read_only = execution_profile.is_read_only();
    let internal_workspace_override = workspace_override.is_some();
    let trust_root = if internal_workspace_override {
        None
    } else {
        expected_workspace_root
    };
    let allow_project_config = internal_workspace_override
        || trust_root
            .as_deref()
            .is_some_and(|root| crate::commands::project_trust::is_trusted(&app, root));
    if let Err(error) = enforce_run_workspace_binding(
        &app,
        &agent_id,
        trust_root.as_deref(),
        !read_only || allow_project_config,
    ) {
        finish_error(&app, &state, &agent_id, &error);
        return;
    }
    // Phase A (Design Studio) — when the Studio passes a design-system context,
    // append GENERATION MODE so the agent writes a complete styled project to
    // `.shugu-forge/preview/` (served live by the preview:// protocol). Chat
    // delegation never sets `design_context`, so the normal path is unchanged.
    if let Some(ctx) = design_context.as_deref() {
        if !ctx.trim().is_empty() {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(super::prompts::GENERATION_MODE_PROMPT);
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
            if isolate {
                set_isolation_status(&app, &agent_id, "failed");
            }
            finish_error(&app, &state, &agent_id, &e);
            return;
        }
    };

    // Validate the HTTP client before creating a requested worktree. A provider
    // setup failure must not leave an unused isolated checkout behind.
    let client = match chat::streaming_client() {
        Ok(c) => c,
        Err(e) => {
            if isolate {
                set_isolation_status(&app, &agent_id, "failed");
            }
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
    // Isolation is a contract, not a hint: when explicitly requested, any setup
    // failure terminates the run instead of silently mutating the real checkout.
    // `iso_root`/`iso_entry` carry the merge-back context
    // to `finalize_isolation` after the run; they stay `None` when we didn't
    // isolate, so the finalize step is a no-op on every existing path.
    // La confiance porte sur le workspace OUVERT, pas sur un éventuel worktree
    // isolé créé plus bas. Les overrides internes (Atelier/Studio) sont générés
    // par Shugu et n'activent aucune configuration d'un projet utilisateur.
    let mut workspace_override = workspace_override;
    let mut iso_root: Option<PathBuf> = None;
    let mut iso_entry: Option<crate::commands::worktree::WorktreeEntry> = None;
    if isolate && workspace_override.is_none() && !read_only {
        if let Err(error) =
            enforce_run_workspace_binding(&app, &agent_id, trust_root.as_deref(), true)
        {
            finish_error(&app, &state, &agent_id, &error);
            return;
        }
        if let Some(root) = trust_root.clone() {
            if root.join(".git").exists() {
                match crate::commands::worktree::create_inner(&root, None, Some(&role)).await {
                    Ok(entry) => {
                        eprintln!(
                            "[agents] isolation: worktree {} on branch {} (agent={agent_id})",
                            entry.path, entry.branch
                        );
                        set_isolation_status(&app, &agent_id, "active");
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
                        set_isolation_status(&app, &agent_id, "failed");
                        finish_error(
                            &app,
                            &state,
                            &agent_id,
                            &format!("isolation demandée mais indisponible : {e}"),
                        );
                        return;
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
                set_isolation_status(&app, &agent_id, "failed");
                finish_error(
                    &app,
                    &state,
                    &agent_id,
                    "isolation demandée mais le workspace n'est pas un dépôt git",
                );
                return;
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
            set_isolation_status(&app, &agent_id, "failed");
            finish_error(
                &app,
                &state,
                &agent_id,
                "isolation demandée mais aucun workspace n'est ouvert",
            );
            return;
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
        if let Err(error) =
            enforce_run_workspace_binding(&app, &agent_id, trust_root.as_deref(), true)
        {
            finish_error(&app, &state, &agent_id, &error);
            return;
        }
        if let Some(root) = trust_root.clone() {
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

    // Whole loop racing the abort token. Inside, the multi-turn loop
    // body (`tool_use_loop`) calls the LLM, executes tools, appends to
    // history, repeats. The abort branch wins if the user kills the
    // agent mid-flight.
    let memory_workspace_root = workspace_override.clone().or_else(|| trust_root.clone());
    let memory_workspace_id = memory_workspace_root
        .as_deref()
        .map(crate::commands::vector::workspace_id);
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
            workspace_override.clone(),
            trust_root.clone(),
            allow_project_config,
            execution_profile,
            advisor.as_ref(),
            conversation_id.as_deref(),
            0, // depth racine — un run top-level n'est jamais lui-même un sous-agent
            definition_tools.as_deref(),
        ) => r,
        _ = abort.notified() => {
            mark_killed(&app, &agent_id);
            // P6.9 — une session shell meurt avec son run (jamais de fuite).
            super::processes::kill_run_sessions(&app, &agent_id);
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
                set_isolation_status(&app, &agent_id, "discarded");
            }
            if let Ok(mut g) = state.lock() {
                g.remove(&agent_id);
            }
            return;
        }
    };

    // P6.9 — les sessions shell du run meurent avec lui (succès, erreur,
    // budget épuisé — tous les chemins qui atteignent ce point).
    super::processes::kill_run_sessions(&app, &agent_id);

    let ms = start.elapsed().as_millis() as u64;

    // Télémétrie par run (succès / blocage / itérations). Écrit pour succès ET
    // échec ; un abort (killed) sort plus tôt et n'est pas scoré.
    record_outcome(&app, &agent_id, &role, loop_result.is_ok(), &loop_metrics);

    match loop_result {
        Ok((output, reasoning, run_usage)) => {
            let transitioned = if let Ok(conn_mutex) = get_conn(&app) {
                if let Ok(conn) = conn_mutex.lock() {
                    conn.execute(
                        "UPDATE agents
                            SET status = 'complete',
                                finished_at = ?1,
                                output = ?2
                          WHERE id = ?3 AND status = 'running'",
                        params![now_ms(), output, agent_id],
                    )
                    .map(|changed| changed == 1)
                    .unwrap_or(false)
                } else {
                    false
                }
            } else {
                false
            };
            if !transitioned {
                // A concurrent Kill already won the terminal-state CAS. Never
                // resurrect it with a Complete event or merge an isolated tree.
                if let (Some(root), Some(entry)) = (iso_root.as_ref(), iso_entry.as_ref()) {
                    let _ = crate::commands::worktree::cleanup_inner(
                        root,
                        Some(&entry.id),
                        true,
                        false,
                    )
                    .await;
                    set_isolation_status(&app, &agent_id, "discarded");
                }
                if let Ok(mut g) = state.lock() {
                    g.remove(&agent_id);
                }
                return;
            }
            // AM-2 — remember() hook: write the salient result of this run into
            // the orchestrated `memory` collection so a future run can recall it.
            // Best-effort; runs BEFORE `output` is moved into the Complete event.
            remember_run(
                &app,
                &role,
                conversation_id.as_deref(),
                memory_workspace_id.as_deref(),
                &remember_task,
                &output,
            );
            let _ = persist_and_emit(
                &app,
                &AgentEvent::Complete {
                    agent_id: agent_id.clone(),
                    output,
                    // P6.2 — agrégat réel du run (entrée cache incluse + sortie) ;
                    // None si le provider n'a jamais rapporté d'usage.
                    tokens_used: run_usage.total(),
                    reasoning: if reasoning.trim().is_empty() {
                        None
                    } else {
                        Some(reasoning)
                    },
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
    use crate::commands::worktree::{cleanup_inner, commit_worktree, current_branch, diff_summary};

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
        let target = current_branch(root)
            .await
            .unwrap_or_else(|| "HEAD".to_string());
        let diff = diff_summary(root, &entry.branch, &target, entry.snapshot_base.as_deref())
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
                diff: if diff.trim().is_empty() {
                    None
                } else {
                    Some(diff)
                },
                reason: Some(reason.to_string()),
            },
        );
        set_isolation_status(app, agent_id, "review");
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
            emit_keep_for_review(
                app,
                root,
                entry,
                agent_id,
                "commit failed — review manually",
            )
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
// ────────────────────────────────────────────────────────────────────
// P6.11 — fan-out parallèle borné des sous-agents délégués
// ────────────────────────────────────────────────────────────────────

/// Réservation globale des unités de travail pendant les fan-outs. Un parent
/// enregistré ne consomme plus de slot pendant qu'il attend ses enfants ; les
/// enfants réservés le remplacent. Le mutex rend le calcul atomique entre
/// plusieurs parents concurrents.
#[derive(Default, Debug)]
struct FanoutCapacity {
    /// parent_id → le parent est-il lui-même un delegate réservé ?
    waiting_parents: std::collections::HashMap<String, bool>,
    reserved_delegates: usize,
}

impl FanoutCapacity {
    fn waiting_roots(&self) -> usize {
        self.waiting_parents
            .values()
            .filter(|is_delegate| !**is_delegate)
            .count()
    }

    fn active_units(&self, root_count: usize) -> usize {
        root_count
            .saturating_sub(self.waiting_roots())
            .saturating_add(self.reserved_delegates)
    }

    fn reserve(
        &mut self,
        parent_id: &str,
        root_count: usize,
        parent_is_delegate: bool,
        requested: usize,
    ) -> Result<usize, String> {
        if self.waiting_parents.contains_key(parent_id) {
            return Err(format!("fan-out déjà actif pour le parent {parent_id}"));
        }
        if parent_is_delegate {
            if self.reserved_delegates == 0 {
                return Err("réservation du sous-agent parent introuvable".to_string());
            }
            // Son slot est temporairement libéré pendant qu'il attend.
            self.reserved_delegates -= 1;
        }
        self.waiting_parents
            .insert(parent_id.to_string(), parent_is_delegate);

        let available = super::MAX_CONCURRENT_AGENTS.saturating_sub(self.active_units(root_count));
        let slots = available.min(requested.max(1));
        if slots == 0 {
            self.waiting_parents.remove(parent_id);
            if parent_is_delegate {
                self.reserved_delegates += 1;
            }
            return Err("capacité globale des agents atteinte".to_string());
        }
        self.reserved_delegates += slots;
        Ok(slots)
    }

    fn release(&mut self, parent_id: &str, slots: usize) {
        self.reserved_delegates = self.reserved_delegates.saturating_sub(slots);
        if self.waiting_parents.remove(parent_id) == Some(true) {
            // Le delegate parent reprend son propre slot après ses enfants.
            self.reserved_delegates += 1;
        }
    }
}

static FANOUT_CAPACITY: std::sync::LazyLock<std::sync::Mutex<FanoutCapacity>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(FanoutCapacity::default()));

/// Nombre d'unités réellement actives, utilisé aussi par les chemins de spawn
/// racine pendant qu'un fan-out a des réservations en vol.
pub(super) fn active_capacity_used(
    registry: &std::collections::HashMap<String, super::AgentHandle>,
) -> usize {
    let root_count = registry
        .values()
        .filter(|handle| handle.role != "delegate")
        .count();
    FANOUT_CAPACITY
        .lock()
        .map(|capacity| capacity.active_units(root_count))
        .unwrap_or(super::MAX_CONCURRENT_AGENTS)
}

struct FanoutLease {
    parent_id: String,
    slots: usize,
}

impl Drop for FanoutLease {
    fn drop(&mut self) {
        if let Ok(mut capacity) = FANOUT_CAPACITY.lock() {
            capacity.release(&self.parent_id, self.slots);
        }
    }
}

fn acquire_fanout_lease(
    app: &AppHandle,
    parent_id: &str,
    requested: usize,
) -> Result<FanoutLease, String> {
    // Ordre de locks unique : registry puis coordinator. Les spawns racine
    // tiennent aussi registry pendant leur lecture du coordinator.
    let manager = app.state::<super::AgentManagerState>();
    let registry = manager
        .0
        .lock()
        .map_err(|e| format!("agent registry lock: {e}"))?;
    let root_count = registry
        .values()
        .filter(|handle| handle.role != "delegate")
        .count();
    let parent_is_delegate = registry
        .get(parent_id)
        .is_some_and(|handle| handle.role == "delegate");
    let mut capacity = FANOUT_CAPACITY
        .lock()
        .map_err(|e| format!("fan-out capacity lock: {e}"))?;
    let slots = capacity.reserve(parent_id, root_count, parent_is_delegate, requested)?;
    Ok(FanoutLease {
        parent_id: parent_id.to_string(),
        slots,
    })
}

/// Exécute `tasks` en parallèle borné, résultats dans L'ORDRE d'entrée.
/// Implémentation par LOTS de `slots` futures (`join_all` par lot, séquentiel
/// entre lots) : les tâches sont I/O-bound (streams SSE), la concurrence sur
/// une seule tâche tokio donne le même wall-time ≈ max(latences du lot) — et
/// n'exige PAS que les futures soient `Send` (le futur de `run_delegated_child`
/// ne l'est pas). `slots <= 0` est ramené à 1 ; au-delà des slots, les tâches
/// attendent le lot suivant (fan-out borné, jamais au-delà du cap).
pub(crate) async fn run_bounded_parallel<F, Fut, T>(slots: usize, tasks: Vec<F>) -> Vec<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let width = slots.max(1);
    let mut out = Vec::with_capacity(tasks.len());
    let mut iter = tasks.into_iter();
    loop {
        let chunk: Vec<F> = iter.by_ref().take(width).collect();
        if chunk.is_empty() {
            break;
        }
        let results = futures_util::future::join_all(chunk.into_iter().map(|f| f())).await;
        out.extend(results);
    }
    out
}

/// Exécute PLUSIEURS sous-agents délégués d'un même tour CONCURRENTLY (P6.11)
/// — plafond [`fanout_slots`], résultats `(content, is_error)` dans l'ordre
/// des appels. Un enfant tué/en échec produit un résultat d'erreur honnête à
/// SA place, jamais un succès fabriqué.
#[allow(clippy::too_many_arguments)]
async fn run_delegated_children_parallel(
    app: &AppHandle,
    client: &reqwest::Client,
    protocol: &str,
    base_url: &str,
    model: &str,
    api_key: &str,
    chat_template_kwargs: &Option<serde_json::Value>,
    parent_id: &str,
    depth: u32,
    tasks: Vec<(String, String)>, // (tool_call_id, child_task)
    execution_profile: ExecutionProfile,
    workspace_root: Option<PathBuf>,
    trust_root: Option<PathBuf>,
    allow_project_config: bool,
) -> Vec<(String, (String, bool))> {
    let lease = match acquire_fanout_lease(app, parent_id, tasks.len()) {
        Ok(lease) => lease,
        Err(error) => {
            return tasks
                .into_iter()
                .map(|(tool_call_id, _)| (tool_call_id, (format!("delegate: {error}"), true)))
                .collect();
        }
    };
    let slots = lease.slots;
    let parent_id = parent_id.to_string();
    let protocol = protocol.to_string();
    let base_url = base_url.to_string();
    let model = model.to_string();
    let api_key = api_key.to_string();
    let kwargs = chat_template_kwargs.clone();
    let closures: Vec<_> = tasks
        .into_iter()
        .map(|(tc_id, task)| {
            let app_c = app.clone();
            let client_c = client.clone();
            let (protocol_c, base_url_c, model_c, api_key_c) = (
                protocol.clone(),
                base_url.clone(),
                model.clone(),
                api_key.clone(),
            );
            let kwargs_c = kwargs.clone();
            let parent_c = parent_id.clone();
            let workspace_root_c = workspace_root.clone();
            let trust_root_c = trust_root.clone();
            move || {
                let tc_id = tc_id.clone();
                async move {
                    let res = run_delegated_child(
                        &app_c,
                        &client_c,
                        &protocol_c,
                        &base_url_c,
                        &model_c,
                        &api_key_c,
                        &kwargs_c,
                        &parent_c,
                        depth,
                        task,
                        execution_profile,
                        workspace_root_c,
                        trust_root_c,
                        allow_project_config,
                    )
                    .await;
                    let outcome = match res {
                        Ok(handoff) => (handoff, false),
                        Err(e) => (format!("delegate: {e}"), true),
                    };
                    (tc_id, outcome)
                }
            }
        })
        .collect();
    let results = run_bounded_parallel(slots, closures).await;
    drop(lease);
    results
}

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
/// Le slot est réservé par le coordinateur de fan-out global ; le parent cède
/// le sien pendant l'attente, y compris pour les délégations imbriquées.
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
    execution_profile: ExecutionProfile,
    workspace_root: Option<PathBuf>,
    trust_root: Option<PathBuf>,
    allow_project_config: bool,
) -> Result<String, String> {
    let start = std::time::Instant::now();
    let child_id = uuid::Uuid::new_v4().to_string();
    let child_abort = std::sync::Arc::new(tokio::sync::Notify::new());

    // Registre : le slot a déjà été réservé atomiquement par
    // `acquire_fanout_lease`. On insère le handle pour la cascade kill
    // (agent_kill) sans refaire un second comptage.
    registry_insert(
        app,
        &child_id,
        super::AgentHandle {
            role: "delegate".to_string(),
            abort: child_abort.clone(),
            cancelled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
                (id, role, status, parent_id, model, task, conversation_id, created_at,
                 execution_profile, isolate, profile_verified, isolation_status)
             VALUES (?1, 'delegate', 'running', ?2, ?3, ?4, NULL, ?5, ?6, 0, 1, 'none')",
            params![
                child_id,
                parent_id,
                model,
                task,
                now_ms(),
                execution_profile.as_str()
            ],
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
            execution_profile,
            isolate: false,
            goal_id: None,
        },
    );

    // Exécution DIRECTE (comme le run parent — décision 2026-07-02) : le
    // sous-agent travaille sur le VRAI workspace, pas sur une photo du dernier
    // commit où les fichiers non commités du user n'existent pas (sous-agent
    // aveugle). Aucune écriture concurrente : le parent ATTEND son enfant
    // (doctrine single-writer). Pour les FAITS du handoff, on capture le statut
    // git AVANT le sous-run ; le delta après coup liste les chemins réellement
    // touchés pendant le run (vérité-terrain non falsifiable par la prose).
    let workspace_override = workspace_root.clone();
    let ws_root = workspace_root;
    let dirty_before: std::collections::HashSet<String> = match ws_root.as_ref() {
        Some(root) if root.join(".git").exists() => crate::commands::worktree::dirty_paths(root)
            .await
            .unwrap_or_default()
            .into_iter()
            .collect(),
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
    let outcome: Result<(String, String, RunUsageTotals), String> = {
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
            trust_root,
            allow_project_config,
            execution_profile,
            None, // advisor : pas de conseiller imbriqué en v1
            None, // conversation_id : contexte vierge
            depth,
            None, // définition : manifeste natif du profil enfant
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
        Ok((output, _reasoning, child_usage)) => {
            let mut transitioned = false;
            if let Ok(conn_mutex) = get_conn(app) {
                if let Ok(conn) = conn_mutex.lock() {
                    transitioned = conn
                        .execute(
                            "UPDATE agents SET status='complete', finished_at=?1, output=?2
                         WHERE id=?3 AND status='running'",
                            params![now_ms(), output, child_id],
                        )
                        .map(|changed| changed == 1)
                        .unwrap_or(false);
                }
            }
            if transitioned {
                let _ = persist_and_emit(
                    app,
                    &AgentEvent::Complete {
                        agent_id: child_id.clone(),
                        output: output.clone(),
                        // P6.2 — agrégat réel du sous-run (None si non rapporté).
                        tokens_used: child_usage.total(),
                        reasoning: None,
                        ms,
                    },
                );
            }
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
            let mut transitioned = false;
            if let Ok(conn_mutex) = get_conn(app) {
                if let Ok(conn) = conn_mutex.lock() {
                    transitioned = conn
                        .execute(
                            "UPDATE agents SET status='error', finished_at=?1, error=?2
                         WHERE id=?3 AND status='running'",
                            params![now_ms(), e, child_id],
                        )
                        .map(|changed| changed == 1)
                        .unwrap_or(false);
                }
            }
            if transitioned {
                let _ = persist_and_emit(
                    app,
                    &AgentEvent::Error {
                        agent_id: child_id.clone(),
                        error: e.clone(),
                    },
                );
            }
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

    registry_remove(app, &child_id);
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

/// Translate Claude-compatible short tool selectors into Shugu's concrete
/// native names. Control-plane tools remain available because they do not grant
/// a new filesystem/network effect; mutating delegation requires an explicit
/// mutating selector. Exact names keep MCP and future tools configurable.
fn definition_allows_tool(selectors: Option<&[String]>, tool: &str) -> bool {
    let Some(selectors) = selectors else {
        return true;
    };
    if matches!(
        tool,
        "todo_write" | "ask_user" | "submit_plan" | "advisor" | "skill_save"
    ) {
        return true;
    }

    selectors.iter().any(|selector| {
        let selector = selector.trim();
        if selector == tool {
            return true;
        }
        match selector.to_ascii_lowercase().as_str() {
            "read" => matches!(
                tool,
                "fs_read_file" | "fs_list_dir" | "fs_search" | "code_search"
            ),
            "write" => matches!(tool, "fs_write_file" | "fs_delete" | "fs_move"),
            "edit" => tool == "fs_edit",
            "bash" | "shell" => tool == "run_command",
            "web" => matches!(tool, "web_search" | "web_fetch"),
            "browser" => matches!(tool, "browser_test" | "capture_screen"),
            "mcp" => tool.starts_with("mcp__"),
            "delegate" => tool == "delegate",
            _ => false,
        }
    }) || (tool == "delegate"
        && selectors.iter().any(|s| {
            matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "write" | "edit" | "bash" | "shell"
            )
        }))
}

fn permission_allows_hooks(decision: Option<&super::permission::ToolPermission>) -> bool {
    matches!(decision, Some(super::permission::ToolPermission::Proceed))
}

/// Multi-turn loop body. Returns the final answer text when the LLM
/// P6.2 — `used` + `source` de la jauge de contexte pour UN tour : l'entrée
/// RÉELLE rapportée par le provider quand elle existe, sinon l'estimation
/// locale de l'historique. Helper pur (la boucle ne fait que l'émettre) pour
/// garder la distinction mesuré/estimé sous test unitaire.
pub(crate) fn context_window_source(
    usage: &chat::TurnUsage,
    history: &[AgentMessage],
) -> (u64, &'static str) {
    match usage.total_input() {
        Some(n) => (n, "provider"),
        None => (estimate_tokens(history) as u64, "estimate"),
    }
}

/// P6.2 — agrégat de consommation tokens d'un run entier. Somme champ par
/// champ, Option-aware : un champ reste `None` si AUCUN tour ne l'a rapporté
/// (jamais de zéros fabriqués — la distinction mesuré/estimé doit survivre).
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct RunUsageTotals {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_creation: Option<u64>,
    pub cache_read: Option<u64>,
}

impl RunUsageTotals {
    fn add(&mut self, u: &chat::TurnUsage) {
        fn acc(total: &mut Option<u64>, v: Option<u64>) {
            if let Some(v) = v {
                *total = Some(total.unwrap_or(0) + v);
            }
        }
        acc(&mut self.input, u.input_tokens);
        acc(&mut self.output, u.output_tokens);
        acc(&mut self.cache_creation, u.cache_creation_input_tokens);
        acc(&mut self.cache_read, u.cache_read_input_tokens);
    }

    /// Total tous canaux confondus pour le `tokens_used` du Complete event :
    /// entrée (cache inclus — Anthropic la rapporte hors `input_tokens`) +
    /// sortie. `None` si le provider n'a rien rapporté du run entier.
    pub(crate) fn total(&self) -> Option<u32> {
        let sum = self.input.unwrap_or(0)
            + self.output.unwrap_or(0)
            + self.cache_creation.unwrap_or(0)
            + self.cache_read.unwrap_or(0);
        if sum > 0 {
            Some(u32::try_from(sum).unwrap_or(u32::MAX))
        } else {
            None
        }
    }
}

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
    // Workspace utilisateur dont la décision de confiance gouverne le run.
    // `None` désigne un workspace interne généré par Shugu.
    trust_root: Option<PathBuf>,
    // Décision figée pour la découverte de configuration de ce run. La
    // révocation des MUTATIONS est, elle, revérifiée à chaque itération.
    allow_project_config: bool,
    execution_profile: ExecutionProfile,
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
    definition_tools: Option<&[String]>,
) -> Result<(String, String, RunUsageTotals), String> {
    let read_only = execution_profile.is_read_only();
    let memory_workspace_root = workspace_override.clone().or_else(|| trust_root.clone());
    let memory_workspace_id = memory_workspace_root
        .as_deref()
        .map(crate::commands::vector::workspace_id);
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
    // P6.2 — agrégat tokens du run (rempli tour par tour depuis turn.usage).
    let mut run_usage = RunUsageTotals::default();

    // Capture the actual request before inserting any learned system blocks.
    // Relevance selection, lessons, memory recall and completion evidence must
    // all be anchored to the same user task.
    let task_text: String = history
        .iter()
        .rev()
        .find_map(|m| match m {
            AgentMessage::Text { role: r, content } if r.as_str() == "user" => {
                Some(content.clone())
            }
            _ => None,
        })
        .unwrap_or_default();

    // Load this role's learned skills (Voyager/Hermes) into context, right after
    // the system prompt — so the agent applies what it has already figured out
    // instead of re-deriving it. No-op when the role has no skills yet. This is
    // the reuse half of skill-learning; `skill_save` is the capture half.
    //
    // P6.8 — skills FICHIERS (SKILL.md) : on découvre d'abord, puis on exclut
    // leurs noms du bloc des skills apprises (dedup file-over-learned — la
    // fichier gagne, l'apprise reste en DB sans être double-injectée). Le
    // listing fichier (name + description SEULEMENT) est injecté ensuite : le
    // corps se charge paresseusement via l'outil `skill_load`.
    let file_skills = super::file_skills::discover_file_skills_with_project_trust(
        app,
        memory_workspace_root.as_deref(),
        allow_project_config,
    );
    let file_skill_names: std::collections::HashSet<String> =
        file_skills.iter().map(|s| s.name.clone()).collect();
    let skills_block =
        super::skills::skills_prompt_block_filtered(app, role, &task_text, &file_skill_names);
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
    let file_skills_block = super::file_skills::listing_block(&file_skills);
    if !file_skills_block.is_empty() {
        let pos = history.len().min(1);
        history.insert(
            pos,
            AgentMessage::Text {
                role: "system".to_string(),
                content: file_skills_block,
            },
        );
    }

    // User-controlled companion memory. Unlike automatic episodic recall,
    // these are explicit validated profile facts from Settings. Keep them in a
    // dedicated bounded system block so the mascot/orchestrator can actually
    // use what the user chose to teach Shugu.
    let profile_memory_block = super::profile_memory::profile_memory_prompt_block(app, role);
    if !profile_memory_block.is_empty() {
        let pos = history.len().min(1);
        history.insert(
            pos,
            AgentMessage::Text {
                role: "system".to_string(),
                content: profile_memory_block,
            },
        );
    }

    // S3 — Closed-loop lesson injection: retrieve validated past-run reviews
    // for tasks semantically similar to this one and prepend them to context.
    // Injected AFTER skills (position 2) so both blocks ride behind the system
    // prompt without displacing each other. Degrades silently on any error.
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
    let (recall_block_text, recall_count) = recall_block(
        app,
        &task_text,
        memory_workspace_id.as_deref(),
        conversation_id,
        role,
    );
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
    // unchanged. `None` is used whenever the capability matrix says the active
    // adapter/model has no Shugu tool loop.
    // Capacité du modèle (source unique : model_capabilities) — calculée UNE
    // fois par run. Pilote la réduction de toolset pour les petits modèles. La
    // fenêtre de contexte de la compaction token-aware est résolue séparément par
    // `resolve_context_window` (qui sonde EN PLUS le n_ctx réel des serveurs
    // locaux). Additif : un modèle fort n'est jamais affecté.
    let caps = crate::commands::model_capabilities::capabilities(protocol, model);

    let agent_tools: Option<serde_json::Value> = if !caps.supports_tools {
        None
    } else {
        let mut arr = if protocol == "anthropic" {
            super::tools::tools_json_anthropic()
        } else {
            super::tools::tools_json_openai()
        };
        let mgr = app.state::<crate::commands::mcp::McpManager>();
        enforce_run_workspace_binding(
            app,
            agent_id,
            trust_root.as_deref(),
            !read_only || allow_project_config,
        )?;
        let mcp_tools = crate::commands::mcp::enabled_tools_json_for_workspace(
            app,
            &mgr,
            protocol,
            memory_workspace_root.as_deref(),
            allow_project_config,
        )
        .await;
        enforce_run_workspace_binding(
            app,
            agent_id,
            trust_root.as_deref(),
            !read_only || allow_project_config,
        )?;
        if let Some(a) = arr.as_array_mut() {
            a.extend(mcp_tools);
        }
        // Same central profile gate as the dispatcher. Unknown MCP effects fail
        // closed in Chat/Plan instead of bypassing the native write list.
        if let Some(a) = arr.as_array_mut() {
            a.retain(|t| {
                let name = t["name"]
                    .as_str()
                    .or_else(|| t["function"]["name"].as_str());
                name.is_some_and(|name| {
                    super::execution_profile_authorized(app, execution_profile)
                        && execution_profile.allows_tool(name)
                })
            });
        }
        // Gate vie privée : `agents.allowScreenCapture = "false"` retire
        // l'outil de capture d'écran du manifest (défaut ON — clé absente ou
        // toute autre valeur laisse l'outil). Le dispatcher revérifie aussi le
        // réglage afin qu'un manifest déjà envoyé ne puisse pas le contourner.
        if crate::commands::mcp::read_setting(app, "agents.allowScreenCapture").as_deref()
            == Some("false")
        {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| {
                    let name = t["name"]
                        .as_str()
                        .or_else(|| t["function"]["name"].as_str());
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
        if caps.recommended_toolset == crate::commands::model_capabilities::Toolset::Reduced {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|t| {
                    let name = t["name"]
                        .as_str()
                        .or_else(|| t["function"]["name"].as_str());
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
                    let name = t["name"]
                        .as_str()
                        .or_else(|| t["function"]["name"].as_str());
                    name != Some("delegate")
                });
            }
        }
        // Agent-definition capabilities are an actual backend allow-list, not
        // UI metadata. Apply them last so the prompt fingerprint describes the
        // exact post-profile/post-model/post-MCP manifest.
        if let Some(a) = arr.as_array_mut() {
            a.retain(|t| {
                let name = t["name"]
                    .as_str()
                    .or_else(|| t["function"]["name"].as_str());
                name.is_some_and(|name| definition_allows_tool(definition_tools, name))
            });
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

    // Compose the effective runtime contract only after the provider manifest
    // has been filtered by profile, privacy, model tier, MCP policy and
    // delegation depth. This prevents prompt/tool drift: the model sees the
    // exact names present in this request, plus bounded rules from the effective
    // workspace (isolated worktree when applicable).
    let context_root = workspace_override.clone().or_else(|| trust_root.clone());
    let project_context = context_root
        .as_deref()
        .map(|root| super::project_context::load_if_trusted(root, &task_text, allow_project_config))
        .unwrap_or_default();
    let runtime_prompt = super::prompts::compose_runtime(
        role,
        execution_profile,
        protocol,
        &caps,
        agent_tools.as_ref(),
        &project_context,
    );
    let _ = persist_and_emit(
        app,
        &AgentEvent::PromptComposed {
            agent_id: agent_id.to_string(),
            version: runtime_prompt.version.to_string(),
            fingerprint: runtime_prompt.fingerprint.clone(),
            execution_profile,
            protocol: protocol.to_string(),
            tool_names: runtime_prompt.tool_names.clone(),
            rule_sources: project_context.rule_sources.clone(),
            package_manager: project_context.package_manager.clone(),
            context_truncated: project_context.truncated,
        },
    );
    let _ = persist_and_emit(
        app,
        &AgentEvent::Message {
            agent_id: agent_id.to_string(),
            role: "system".to_string(),
            content: runtime_prompt.text.clone(),
        },
    );
    let head = history
        .iter()
        .take_while(|m| matches!(m, AgentMessage::Text { role, .. } if role == "system"))
        .count();
    history.insert(
        head,
        AgentMessage::Text {
            role: "system".to_string(),
            content: runtime_prompt.text,
        },
    );

    // Résout la fenêtre de contexte du modèle UNE fois par run (sonde réseau
    // best-effort pour les serveurs locaux ; table pour le cloud ; repli 8k). Le
    // déclencheur de compaction plus bas est gaté sur le budget token dérivé de
    // CETTE fenêtre, plus sur un compteur de tours fixe.
    let context_window = effective_history_window(
        resolve_context_window(client, protocol, base_url, model).await,
        agent_tools.as_ref(),
    );

    // P6.4 — hooks de cycle de vie utilisateur. Chargés UNE fois par run,
    // UNIQUEMENT en profil mutant (Chat/Plan ⇒ zéro processus hook) et avec un
    // workspace ouvert (le hook a besoin d'un cwd + d'un dossier payload).
    enforce_run_workspace_binding(
        app,
        agent_id,
        trust_root.as_deref(),
        !read_only || allow_project_config,
    )?;
    let hook_defs: Vec<super::hooks::HookDef> =
        if super::hooks::hooks_enabled_for_profile(execution_profile) {
            super::hooks::load_hooks_with_project_trust(
                app,
                context_root.as_deref(),
                allow_project_config,
            )
        } else {
            Vec::new()
        };
    if !hook_defs.is_empty() {
        if let Some(ws) = context_root.as_deref() {
            for event in [
                super::hooks::HookEvent::SessionStart,
                super::hooks::HookEvent::UserPromptSubmit,
            ] {
                enforce_run_workspace_binding(
                    app,
                    agent_id,
                    trust_root.as_deref(),
                    !read_only || allow_project_config,
                )?;
                let payload = super::hooks::build_payload(
                    event,
                    agent_id,
                    Some(ws),
                    execution_profile,
                    None,
                    None,
                    None,
                );
                let fire = super::hooks::fire(
                    app,
                    &hook_defs,
                    event,
                    payload,
                    ws,
                    execution_profile,
                    agent_id,
                    None,
                    trust_root.as_deref(),
                )
                .await;
                for ctx in fire.contexts {
                    history.push(AgentMessage::Text {
                        role: "user".to_string(),
                        content: format!("[Shugu hook {}] {ctx}", event.as_str()),
                    });
                }
            }
        }
    }
    // Blocs Stop consécutifs honorés (borne MAX_STOP_BLOCKS — jamais de boucle
    // infinie imposée par un hook). Réinitialisé dès qu'un tour d'outils tourne.
    let mut stop_blocks: u32 = 0;

    // LOT 1 — plan vivant : le dernier `todo_write` parsé en task-graph. Quand il
    // change, on le ré-injecte au tour suivant (step 0a) pour ANCRER la boucle sur
    // le graphe — c'est ce qui rend le plan « exécutable » plutôt qu'advisory : le
    // modèle revoit son plan + la prochaine action même après compaction.
    let mut current_plan: Option<super::plan::TaskGraph> = None;
    let mut plan_dirty = false;
    // Hard completion evidence. Prompts describe the desired cycle, while this
    // state makes it impossible to report a mutated workspace as successfully
    // finished without a recorded plan and a later green verification.
    let mut run_evidence = super::lifecycle::RunEvidence::for_task(!read_only, &task_text);

    while iteration < budget {
        metrics.iterations = iteration + 1;

        // Le run reste lié au workspace canonique capturé au départ. Une
        // révocation, ou un switch vers un autre dossier, coupe la boucle avant
        // le prochain appel provider. Un run read-only qui n'a chargé AUCUNE
        // configuration projet peut continuer sans confiance, mais jamais sur
        // une autre racine.
        enforce_run_workspace_binding(
            app,
            agent_id,
            trust_root.as_deref(),
            !read_only || allow_project_config,
        )?;

        // ── 0b. Follow-ups « steer » (P6.1) — messages de l'utilisateur envoyés
        //        PENDANT le run, drainés ICI, au point sûr entre deux tours
        //        d'outils (là où la boucle reprend la main avant le prochain
        //        appel LLM). Chaque ligne devient un vrai message user dans
        //        l'historique + des events persistés : l'agent corrige sa
        //        trajectoire sans kill, et la trace survit au reload.
        super::followups::drain_steer_into_history(app, agent_id, history);

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
            let completion_instruction = match run_evidence.completion_decision(read_only) {
                super::lifecycle::CompletionDecision::Complete =>
                    "Produce the final answer in plain text, synthesizing the work and the verification evidence.".to_string(),
                super::lifecycle::CompletionDecision::Continue { nudge, .. } => format!(
                    "{nudge}\nThere is no execution budget left after this response. Do not claim success: clearly state that the run is incomplete and name the missing proof."
                ),
            };
            history.push(AgentMessage::Text {
                role: "user".to_string(),
                content: format!(
                    "[Shugu system] This is the FINAL iteration. Do NOT call any more tools. {completion_instruction}"
                ),
            });
        }

        // Compact BEFORE the provider request. This placement covers every
        // control-flow path, including repeated plain-text refusals that add an
        // assistant message + controller nudge and `continue` without ever
        // executing a tool. The old post-tool-only placement could therefore
        // miss the trigger and let the very next request exceed n_ctx.
        let _ = maybe_compact(
            app,
            history,
            agent_id,
            role,
            conversation_id,
            memory_workspace_id.as_deref(),
            context_window,
            execution_profile,
            context_root.as_deref(),
            trust_root.as_deref(),
            allow_project_config,
            |excerpt| {
                summarise_turns(
                    client,
                    protocol,
                    base_url,
                    model,
                    api_key,
                    chat_template_kwargs,
                    excerpt,
                )
            },
        )
        .await;
        enforce_run_workspace_binding(
            app,
            agent_id,
            trust_root.as_deref(),
            !read_only || allow_project_config,
        )?;

        // ── 1. Call the LLM with the current history + tools manifest ──
        let forced_tool = if iteration > 0 {
            run_evidence.required_recovery_tool().filter(|wanted| {
                agent_tools
                    .as_ref()
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|tools| {
                        tools.iter().any(|tool| {
                            tool["name"]
                                .as_str()
                                .or_else(|| tool["function"]["name"].as_str())
                                == Some(*wanted)
                        })
                    })
            })
        } else {
            None
        };
        let (turn, reasoning) = call_agent_llm_with_tools(
            app,
            client,
            protocol,
            base_url,
            model,
            history,
            api_key,
            chat_template_kwargs,
            agent_id,
            &agent_tools,
            forced_tool,
        )
        .await?;

        // La décision peut changer PENDANT l'appel provider. Revérifier ici
        // garantit qu'aucun PreToolUse ni outil du tour reçu ne part ensuite.
        enforce_run_workspace_binding(
            app,
            agent_id,
            trust_root.as_deref(),
            !read_only || allow_project_config,
        )?;

        // ── 2. Persist Message event for this assistant turn ───────────
        let _ = persist_and_emit(
            app,
            &AgentEvent::Message {
                agent_id: agent_id.to_string(),
                role: "assistant".to_string(),
                content: turn.content.clone(),
            },
        );

        // ── 2b. P6.2 — usage tokens du tour + jauge de fenêtre de contexte ──
        // TokenUsage : UNIQUEMENT si le provider a rapporté quelque chose
        // (sinon l'event prétendrait une mesure qui n'existe pas).
        // ContextWindowUsage : à chaque tour ; `source` dit honnêtement si le
        // `used` vient du provider (entrée réelle du tour) ou de l'estimateur.
        run_usage.add(&turn.usage);
        if turn.usage.any() {
            let _ = persist_and_emit(
                app,
                &AgentEvent::TokenUsage {
                    agent_id: agent_id.to_string(),
                    input_tokens: turn.usage.input_tokens,
                    output_tokens: turn.usage.output_tokens,
                    cache_creation_input_tokens: turn.usage.cache_creation_input_tokens,
                    cache_read_input_tokens: turn.usage.cache_read_input_tokens,
                },
            );
        }
        let (ctx_used, ctx_source) = context_window_source(&turn.usage, history);
        let _ = persist_and_emit(
            app,
            &AgentEvent::ContextWindowUsage {
                agent_id: agent_id.to_string(),
                used: ctx_used,
                window: context_window as u64,
                source: ctx_source.to_string(),
            },
        );

        // ── 3. No tool_calls = tentative de réponse finale ─────────────
        //    Elle n'est acceptée que si le contrat runtime confirme qu'une
        //    éventuelle mutation possède un plan et une vérification verte.
        if turn.tool_calls.is_empty() {
            match run_evidence.completion_decision(read_only) {
                super::lifecycle::CompletionDecision::Complete => {
                    // P6.4 — Stop hooks : peuvent BLOQUER la fin du run (le run
                    // continue avec la raison du hook comme contexte), borné à
                    // MAX_STOP_BLOCKS blocs consécutifs — ensuite la fin est
                    // laissée passer et le dépassement est tracé. Pas de bloc
                    // honoré sur la dernière itération (budget épuisé de toute
                    // façon : le hook ne peut pas réclamer l'infini).
                    if !hook_defs.is_empty() && !last_iteration {
                        if let Some(ws) = context_root.as_deref() {
                            let payload = super::hooks::build_payload(
                                super::hooks::HookEvent::Stop,
                                agent_id,
                                Some(ws),
                                execution_profile,
                                None,
                                None,
                                None,
                            );
                            let fire = super::hooks::fire(
                                app,
                                &hook_defs,
                                super::hooks::HookEvent::Stop,
                                payload,
                                ws,
                                execution_profile,
                                agent_id,
                                None,
                                trust_root.as_deref(),
                            )
                            .await;
                            if let Some(reason) = fire.blocked_reason {
                                if super::hooks::should_honor_stop_block(stop_blocks) {
                                    stop_blocks += 1;
                                    history.push(AgentMessage::Text {
                                        role: "assistant".to_string(),
                                        content: turn.content,
                                    });
                                    history.push(AgentMessage::Text {
                                        role: "user".to_string(),
                                        content: format!(
                                            "[Shugu hook Stop] Un hook refuse la fin du run : {reason}. Continue le travail ou explique ce qu'il manque."
                                        ),
                                    });
                                    iteration += 1;
                                    continue;
                                }
                                super::hooks::emit_stop_block_ignored(
                                    app,
                                    agent_id,
                                    &format!(
                                        "borne de {} blocs Stop consécutifs atteinte — fin autorisée malgré : {reason}",
                                        super::hooks::MAX_STOP_BLOCKS
                                    ),
                                );
                            }
                        }
                    }
                    return Ok((turn.content, reasoning, run_usage));
                }
                super::lifecycle::CompletionDecision::Continue { reason, nudge } => {
                    if last_iteration {
                        metrics.stuck_reason =
                            Some(format!("completion_contract_{}", reason.code()));
                        let last_response = turn.content.trim();
                        let suffix = if last_response.is_empty() {
                            String::new()
                        } else {
                            format!(" Dernière réponse du modèle : {last_response}")
                        };
                        return Err(format!(
                            "Le run a été arrêté sans faux succès : le contrat de fin n'est pas satisfait ({}).{}",
                            reason.code(), suffix
                        ));
                    }

                    // Preserve the attempted final answer, then give the model a
                    // concrete repair instruction and let the normal tool loop
                    // continue. This is the enforced agentic cycle: a plain-text
                    // claim cannot bypass missing execution evidence.
                    history.push(AgentMessage::Text {
                        role: "assistant".to_string(),
                        content: turn.content,
                    });
                    history.push(AgentMessage::Text {
                        role: "user".to_string(),
                        content: nudge,
                    });
                    iteration += 1;
                    continue;
                }
            }
        }
        if last_iteration {
            // Never turn unexecuted final-round tool calls into a successful
            // completion. The old force-accept path was the second false-success
            // escape hatch after the no-tool shortcut above.
            metrics.stuck_reason = Some("max_iterations".to_string());
            let requested = turn
                .tool_calls
                .iter()
                .map(|call| call.name.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "L'orchestrateur a épuisé son budget ({MAX_ITERATIONS} itérations) et demandait encore des outils non exécutés ({requested}). Le run reste incomplet."
            ));
        }

        // Un tour d'outils interrompt toute série de blocs Stop.
        stop_blocks = 0;

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

        // ── 4.4. P6.10 — moteur de permissions allow/ask/deny, chargé une
        //        fois par itération. Les règles s'appliquent aussi aux outils
        //        de lecture (web_fetch, LSP, MCP read) en Chat/Plan.
        let (permission_rules, permission_rules_error) =
            match super::command_rules::load_permission_rules(app) {
                Ok(rules) => (rules, None),
                Err(e) => {
                    eprintln!("[agents] permission rules load failed (fail-closed): {e}");
                    (Vec::new(), Some(e))
                }
            };
        let permission_scope: String = context_root
            .as_deref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let enforce_plan_first = !read_only && !run_evidence.has_recorded_plan();

        // Préflight AVANT hooks : une règle deny/ask ne doit jamais déclencher
        // un script utilisateur/projet. La décision est calculée UNE fois puis
        // réutilisée au dispatch. Le verdict « une fois » est donc réservé
        // atomiquement avant les hooks : deux appels identiques concurrents ne
        // peuvent ni l'exécuter deux fois ni lancer un hook pour le second.
        let mut permission_preflight: std::collections::HashMap<
            String,
            super::permission::ToolPermission,
        > = std::collections::HashMap::new();
        for tc in &turn.tool_calls {
            if !definition_allows_tool(definition_tools, &tc.name)
                || !super::execution_profile_authorized(app, execution_profile)
                || !execution_profile.allows_tool(&tc.name)
                || super::lifecycle::reject_unplanned_tool(tc, enforce_plan_first).is_some()
            {
                continue;
            }
            let args_value: serde_json::Value =
                serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
            let decision = if let Some(error) = permission_rules_error.as_deref() {
                super::permission::ToolPermission::Blocked(format!(
                    "moteur de permissions indisponible : {error}"
                ))
            } else {
                super::permission::evaluate_tool_call(
                    app,
                    agent_id,
                    &tc.name,
                    &args_value,
                    &permission_rules,
                    &permission_scope,
                    true,
                )
                .unwrap_or_else(|e| {
                    eprintln!("[agents] permission preflight failed (fail-closed): {e}");
                    super::permission::ToolPermission::Blocked(format!(
                        "évaluation de permission impossible : {e}"
                    ))
                })
            };
            permission_preflight.insert(tc.id.clone(), decision);
        }

        // ── 4.5. P6.4 — PreToolUse hooks (fail-CLOSED), uniquement après les
        //        gates de définition/profil/plan et le préflight permission.
        let mut pre_tool_blocked: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        if !hook_defs.is_empty() {
            if let Some(ws) = workspace_override
                .as_ref()
                .cloned()
                .or_else(|| trust_root.clone())
                .as_deref()
            {
                let ws = ws.to_path_buf();
                for tc in &turn.tool_calls {
                    if !permission_allows_hooks(permission_preflight.get(&tc.id)) {
                        continue;
                    }
                    let args_value: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let payload = super::hooks::build_payload(
                        super::hooks::HookEvent::PreToolUse,
                        agent_id,
                        Some(&ws),
                        execution_profile,
                        Some(&tc.name),
                        Some(&args_value),
                        None,
                    );
                    let fire = super::hooks::fire(
                        app,
                        &hook_defs,
                        super::hooks::HookEvent::PreToolUse,
                        payload,
                        &ws,
                        execution_profile,
                        agent_id,
                        Some(&tc.name),
                        trust_root.as_deref(),
                    )
                    .await;
                    if let Some(reason) = fire.blocked_reason {
                        pre_tool_blocked.insert(tc.id.clone(), reason);
                    }
                }
            }
        }

        // ── 5. Resolve workspace + execute tools ───────────────────────
        let workspace_root = workspace_override
            .as_ref()
            .cloned()
            .or_else(|| trust_root.clone());
        // A prompt can request plan-first behaviour, but only the dispatcher
        // can guarantee it. Until `todo_write` has succeeded in an earlier
        // round, every mutation-capable tool is refused before touching disk or
        // spawning a process. Calls from the same assistant turn are treated as
        // concurrent, so `todo_write` beside an edit cannot authorize it.
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
        let any_async = turn.tool_calls.iter().any(|tc| {
            tc.name.starts_with("mcp__")
                    || tc.name == "web_search"
                    || tc.name == "web_fetch"
                    || tc.name == "advisor"
                    || tc.name == "browser_test"
                    || tc.name == "delegate"
                    // P6.12 — outils LSP : requêtes async vers le serveur de
                    // langage (bridge commands::lsp), comme web_search/advisor.
                    || tc.name == "lsp_diagnostics"
                    || tc.name == "lsp_definition"
                    || tc.name == "lsp_references"
                    // HITL : ask_user / submit_plan n'écrivent qu'un event + sentinel
                    // et n'ont PAS besoin d'un workspace → routés sur le chemin
                    // séquentiel (traité AVANT le gate workspace), sinon un tour ne
                    // contenant qu'eux tomberait en « no workspace open » et casserait
                    // le mode Plan interactif sans dossier ouvert.
                    || tc.name == "ask_user"
                    || tc.name == "submit_plan"
        });

        // P6.11 — fan-out parallèle borné : quand le modèle émet PLUSIEURS
        // appels `delegate` dans le même tour, ils sont exécutés CONCURRENTLY
        // (sémaphore de slots, cap global partagé) au lieu d'un à la fois.
        // Les résultats sont pré-calculés ICI et consommés dans l'ordre par le
        // dispatch ci-dessous — l'ordre des appels est toujours préservé.
        let mut fanout_results: std::collections::HashMap<String, (String, bool)> =
            std::collections::HashMap::new();
        if any_async && depth < MAX_DELEGATION_DEPTH {
            let mut prepared: Vec<(String, String)> = Vec::new();
            for tc in turn.tool_calls.iter().filter(|tc| tc.name == "delegate") {
                // Ne pré-exécuter que les appels qui ont franchi EXACTEMENT
                // les mêmes gates que le dispatch. Sinon un fan-out pouvait
                // partir avant qu'une règle ask/deny ou un hook le bloque.
                if !definition_allows_tool(definition_tools, &tc.name)
                    || !super::execution_profile_authorized(app, execution_profile)
                    || !execution_profile.allows_tool(&tc.name)
                    || super::lifecycle::reject_unplanned_tool(tc, enforce_plan_first).is_some()
                    || !permission_allows_hooks(permission_preflight.get(&tc.id))
                    || pre_tool_blocked.contains_key(&tc.id)
                {
                    continue;
                }
                let args: serde_json::Value =
                    serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                let task = args["task"].as_str().unwrap_or("").trim().to_string();
                if task.is_empty() {
                    fanout_results.insert(
                        tc.id.clone(),
                        ("delegate: missing required field: task".to_string(), true),
                    );
                    continue;
                }
                let mut child_task = task;
                let focus = args["focus_hint"].as_str().unwrap_or("").trim();
                let expected = args["expected_artifacts"].as_str().unwrap_or("").trim();
                if !focus.is_empty() {
                    child_task.push_str(&format!(
                        "

Point de départ : {focus}"
                    ));
                }
                if !expected.is_empty() {
                    child_task.push_str(&format!(
                        "

Livrable attendu : {expected}"
                    ));
                }
                prepared.push((tc.id.clone(), child_task));
            }
            if prepared.len() >= 2 {
                let outcomes = run_delegated_children_parallel(
                    app,
                    client,
                    protocol,
                    base_url,
                    model,
                    api_key,
                    chat_template_kwargs,
                    agent_id,
                    depth + 1,
                    prepared,
                    execution_profile,
                    workspace_root.clone(),
                    trust_root.clone(),
                    allow_project_config,
                )
                .await;
                for (tc_id, outcome) in outcomes {
                    fanout_results.insert(tc_id, outcome);
                }
            }
        }

        let results: Vec<ToolResult> = if any_async {
            let mgr = app.state::<crate::commands::mcp::McpManager>();
            let mut acc: Vec<ToolResult> = Vec::with_capacity(turn.tool_calls.len());
            for tc in &turn.tool_calls {
                if let Err(content) = enforce_run_workspace_binding(
                    app,
                    agent_id,
                    trust_root.as_deref(),
                    !read_only || allow_project_config,
                ) {
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content,
                    });
                    continue;
                }
                if !definition_allows_tool(definition_tools, &tc.name) {
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content: format!(
                            "outil `{}` refusé par la définition de cet agent",
                            tc.name
                        ),
                    });
                    continue;
                }
                if !super::execution_profile_authorized(app, execution_profile) {
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content: "Full Access a été révoqué. Repasse en Auto ou réactive-le via la confirmation native."
                            .to_string(),
                    });
                    continue;
                }
                if !execution_profile.allows_tool(&tc.name) {
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content: format!(
                            "outil `{}` refusé par le profil {}",
                            tc.name,
                            execution_profile.as_str()
                        ),
                    });
                    continue;
                }
                if let Some(blocked) =
                    super::lifecycle::reject_unplanned_tool(tc, enforce_plan_first)
                {
                    acc.push(blocked);
                    continue;
                }
                // P6.10 — décision du préflight déjà évaluée AVANT hooks.
                // On la réutilise sans seconde lecture/consommation : un verdict
                // « une fois » ne peut pas être pris deux fois sous concurrence.
                let args_value: serde_json::Value =
                    serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                match permission_preflight
                    .get(&tc.id)
                    .cloned()
                    .unwrap_or_else(|| {
                        super::permission::ToolPermission::Blocked(
                            "préflight de permission absent".to_string(),
                        )
                    }) {
                    super::permission::ToolPermission::Blocked(reason) => {
                        acc.push(ToolResult {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            is_error: true,
                            content: format!(
                                "outil `{}` refusé par une règle de permission : {reason}",
                                tc.name
                            ),
                        });
                        continue;
                    }
                    super::permission::ToolPermission::Ask { pattern } => {
                        acc.push(super::permission::pause_for_permission_ask(
                            app,
                            agent_id,
                            tc,
                            &args_value,
                            &pattern,
                        ));
                        continue;
                    }
                    super::permission::ToolPermission::Proceed => {}
                }
                // P6.4 — refus PreToolUse (fail-closed) : le modèle voit la
                // raison du hook comme résultat d'outil, rien n'est exécuté.
                if let Some(reason) = pre_tool_blocked.get(&tc.id) {
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: true,
                        content: format!(
                            "outil `{}` refusé par un hook PreToolUse : {reason}",
                            tc.name
                        ),
                    });
                    continue;
                }
                if tc.name == "web_search" {
                    // Recherche web async via le client reqwest (Brave/Tavily si
                    // clé, sinon DuckDuckGo durci). Read-only → dispo en Plan.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let query = args["query"].as_str().unwrap_or("").trim();
                    let max = args["max_results"].as_u64().unwrap_or(5).clamp(1, 10) as usize;
                    let (content, is_error) = if query.is_empty() {
                        (
                            "web_search: missing required field: query".to_string(),
                            true,
                        )
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
                    let max_chars = args["max_chars"]
                        .as_u64()
                        .unwrap_or(48_000)
                        .clamp(500, 200_000) as usize;
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
                            Some(a) => (
                                a.protocol.as_str(),
                                a.base_url.as_str(),
                                a.model.as_str(),
                                a.api_key.as_str(),
                            ),
                            None => (protocol, base_url, model, api_key),
                        };
                        consult_advisor(
                            client,
                            a_proto,
                            a_base,
                            a_model,
                            a_key,
                            chat_template_kwargs,
                            history,
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
                    // Outil navigateur interactif : réservé aux profils Agent.
                    // Le verdict structuré est préfixé avant le bloc de contenu
                    // non fiable afin que le lifecycle ne parse jamais la prose.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let root_opt = workspace_root.as_ref().map(|p| p.as_path());
                    let outcome =
                        crate::commands::browser::browser_test_run(app, root_opt, agent_id, &args)
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
                    let verification = match outcome.passed {
                        Some(true) => "[SHUGU_VERIFY: passed]\n",
                        Some(false) => "[SHUGU_VERIFY: failed]\n",
                        None => "",
                    };
                    let content = if outcome.is_error {
                        outcome.summary
                    } else {
                        format!(
                            "{verification}{}",
                            super::tools::wrap_untrusted("browser", &outcome.summary)
                        )
                    };
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error: outcome.is_error,
                        content,
                    });
                } else if tc.name == "delegate" {
                    // P6.11 — résultat du fan-out parallèle déjà calculé pour
                    // cet appel ? (les tours multi-delegate sont exécutés
                    // concurrently plus haut ; ce bras reste le chemin
                    // séquentiel historique pour un delegate unique.)
                    if let Some((content, is_error)) = fanout_results.get(&tc.id) {
                        acc.push(ToolResult {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            is_error: *is_error,
                            content: content.clone(),
                        });
                        continue;
                    }
                    // Offload vers un SOUS-AGENT à contexte isolé. Le parent attend
                    // (await) et reçoit un handoff machine-vérifiable (diff réel +
                    // itérations), pas une simple prose. Box::pin casse la récursion
                    // async tool_use_loop → enfant → tool_use_loop.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let task = args["task"].as_str().unwrap_or("").trim().to_string();
                    let focus = args["focus_hint"].as_str().unwrap_or("").trim();
                    let expected = args["expected_artifacts"].as_str().unwrap_or("").trim();
                    let (content, is_error) = if task.is_empty() {
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
                        match acquire_fanout_lease(app, agent_id, 1) {
                            Err(e) => (format!("delegate: {e}"), true),
                            Ok(lease) => {
                                let result = Box::pin(run_delegated_child(
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
                                    execution_profile,
                                    workspace_root.clone(),
                                    trust_root.clone(),
                                    allow_project_config,
                                ))
                                .await;
                                drop(lease);
                                match result {
                                    Ok(handoff) => (handoff, false),
                                    Err(e) => (format!("delegate: {e}"), true),
                                }
                            }
                        }
                    };
                    acc.push(ToolResult {
                        id: tc.id.clone(),
                        name: tc.name.clone(),
                        is_error,
                        content,
                    });
                } else if tc.name == "lsp_diagnostics"
                    || tc.name == "lsp_definition"
                    || tc.name == "lsp_references"
                {
                    // P6.12 — outils LSP (effet lecture). Confinement identique
                    // à fs_read_file ; serveur absent/crash/timeout = erreur
                    // honnête, la boucle continue.
                    let args: serde_json::Value =
                        serde_json::from_str(&tc.arguments).unwrap_or(serde_json::json!({}));
                    let path = args["path"].as_str().unwrap_or("").to_string();
                    let Some(root) = workspace_root.as_ref() else {
                        acc.push(ToolResult {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            is_error: true,
                            content: "no workspace open".to_string(),
                        });
                        continue;
                    };
                    let outcome: Result<String, String> = match tc.name.as_str() {
                        "lsp_diagnostics" => {
                            super::lsp_tools::lsp_diagnostics_tool(app, root, &path).await
                        }
                        "lsp_definition" => {
                            super::lsp_tools::lsp_definition_tool(
                                app,
                                root,
                                &path,
                                args["line"].as_u64().unwrap_or(0),
                                args["character"].as_u64().unwrap_or(0),
                            )
                            .await
                        }
                        _ => {
                            super::lsp_tools::lsp_references_tool(
                                app,
                                root,
                                &path,
                                args["line"].as_u64().unwrap_or(0),
                                args["character"].as_u64().unwrap_or(0),
                            )
                            .await
                        }
                    };
                    let (content, is_error) = match outcome {
                        Ok(text) => (text, false),
                        Err(e) => (e, true),
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
                    let (content, is_error) = crate::commands::mcp::mcp_execute_for_workspace(
                        app,
                        &mgr,
                        &tc.name,
                        &args,
                        workspace_root.as_deref(),
                        allow_project_config,
                    )
                    .await;
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
                    let profile = execution_profile;
                    let r = tokio::task::spawn_blocking(move || {
                        execute_tool(
                            &tc_clone,
                            &root_clone,
                            &app_clone,
                            &role_clone,
                            &last_exec_clone,
                            &agent_id_clone,
                            profile,
                            allow_project_config,
                        )
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
                let profile_blocked = !execution_profile.allows_tool(&tc_clone.name);
                let definition_blocked = !definition_allows_tool(definition_tools, &tc_clone.name);
                let plan_blocked =
                    super::lifecycle::reject_unplanned_tool(&tc_clone, enforce_plan_first);
                let hook_block_reason = pre_tool_blocked.get(&tc_clone.id).cloned();
                let permission_decision = permission_preflight
                    .get(&tc_clone.id)
                    .cloned()
                    .unwrap_or_else(|| {
                        super::permission::ToolPermission::Blocked(
                            "préflight de permission absent".to_string(),
                        )
                    });
                let root_clone = root_arc.clone();
                let app_clone = app.clone();
                let role_clone = role.to_string();
                let last_exec_clone = last_exec_exit.clone();
                let agent_id_clone = agent_id.to_string();
                let profile = execution_profile;
                let trust_root_clone = trust_root.clone();
                let requires_project_trust = !read_only || allow_project_config;
                async move {
                    if let Err(content) = enforce_run_workspace_binding(
                        &app_clone,
                        &agent_id_clone,
                        trust_root_clone.as_deref(),
                        requires_project_trust,
                    ) {
                        return ToolResult {
                            id: fallback_id,
                            name: fallback_name,
                            is_error: true,
                            content,
                        };
                    }
                    if profile_blocked || definition_blocked {
                        return ToolResult {
                            id: fallback_id,
                            name: fallback_name.clone(),
                            is_error: true,
                            content: if definition_blocked {
                                format!(
                                    "outil `{}` refusé par la définition de cet agent",
                                    fallback_name
                                )
                            } else {
                                format!(
                                    "outil `{}` refusé par le profil {}",
                                    fallback_name,
                                    profile.as_str()
                                )
                            },
                        };
                    }
                    if let Some(blocked) = plan_blocked {
                        return blocked;
                    }
                    // P6.10 — réutilise la décision atomique du préflight
                    // exécuté avant hooks (aucune double consommation).
                    let args_value: serde_json::Value =
                        serde_json::from_str(&tc_clone.arguments)
                            .unwrap_or(serde_json::json!({}));
                    match permission_decision {
                        super::permission::ToolPermission::Blocked(reason) => {
                            return ToolResult {
                                id: fallback_id,
                                name: fallback_name.clone(),
                                is_error: true,
                                content: format!(
                                    "outil `{fallback_name}` refusé par une règle de permission : {reason}"
                                ),
                            };
                        }
                        super::permission::ToolPermission::Ask { pattern } => {
                            return super::permission::pause_for_permission_ask(
                                &app_clone,
                                &agent_id_clone,
                                &tc_clone,
                                &args_value,
                                &pattern,
                            );
                        }
                        super::permission::ToolPermission::Proceed => {}
                    }
                    if let Some(reason) = hook_block_reason {
                        return ToolResult {
                            id: fallback_id,
                            name: fallback_name.clone(),
                            is_error: true,
                            content: format!(
                                "outil `{fallback_name}` refusé par un hook PreToolUse : {reason}"
                            ),
                        };
                    }
                    // `spawn_blocking` because the fs ops are synchronous —
                    // running them on the async runtime thread would starve
                    // other tokio tasks. `unwrap_or_else` defends against
                    // a JoinError (panic in the closure); `execute_tool`
                    // itself never panics for normal fs failures.
                    tokio::task::spawn_blocking(move || {
                        execute_tool(
                            &tc_clone,
                            &root_clone,
                            &app_clone,
                            &role_clone,
                            &last_exec_clone,
                            &agent_id_clone,
                            profile,
                            allow_project_config,
                        )
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
            set_isolation_status(app, agent_id, "finalized");
        }

        // Update the completion contract only from real dispatcher results.
        // Failed writes do not create a verification debt; a non-zero command
        // is feedback, not a green check (parsed by lifecycle.rs).
        run_evidence.observe_round(&turn.tool_calls, &results);

        // Infrastructure/authority blockers are not model-repairable. Tool
        // events are already persisted above, so stopping here keeps the audit
        // trail complete while preventing an expensive retry loop.
        if let Some(message) = hard_execution_blocker(&results) {
            metrics.tool_errors += results.iter().filter(|r| r.is_error).count() as u32;
            metrics.stuck_reason = Some("sandbox_unavailable".to_string());
            return Err(message);
        }

        // ── 6.5. P6.4 — PostToolUse hooks (fail-OPEN) : chaque résultat d'outil
        //        est notifié aux hooks matchés (nom + résumé borné) ; leur
        //        `additionalContext` est injecté comme contexte du tour suivant.
        if !hook_defs.is_empty() {
            // `workspace_root` (step 5) a été consommé par le dispatch ; on
            // réutilise `context_root`, vivant pour toute la boucle.
            if let Some(ws) = context_root.as_deref() {
                let ws = ws.to_path_buf();
                for (tc, r) in turn.tool_calls.iter().zip(results.iter()) {
                    let summary: String = r.content.chars().take(500).collect();
                    let payload = super::hooks::build_payload(
                        super::hooks::HookEvent::PostToolUse,
                        agent_id,
                        Some(&ws),
                        execution_profile,
                        Some(&tc.name),
                        None,
                        Some(&summary),
                    );
                    let fire = super::hooks::fire(
                        app,
                        &hook_defs,
                        super::hooks::HookEvent::PostToolUse,
                        payload,
                        &ws,
                        execution_profile,
                        agent_id,
                        Some(&tc.name),
                        trust_root.as_deref(),
                    )
                    .await;
                    for ctx in fire.contexts {
                        history.push(AgentMessage::Text {
                            role: "user".to_string(),
                            content: format!("[Shugu hook PostToolUse] {ctx}"),
                        });
                    }
                }
            }
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
            return Ok((String::new(), reasoning, run_usage));
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
            .filter_map(|r| {
                r.content
                    .strip_prefix("SCREENSHOT_SAVED:")
                    .map(str::to_string)
            })
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
    // Recovery constraint: when an executing model ignored a mutation task and
    // returned prose, the next OpenAI-compatible turn is required to emit the
    // plan tool instead of repeating another raw answer.
    forced_tool: Option<&str>,
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
                client,
                base_url,
                model,
                messages,
                system,
                api_key,
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
                /* forced tool */ forced_tool,
                /* abort */ None,
                &mut on_chunk,
            )
            .await
        }
        "ollama" => {
            let messages = build_ollama_messages(history);
            chat::call_ollama_structured(
                client,
                base_url,
                model,
                messages,
                tools.clone(),
                None,
                &mut on_chunk,
            )
            .await
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
            "advisor: no conversation turns yet — call advisor after at least one step."
                .to_string(),
            true,
        );
    }

    // Pas de streaming live pour le conseiller : la sortie arrive en un bloc.
    let mut sink = |_kind: &str, _chunk: &str| {};

    let turn = match protocol {
        "anthropic" => {
            let (messages, system) = build_anthropic_native(&advisor_history);
            chat::call_anthropic_structured(
                client, base_url, model, messages, system, api_key, /* with_tools */ false,
                /* tools */ None, /* abort */ None, &mut sink,
            )
            .await
        }
        "openai" | "custom" => {
            let messages = build_openai_messages(&advisor_history);
            chat::call_openai_compat_structured(
                client,
                base_url,
                model,
                messages,
                api_key,
                protocol,
                chat_template_kwargs,
                /* with_tools */ false,
                /* tools */ None,
                /* forced tool */ None,
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
                (
                    "advisor returned empty guidance — proceed with your own judgement."
                        .to_string(),
                    false,
                )
            } else {
                (advice, false)
            }
        }
        Err(e) => (
            format!("advisor call failed: {e} — proceed with your own judgement."),
            true,
        ),
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
                client, base_url, model, messages, system, api_key, /* with_tools */ false,
                /* tools */ None, /* abort */ None, &mut sink,
            )
            .await
        }
        "openai" | "custom" => {
            let messages = build_openai_messages(&summary_history);
            chat::call_openai_compat_structured(
                client,
                base_url,
                model,
                messages,
                api_key,
                protocol,
                chat_template_kwargs,
                /* with_tools */ false,
                /* tools */ None,
                /* forced tool */ None,
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
#[allow(dead_code)] // legacy text retained temporarily for migration archaeology
const GENERATION_MODE_PROMPT: &str = "=== GENERATION MODE (a design system is active) ===\nWhen the task asks you to build, generate, create, or design a page, site, landing page, dashboard, component, or any UI, you MUST produce a COMPLETE, SELF-CONTAINED static web project WRITTEN TO DISK using `fs_write_file` — NOT a chat answer and NOT a single fenced code block.\n\nBefore writing files, call `todo_write` with a short checklist (3-6 steps) of your plan, then update the statuses as you complete each step.\n\nRules:\n1. Write the entry point at `.shugu-forge/preview/index.html`.\n2. Put CSS in `.shugu-forge/preview/styles.css` and JS in `.shugu-forge/preview/script.js`, linked from index.html with RELATIVE paths (href=\"styles.css\", src=\"script.js\").\n3. Apply the design context below (a design system and/or a colour direction): declare its color / typography / spacing tokens as CSS custom properties in `:root { ... }`, and follow the visual direction, component patterns, and anti-patterns.\n4. Produce real, polished, responsive markup with enough sections to demonstrate the design (e.g. hero, content sections, footer). No placeholder-only output.\n5. Always (over)write the files under `.shugu-forge/preview/` so the live preview reflects the latest version; read existing files first when iterating.\n6. After writing, reply with ONE short line: what you built, which design skill(s) you applied, + the entry path `.shugu-forge/preview/index.html`.";

/// Appended to the agent's system prompt in PLAN MODE (the chat's read-only
/// selector). Behaviour mirror of Claude Code's plan mode: the agent explores
/// and proposes, but never mutates. The HARD enforcement is tool filtering +
/// the dispatch guard in `tool_use_loop`; this just keeps the model honest so
/// it doesn't promise edits it cannot perform.
#[allow(dead_code)] // superseded by prompts::compose_runtime
const PLAN_MODE_PROMPT: &str = "\n\n=== PLAN MODE (READ-ONLY) ===\nYou are in PLAN MODE. The write/exec tools (fs_write_file, fs_edit, run_command) are DISABLED for this turn — calling them will fail. Do NOT promise to write files or run commands.\n\nYour job is to UNDERSTAND and PROPOSE, not to act:\n1. Use the read tools (fs_list_dir, fs_read_file, fs_search) to investigate the real code as needed.\n2. If a choice is genuinely ambiguous (which stack, scope, or design direction), call `ask_user` with 1-4 clickable questions BEFORE finalizing — your turn ends and you are resumed with the user's answers.\n3. Use `todo_write` to sketch the steps you would take (it renders as a live checklist).\n4. When your plan is concrete, FINISH by calling `submit_plan(plan, title)` with the full plan in Markdown (which files you'd create/change, what each change does, how you'd verify it). Do NOT end in free text — `submit_plan` presents the plan to the user with « Approuver et exécuter » / « Continuer à planifier » buttons; approving switches you to Agent mode to execute it.";

/// System prompt for a Grounded Run — the env-grounded loop on the user's REAL
/// project (exec directe depuis le pivot 2026-06-10 ; le filet de sécurité est
/// git, visible dans l'onglet Git de l'app).
#[allow(dead_code)] // superseded by prompts::GROUNDED_PROMPT
pub(super) const GROUNDED_PROMPT: &str = r#"You are Shugu's Grounded agent. You work DIRECTLY on the user's real project, with execution enabled on their machine. Git is the safety net: every change you make is visible in the app's Git panel, where the user can review and discard it. Your job: make the requested change AND prove it works by running the project's own checks.

LOOP (DeepSWE-shaped):
1. UNDERSTAND before editing. Use fs_search and fs_read_file to locate the relevant code and read it FULLY. Never edit a file you have not read.
2. EDIT surgically: fs_edit for changes to existing files, fs_write_file for new ones.
3. VERIFY after every change with run_command. If a verification command was provided below, run EXACTLY that. Otherwise read package.json / Cargo.toml to find the project's own check (typecheck, test, build) and run it. For UI changes you can also SEE the result: after launching/refreshing the UI, call capture_screen — the screenshot comes back as an image you can actually look at, and it shows the user visual proof in the chat.
4. READ the failure. A non-zero exit is INFORMATION, not defeat: read stderr, find the root cause, fix it, then run the check AGAIN.
5. Declare done ONLY when the check passes (exit 0). End with a short plain-text summary of what you changed and why.

TOOLCHAIN: you run on the user's real machine — `node`, package managers, `cargo`, `git`, etc. resolve exactly as in their terminal, network included. Read the project's manifest before running dependency or script commands and use its declared package manager. If `package.json` declares pnpm, use only `pnpm` / `pnpm exec` and never npm / npx.

RULES (you are editing the REAL project — be surgical):
- NEVER run destructive commands outside the task scope: no `rm`/`del` sweeps, no `git commit`, `git push`, `git checkout`, `git reset` unless the task EXPLICITLY asks for it.
- Do not install global tools or modify files outside the workspace unless the task explicitly requires it.
- No drive-by refactors: change what the task needs, nothing else.
- Keep going until the check is green or you exhaust your iteration budget. Honest partial progress beats a confident wrong answer.
"#;

#[allow(dead_code)] // superseded by prompts::ATELIER_PROMPT
pub(super) const ATELIER_PROMPT: &str = r#"You are Shugu's Atelier agent. You build a small WEB UI and then PROVE it works by actually driving a real browser — never by claiming it looks correct.

You work in a THROWAWAY creation directory (empty temp dir), never the user's real project. All file paths are workspace-relative POSIX paths (e.g. `index.html`, `app.js`). Your tools: `fs_write_file(path, content)`, `fs_read_file(path)`, `fs_edit(path, old_string, new_string)`, `fs_list_dir(path)`, `run_command(command)`, and `skill_save(name, when_to_use, body)`. Commands run directly on the user's machine (real Node.js/pnpm toolchain, network available), cwd = your creation directory.

THE LOOP — follow it exactly:
1. BUILD the app: write a self-contained static web app to disk — `index.html` plus optional `styles.css` / `app.js` linked with relative paths. Vanilla HTML/CSS/JS only: NO build step, NO frameworks.
2. WRITE a browser test that DRIVES the UI. Create a CommonJS file `test.cjs` that uses Playwright for real interaction:
   - first check Playwright resolves: `run_command("node -e \"require('playwright')\"")`. If it fails, install it locally: `run_command("pnpm init && pnpm add -D playwright && pnpm exec playwright install chromium", timeoutSecs: 300)`.
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
#[allow(dead_code)] // superseded by prompts::seed_prompt
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
        "orchestrator" => "You are Shugu — a helpful, friendly coding companion that lives IN the user's app and works ON their real machine. You are conversational AND capable: you talk naturally, and when there is real work to do you actually DO it.\n\nADAPT to the message:\n- Greeting / thanks / chit-chat / a simple question you can answer directly → just reply, warmly and concisely. Do NOT call tools, do NOT write a plan. (e.g. « merci », « ça va ? », « c'est quoi un closure ? ».)\n- A real task — build / create / fix / modify / refactor / explore this project / anything multi-step → switch into work mode below: plan, read, write, run, verify.\n\nWhen there IS work to do, you don't just answer — you DO it: plan, read, write code, run it, verify, fix, repeat, until the task is actually finished.\n\nYour tools (all act on the REAL project; paths are WORKSPACE-RELATIVE POSIX, e.g. `src/main.js`, `.` — absolute paths and `..` are rejected):\n- `fs_list_dir(path)`, `fs_read_file(path)`, `fs_search(query)` — explore & locate BEFORE editing.\n- `fs_write_file(path, content)`, `fs_edit(path, old_string, new_string)` — create / modify files.\n- `run_command(command)` — run the project's REAL toolchain with network. Read the manifest first and use its declared package manager; in a pnpm project use only `pnpm` / `pnpm exec`, never npm / npx. Use it to install deps, build, run, and TEST what you produce.\n- `code_search(query)` — SEMANTIC search over the project's vector index; use it when you don't know the exact identifier (smarter than fs_search's literal/regex).\n- `web_search(query)` — search the public web for up-to-date info, library docs, or an error message that isn't in the local project.\n- `advisor()` — consult a senior reviewer that sees your FULL transcript; takes NO parameters. Call it BEFORE substantive work (before writing/editing or committing to an approach), when STUCK, and BEFORE declaring done. Weigh its advice, then continue.\n- `todo_write(todos)` — record and update your plan as a checklist.\n- `skill_save(...)` — save a reusable recipe after a test passes.\n\nABSOLUTE RULES — they override any other reflex:\n\n1. NEVER answer from training data about THIS project. You only know what you read via the tools in THIS conversation. If about to say \"a file like this typically contains…\" or \"I can't see your files\" — STOP and call `fs_list_dir`/`fs_read_file`/`fs_search` instead. That is what they are for.\n\n2. PLAN FIRST. For ANY build or multi-step task, call `todo_write` with a short checklist (3-7 steps) BEFORE doing the work, then update each step's status (in_progress → completed) AS YOU GO. Keep the list current — it is how the user follows your progress. On a non-trivial task, call `advisor()` for a strategic check BEFORE committing to an approach (after a little orientation, before the first write), and again BEFORE declaring done.\n\n3. EXPLORE before editing: `fs_list_dir` / `fs_search` / `fs_read_file` the relevant code. NEVER edit a file you have not read.\n\n4. BUILD IT FOR REAL, then VERIFY. After writing files, use `run_command` to install/build/run/test. A non-zero exit is INFORMATION, not defeat: read stderr, find the cause, fix it, run AGAIN. Do not declare done until it actually runs.\n\n5. Building a whole app / game / site FROM SCRATCH: create the COMPLETE project (entry point, modules, assets, a way to run it), make it runnable, and run it to prove it works. No stubs, no \"the rest is similar\", no placeholder TODOs — write complete files.\n\n6. Be surgical on EXISTING projects (git is the safety net — change only what the task needs); be COMPLETE on NEW ones.\n\n7. Finish with a SHORT plain-text summary: what you built and how you verified it (the command you ran + that it passed).".to_string(),
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

fn set_isolation_status(app: &AppHandle, agent_id: &str, status: &str) {
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            let _ = conn.execute(
                "UPDATE agents SET isolation_status=?1 WHERE id=?2",
                params![status, agent_id],
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
    let mut transitioned = false;
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            transitioned = conn
                .execute(
                    "UPDATE agents
                    SET status = 'error',
                        finished_at = ?1,
                        error = ?2
                  WHERE id = ?3 AND status = 'running'",
                    params![now_ms(), err, agent_id],
                )
                .map(|changed| changed == 1)
                .unwrap_or(false);
        }
    }
    if transitioned {
        let _ = persist_and_emit(
            app,
            &AgentEvent::Error {
                agent_id: agent_id.to_string(),
                error: err.to_string(),
            },
        );
    }
    if let Ok(mut g) = state.lock() {
        g.remove(agent_id);
    }
}

fn mark_killed(app: &AppHandle, agent_id: &str) {
    let mut transitioned = false;
    if let Ok(conn_mutex) = get_conn(app) {
        if let Ok(conn) = conn_mutex.lock() {
            transitioned = conn
                .execute(
                    "UPDATE agents
                    SET status = 'killed',
                        finished_at = ?1,
                        error = COALESCE(error, 'killed by user')
                  WHERE id = ?2 AND status IN ('running', 'pending')",
                    params![now_ms(), agent_id],
                )
                .map(|changed| changed == 1)
                .unwrap_or(false);
        }
    }
    if transitioned {
        let _ = persist_and_emit(
            app,
            &AgentEvent::Error {
                agent_id: agent_id.to_string(),
                error: "killed by user".to_string(),
            },
        );
    }
}

// ────────────────────────────────────────────────────────────────────
// Tests — native message builders (Lot 3). Pure functions, no I/O.
// ────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tc(id: &str, name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: name.into(),
            arguments: args.into(),
        }
    }
    fn tr(id: &str, name: &str, is_error: bool, content: &str) -> ToolResult {
        ToolResult {
            id: id.into(),
            name: name.into(),
            is_error,
            content: content.into(),
        }
    }

    // ── OpenAI ────────────────────────────────────────────────────────
    #[test]
    fn openai_text_history() {
        let h = vec![
            AgentMessage::Text {
                role: "system".into(),
                content: "sys".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "hi".into(),
            },
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
    fn openai_coalesces_leading_system_blocks_for_strict_templates() {
        let h = vec![
            AgentMessage::Text {
                role: "system".into(),
                content: "identity".into(),
            },
            AgentMessage::Text {
                role: "system".into(),
                content: "runtime contract".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "task".into(),
            },
        ];
        assert_eq!(
            build_openai_messages(&h),
            vec![
                json!({ "role": "system", "content": "identity\n\nruntime contract" }),
                json!({ "role": "user", "content": "task" }),
            ]
        );
    }

    #[test]
    fn openai_coalesces_consecutive_text_nudges_for_strict_templates() {
        let h = vec![
            AgentMessage::Text {
                role: "user".into(),
                content: "repair the missing proof".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "final iteration".into(),
            },
        ];
        assert_eq!(
            build_openai_messages(&h),
            vec![json!({
                "role": "user",
                "content": "repair the missing proof\n\nfinal iteration"
            })]
        );
    }

    #[test]
    fn openai_folds_controller_reminder_into_tool_result_for_strict_templates() {
        let history = vec![
            AgentMessage::AssistantWithTools {
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "call-plan".into(),
                    name: "todo_write".into(),
                    arguments: "{}".into(),
                }],
            },
            AgentMessage::ToolResults(vec![ToolResult {
                id: "call-plan".into(),
                name: "todo_write".into(),
                content: "plan recorded".into(),
                is_error: false,
            }]),
            AgentMessage::Text {
                role: "user".into(),
                content: "[Shugu system] Plan en cours.".into(),
            },
        ];

        let messages = build_openai_messages(&history);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "tool");
        assert!(messages[1]["content"]
            .as_str()
            .is_some_and(|content| content.contains("Plan en cours")));
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
        assert_eq!(
            normalize_tool_args(r#"{"path":"a.ts"}"#),
            r#"{"path":"a.ts"}"#
        );
        assert_eq!(normalize_tool_args(""), "{}"); // no-arg call → "" rejeté par MiniMax
        assert_eq!(normalize_tool_args(r#"{"path":"trunc"#), "{}"); // streaming coupé
        assert_eq!(normalize_tool_args("\"bare string\""), "{}"); // JSON valide mais pas objet
        assert_eq!(normalize_tool_args("42"), "{}");
    }

    #[test]
    fn ollama_history_links_tool_results_by_name() {
        let h = vec![
            AgentMessage::AssistantWithTools {
                content: String::new(),
                tool_calls: vec![tc("call_1", "fs_read_file", r#"{"path":"a.ts"}"#)],
            },
            AgentMessage::ToolResults(vec![tr("call_1", "fs_read_file", false, "contents")]),
        ];
        assert_eq!(
            build_ollama_messages(&h),
            vec![
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "function": {
                            "name": "fs_read_file",
                            "arguments": {"path": "a.ts"}
                        }
                    }]
                }),
                json!({
                    "role": "tool",
                    "content": "contents",
                    "tool_name": "fs_read_file"
                }),
            ]
        );
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
        assert_eq!(
            out[0],
            json!({ "role": "tool", "tool_call_id": "call_1", "content": "FILE" })
        );
        assert_eq!(
            out[1],
            json!({ "role": "tool", "tool_call_id": "call_2", "content": "[]" })
        );
    }

    // ── Anthropic ─────────────────────────────────────────────────────
    #[test]
    fn anthropic_system_hoisted_user_blocks() {
        let h = vec![
            AgentMessage::Text {
                role: "system".into(),
                content: "S".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "U".into(),
            },
        ];
        let (msgs, system) = build_anthropic_native(&h);
        assert_eq!(system, Some("S".to_string()));
        assert_eq!(
            msgs,
            vec![json!({ "role": "user", "content": [{ "type": "text", "text": "U" }] })]
        );
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
            AgentMessage::Text {
                role: "user".into(),
                content: "[Shugu] final".into(),
            },
        ];
        let (msgs, _) = build_anthropic_native(&h);
        assert_eq!(msgs.len(), 1);
        let blocks = msgs[0]["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "tool_result");
        assert_eq!(
            blocks[1],
            json!({ "type": "text", "text": "[Shugu] final" })
        );
    }

    #[test]
    fn anthropic_alternation_preserved_full_loop() {
        // user → assistant(tool_use) → user(tool_result) → assistant(text)
        let h = vec![
            AgentMessage::Text {
                role: "user".into(),
                content: "task".into(),
            },
            AgentMessage::AssistantWithTools {
                content: "".into(),
                tool_calls: vec![tc("t", "n", "{}")],
            },
            AgentMessage::ToolResults(vec![tr("t", "n", false, "r")]),
            AgentMessage::Text {
                role: "assistant".into(),
                content: "done".into(),
            },
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
        let h = vec![AgentMessage::UserImage {
            text: "look".into(),
            data_url: "".into(),
        }];
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
            AgentMessage::ToolResults(vec![tr(
                "tu_1",
                "capture_screen",
                false,
                "SCREENSHOT_SAVED:/x.jpg",
            )]),
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
            AgentMessage::Text {
                role: "system".into(),
                content: "SEED PROMPT".into(),
            },
            AgentMessage::Text {
                role: "user".into(),
                content: "build a todo app".into(),
            },
            AgentMessage::AssistantWithTools {
                content: "reading".into(),
                tool_calls: vec![tc("c1", "fs_read_file", r#"{"path":"a.ts"}"#)],
            },
            AgentMessage::ToolResults(vec![tr("c1", "fs_read_file", false, "FILE CONTENTS")]),
            AgentMessage::Text {
                role: "assistant".into(),
                content: "done".into(),
            },
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
        let h = vec![AgentMessage::Text {
            role: "user".into(),
            content: long,
        }];
        let ex = transcript_excerpt(&h);
        // "user: " prefix + at most 800 chars for a Text turn + newline.
        assert!(
            ex.len() < 900,
            "excerpt should be bounded, got {}",
            ex.len()
        );
    }

    // ── AM-2 : token-aware compaction trigger (pure, no I/O) ──────────
    fn txt(role: &str, content: &str) -> AgentMessage {
        AgentMessage::Text {
            role: role.into(),
            content: content.into(),
        }
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
        assert_eq!(
            estimate_tokens(&h),
            "look".len() / CHARS_PER_TOKEN + IMAGE_TOKENS
        );
        // A pruned image (empty data_url) carries no flat visual cost.
        let pruned = vec![AgentMessage::UserImage {
            text: "look".into(),
            data_url: "".into(),
        }];
        assert_eq!(estimate_tokens(&pruned), "look".len() / CHARS_PER_TOKEN);
    }

    #[test]
    fn compaction_budget_margin_dominates_small_window() {
        assert_eq!(compaction_budget(8_192), 5_192); // min(6144, 8192-3000)
        assert_eq!(compaction_budget(200_000), 150_000); // fraction dominates
        assert_eq!(compaction_budget(1_000_000), 750_000);
    }

    #[test]
    fn tool_manifest_is_reserved_outside_history_budget() {
        let manifest = serde_json::json!([{
            "type": "function",
            "function": {
                "name": "large_tool",
                "description": "x".repeat(3_000)
            }
        }]);
        let expected_tool_tokens = manifest.to_string().chars().count() / CHARS_PER_TOKEN;
        assert_eq!(
            effective_history_window(16_384, Some(&manifest)),
            16_384 - expected_tool_tokens
        );
        assert_eq!(effective_history_window(2_048, Some(&manifest)), 2_048);
        assert_eq!(effective_history_window(16_384, None), 16_384);
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
        let h = vec![
            txt("system", "seed"),
            txt("user", "hi"),
            txt("assistant", "hello"),
            txt("user", "more"),
            txt("assistant", "ok"),
            txt("user", "again"),
        ];
        assert_eq!(plan_compaction_cut(&h, 1_000_000), None);
    }

    #[test]
    fn plan_cut_none_when_dialogue_at_or_below_keep_tail() {
        // dialogue_len <= KEEP_TAIL → None even with a tiny window ("over budget").
        let h = vec![
            txt("system", "seed"),
            txt("user", "a"),
            txt("assistant", "b"),
            txt("user", "c"),
            txt("assistant", "d"),
        ]; // 4 dialogue turns
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
        assert!(
            cut - 1 >= COMPACTION_FOLD_MIN_TURNS,
            "must fold at least FOLD_MIN turns"
        );
        // Keep the last KEEP_TAIL dialogue turns verbatim.
        assert!(
            cut <= h.len() - COMPACTION_KEEP_TAIL_TURNS,
            "must keep the recent tail"
        );
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
        h.push(AgentMessage::ToolResults(vec![tr(
            "c",
            "fs_read_file",
            false,
            &fat,
        )])); // idx 7
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

    #[test]
    fn sandbox_unavailable_is_a_hard_execution_blocker() {
        let results = vec![tr(
            "run-1",
            "run_command",
            true,
            "sandbox Auto indisponible (sandboxSetupFailed) : commande non exécutée",
        )];

        let message = hard_execution_blocker(&results).expect("hard blocker");
        assert!(message.contains("Full Access"));
        assert!(message.contains("une seule fois"));
    }

    #[test]
    fn ordinary_tool_error_remains_repairable_by_the_model() {
        let results = vec![tr("read-1", "fs_read_file", true, "file not found")];

        assert_eq!(hard_execution_blocker(&results), None);
    }

    #[test]
    fn definition_tool_selectors_are_enforced() {
        let selectors = vec!["read".to_string(), "web".to_string()];
        assert!(definition_allows_tool(Some(&selectors), "fs_read_file"));
        assert!(definition_allows_tool(Some(&selectors), "code_search"));
        assert!(definition_allows_tool(Some(&selectors), "web_search"));
        assert!(definition_allows_tool(Some(&selectors), "todo_write"));
        assert!(!definition_allows_tool(Some(&selectors), "fs_write_file"));
        assert!(!definition_allows_tool(Some(&selectors), "run_command"));
        assert!(!definition_allows_tool(Some(&selectors), "delegate"));
    }

    #[test]
    fn definition_exact_mcp_and_mutating_delegate_rules() {
        let exact = vec!["mcp__figma__get_file".to_string()];
        assert!(definition_allows_tool(Some(&exact), "mcp__figma__get_file"));
        assert!(!definition_allows_tool(
            Some(&exact),
            "mcp__figma__delete_file"
        ));

        let mutating = vec!["edit".to_string()];
        assert!(definition_allows_tool(Some(&mutating), "fs_edit"));
        assert!(definition_allows_tool(Some(&mutating), "delegate"));
        assert!(!definition_allows_tool(Some(&mutating), "fs_write_file"));
    }

    #[test]
    fn hooks_run_only_after_a_successful_permission_preflight() {
        use super::super::permission::ToolPermission;

        assert!(permission_allows_hooks(Some(&ToolPermission::Proceed)));
        assert!(!permission_allows_hooks(Some(&ToolPermission::Ask {
            pattern: "run_command(git push *)".to_string(),
        })));
        assert!(!permission_allows_hooks(Some(&ToolPermission::Blocked(
            "denied".to_string(),
        ))));
        assert!(!permission_allows_hooks(None));
    }
}

#[cfg(test)]
#[path = "runner_provider_contract_tests.rs"]
mod provider_contract_tests;

// ────────────────────────────────────────────────────────────────────
// P6.2 — tests de l'agrégat tokens (Option-aware) et de la décision
// provider/estimate de la jauge de contexte.
// ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod usage_tests {
    use super::*;

    fn turn_usage(
        input: Option<u64>,
        output: Option<u64>,
        cc: Option<u64>,
        cr: Option<u64>,
    ) -> chat::TurnUsage {
        chat::TurnUsage {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cc,
            cache_read_input_tokens: cr,
        }
    }

    #[test]
    fn run_usage_totals_sum_option_aware() {
        let mut totals = RunUsageTotals::default();
        totals.add(&turn_usage(Some(100), Some(10), None, None));
        // Un tour sans sortie rapportée n'efface ni ne fabrique la sortie.
        totals.add(&turn_usage(Some(50), None, Some(20), Some(30)));
        assert_eq!(totals.input, Some(150));
        assert_eq!(totals.output, Some(10));
        assert_eq!(totals.cache_creation, Some(20));
        assert_eq!(totals.cache_read, Some(30));
        // Total = entrée cache incluse + sortie (Anthropic rapporte le cache
        // hors input_tokens → pas de double compte).
        assert_eq!(totals.total(), Some(210));
    }

    #[test]
    fn run_usage_totals_fabricates_nothing_without_reports() {
        let mut totals = RunUsageTotals::default();
        totals.add(&turn_usage(None, None, None, None));
        assert_eq!(totals.total(), None);
        assert_eq!(totals.input, None);
        assert_eq!(totals.output, None);
    }

    #[test]
    fn context_window_source_prefers_provider_measurement() {
        let history = vec![AgentMessage::Text {
            role: "user".to_string(),
            content: "bonjour".to_string(),
        }];
        let (used, source) =
            context_window_source(&turn_usage(Some(120), None, Some(30), Some(40)), &history);
        assert_eq!(used, 190, "entrée réelle cache incluse");
        assert_eq!(source, "provider");
    }

    #[test]
    fn context_window_source_falls_back_to_estimate_honestly() {
        let history = vec![
            AgentMessage::Text {
                role: "system".to_string(),
                content: "tu es un agent".to_string(),
            },
            AgentMessage::Text {
                role: "user".to_string(),
                content: "fais ceci".to_string(),
            },
        ];
        let (used, source) = context_window_source(&turn_usage(None, None, None, None), &history);
        assert_eq!(used, estimate_tokens(&history) as u64);
        assert_eq!(
            source, "estimate",
            "sans mesure provider, la source est honnêtement « estimate »"
        );
    }
}

// ────────────────────────────────────────────────────────────────────
// P6.11 — tests du fan-out parallèle borné (latence ≈ max, ordre préservé,
// cap respecté, slots) et de la cascade de kill (BFS, pas de zombie).
// ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod fanout_tests {
    use super::super::live_descendants_on_conn;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    #[test]
    fn fanout_capacity_is_atomic_across_multiple_parents() {
        let mut capacity = FanoutCapacity::default();

        // Deux parents racine actifs. Le premier réserve 3 enfants et attend :
        // 1 autre racine + 3 enfants = cap 4.
        let first = capacity
            .reserve("parent-1", 2, false, 3)
            .expect("first lease");
        assert_eq!(first, 3);
        assert_eq!(capacity.active_units(2), 4);

        // Le second parent entre ensuite en attente : il ne récupère qu'un
        // slot, jamais 3 supplémentaires.
        let second = capacity
            .reserve("parent-2", 2, false, 3)
            .expect("second lease");
        assert_eq!(second, 1);
        assert_eq!(capacity.active_units(2), 4);

        capacity.release("parent-2", second);
        capacity.release("parent-1", first);
        assert_eq!(capacity.active_units(2), 2);
    }

    #[test]
    fn nested_delegate_temporarily_yields_its_reserved_slot() {
        let mut capacity = FanoutCapacity::default();
        let outer = capacity
            .reserve("root", 1, false, 1)
            .expect("outer delegate");
        assert_eq!(capacity.active_units(1), 1);

        let nested = capacity
            .reserve("delegate", 1, true, 3)
            .expect("nested fan-out");
        assert_eq!(nested, 3);
        assert_eq!(capacity.active_units(1), 3);

        capacity.release("delegate", nested);
        assert_eq!(capacity.active_units(1), 1);
        capacity.release("root", outer);
        assert_eq!(capacity.active_units(1), 1);
    }

    #[tokio::test]
    async fn parallel_wall_time_is_max_not_sum_and_order_preserved() {
        // 3 « enfants » à latences contrôlées 120/300/180 ms.
        let latencies = [120u64, 300, 180];
        let t0 = Instant::now();
        let results = run_bounded_parallel(
            3,
            latencies
                .map(|ms| {
                    move || async move {
                        tokio::time::sleep(Duration::from_millis(ms)).await;
                        ms
                    }
                })
                .into_iter()
                .collect(),
        )
        .await;
        let wall = t0.elapsed();
        let max = *latencies.iter().max().unwrap() as f64;
        let sum: f64 = latencies.iter().sum::<u64>() as f64;
        assert!(
            (wall.as_millis() as f64) < max * 1.5,
            "wall ({:.0} ms) ≈ max ({max} ms), pas somme ({sum} ms)",
            wall.as_millis() as f64
        );
        // L'ordre des résultats suit l'ordre des appels, pas l'ordre de fin.
        assert_eq!(results, vec![120, 300, 180]);
    }

    #[tokio::test]
    async fn bounded_parallel_never_exceeds_slots() {
        let current = std::sync::Arc::new(AtomicUsize::new(0));
        let max_seen = std::sync::Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..5)
            .map(|i| {
                let cur = current.clone();
                let max = max_seen.clone();
                move || async move {
                    let now = cur.fetch_add(1, Ordering::SeqCst) + 1;
                    max.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    cur.fetch_sub(1, Ordering::SeqCst);
                    i
                }
            })
            .collect();
        let t0 = Instant::now();
        let results = run_bounded_parallel(2, tasks).await;
        assert_eq!(results, vec![0, 1, 2, 3, 4], "ordre préservé même en lots");
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            2,
            "jamais plus de 2 tâches actives à la fois"
        );
        // 5 tâches × 120 ms en lots de 2 → ~3 lots ≈ 360 ms (marge généreuse).
        assert!(
            t0.elapsed() < Duration::from_millis(520),
            "le plafond de slots borne bien le parallélisme"
        );
    }

    #[test]
    fn kill_cascade_finds_all_live_descendants_and_leaves_no_zombie() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agents (
                id TEXT PRIMARY KEY, status TEXT, parent_id TEXT, created_at INTEGER NOT NULL,
                finished_at INTEGER
            );
            INSERT INTO agents VALUES ('parent','running',NULL,1,NULL);
            INSERT INTO agents VALUES ('child-1','running','parent',2,NULL);
            INSERT INTO agents VALUES ('child-2','running','parent',3,NULL);
            INSERT INTO agents VALUES ('child-3','running','parent',4,NULL);
            INSERT INTO agents VALUES ('grandchild','running','child-1',5,NULL);
            INSERT INTO agents VALUES ('done-child','complete','parent',6,50);",
        )
        .unwrap();

        // BFS : 3 enfants vivants + le petit-enfant (pas l'enfant terminé).
        let mut desc = live_descendants_on_conn(&conn, "parent").unwrap();
        desc.sort();
        assert_eq!(desc, vec!["child-1", "child-2", "child-3", "grandchild"]);

        // CAS de kill (même SQL que kill_agent_tree) sur parent + descendants :
        // tout passe 'killed', aucune ligne 'running' ne reste (pas de zombie).
        let finished = 999i64;
        for id in std::iter::once("parent").chain(desc.iter().map(String::as_str)) {
            conn.execute(
                "UPDATE agents SET status = 'killed', finished_at = ?1
                  WHERE id = ?2 AND status IN ('running', 'pending')",
                rusqlite::params![finished, id],
            )
            .unwrap();
        }
        let zombies: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM agents WHERE status IN ('running', 'pending')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(zombies, 0, "aucun run zombie après le kill en cascade");
        // L'enfant terminé avant le kill n'est PAS re-tué (CAS honnête).
        let done_status: String = conn
            .query_row("SELECT status FROM agents WHERE id='done-child'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(done_status, "complete");
        // Un second kill ne change rien (CAS perdu, honnêtement).
        let changed = conn
            .execute(
                "UPDATE agents SET status = 'killed' WHERE id = 'parent' AND status IN ('running', 'pending')",
                [],
            )
            .unwrap();
        assert_eq!(changed, 0);
    }
}
