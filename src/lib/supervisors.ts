// Shugu Forge — Supervisor S1: automatic deliverable review.
//
// Pure TypeScript orchestration, no React, no hooks.
// Entry point: `superviseDeliverable(args)`.
//
// Design contract: this module MUST NOT throw at the call-site.
// Every public function wraps its body in try/catch. A supervisor failure
// is a non-critical event — the primary agent output has already been
// persisted; the review is best-effort enrichment.

import { listAgentDefs }       from "@/lib/agentDefs";
import { resolveProvider, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { spawnAgent, awaitAgentComplete, getAgentTranscript } from "@/lib/agents";
import type { AgentEventRow } from "@/lib/agents";
import { db }                  from "@/lib/db";
import type { ReviewRow }      from "@/lib/db";
import { vecIndex }            from "@/lib/vector";
import type { Message }        from "@/lib/types";

// ────────────────────────────────────────────────────────────────────────────
// Concurrency cap
// ────────────────────────────────────────────────────────────────────────────

// Borne le fan-out : une tâche complexe = jusqu'à 3 runs LLM supplémentaires.
// Sans borne, plusieurs tâches complexes en rafale (surtout petit modèle où
// presque tout est "complexe") satureraient le provider.
const MAX_CONCURRENT_SUPERVISIONS = 2;
let activeSupervisions = 0;

// ────────────────────────────────────────────────────────────────────────────
// Local helpers (replicate logic from chat-sync.ts; those are module-private)
// ────────────────────────────────────────────────────────────────────────────

/** "HH:MM" string for the current local time — same formula as chat-sync. */
function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Generate a scoped message id — same formula as chat-sync. */
function newMessageId(kind: "u" | "a" | "e" | "r"): string {
  const uuid =
    typeof crypto !== "undefined" &&
    typeof (crypto as { randomUUID?: () => string }).randomUUID === "function"
      ? (crypto as { randomUUID: () => string }).randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `m-${kind}-${uuid}`;
}

// ────────────────────────────────────────────────────────────────────────────
// parseVerdict
// ────────────────────────────────────────────────────────────────────────────

export type Verdict = ReviewRow["verdict"];

/**
 * Scan `text` for one of the three canonical verdict tokens.
 * Matching is:
 *   - case-insensitive (APPROUVÉ / approuvé / Approuvé)
 *   - accent-insensitive for "APPROUVE" / "A CORRIGER" variants
 * Returns "unknown" when no verdict token is found.
 */
export function parseVerdict(text: string): Verdict {
  // Normalise: lower-case, strip accents (NFD decomposition).
  const norm = text
    .normalize("NFD")
    // eslint-disable-next-line no-control-regex
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  const lastApprouve = norm.lastIndexOf("approuv");
  const lastBloque   = norm.lastIndexOf("bloqu");
  const corrigerMatches = [...norm.matchAll(/[aà]\s*corriger/g)];
  const lastCorriger =
    corrigerMatches.length > 0
      ? (corrigerMatches[corrigerMatches.length - 1].index ?? -1)
      : -1;

  const max = Math.max(lastApprouve, lastBloque, lastCorriger);
  if (max < 0) return "unknown";
  if (max === lastCorriger) return "À CORRIGER";
  if (max === lastBloque)   return "BLOQUÉ";
  return "APPROUVÉ";
}

// ────────────────────────────────────────────────────────────────────────────
// buildDiffSummary
// ────────────────────────────────────────────────────────────────────────────

/** Tool names that represent a file-write action. */
const WRITE_TOOLS = new Set([
  "fs_write_file",
  "fs_edit",
  "str_replace_editor",
]);

/**
 * Summarise the files an agent wrote during its run.
 *
 * Iterates over `AgentEventRow[]` (raw rows — payload is a JSON string),
 * filters `kind === "toolCall"` for write tools, extracts up to 200 chars
 * of the target content, and caps at 10 files / ~4 000 chars global.
 *
 * Returns "" when no write events are found.
 */
export function buildDiffSummary(events: AgentEventRow[]): string {
  interface ToolCallPayload {
    kind: "toolCall";
    agentId: string;
    toolCallId: string;
    tool: string;
    args: unknown;
  }

  interface WriteArgs {
    path?: string;
    file_path?: string;
    content?: string;
    new_str?: string;
    new_string?: string;
  }

  const MAX_FILES        = 10;
  const EXCERPT_LEN      = 200;
  const GLOBAL_CAP       = 4_000;

  const sections: string[] = [];
  let totalChars  = 0;
  let skipped     = 0;

  for (const row of events) {
    if (row.kind !== "toolCall") continue;

    let parsed: ToolCallPayload;
    try {
      parsed = JSON.parse(row.payload) as ToolCallPayload;
    } catch {
      continue;
    }

    if (!WRITE_TOOLS.has(parsed.tool)) continue;

    if (sections.length >= MAX_FILES) {
      skipped++;
      continue;
    }

    const args    = (parsed.args ?? {}) as WriteArgs;
    const path    = args.path ?? args.file_path ?? "(chemin inconnu)";
    const content = args.content ?? args.new_str ?? args.new_string ?? "";
    const excerpt = String(content).slice(0, EXCERPT_LEN);

    const section = `### ${path}\n${excerpt}`;

    // Global cap check.
    if (totalChars + section.length > GLOBAL_CAP) {
      skipped++;
      continue;
    }

    sections.push(section);
    totalChars += section.length;
  }

  if (sections.length === 0) return "";

  const body = sections.join("\n\n");
  return skipped > 0
    ? `${body}\n\n…(+${skipped} autres fichiers modifiés)`
    : body;
}

// ────────────────────────────────────────────────────────────────────────────
// countDistress
// ────────────────────────────────────────────────────────────────────────────

/**
 * Count the number of tool-result events that carry an error.
 * `AgentEventRow.payload` is a JSON string; we parse it inline.
 */
export function countDistress(events: AgentEventRow[]): number {
  interface ToolResultPayload {
    kind: "toolResult";
    error?: string;
  }

  let count = 0;
  for (const row of events) {
    if (row.kind !== "toolResult") continue;
    try {
      const parsed = JSON.parse(row.payload) as ToolResultPayload;
      if (parsed.error !== undefined && parsed.error !== "") count++;
    } catch {
      // unparseable payload — skip
    }
  }
  return count;
}

// ────────────────────────────────────────────────────────────────────────────
// resolveReviewerArgs
// ────────────────────────────────────────────────────────────────────────────

export interface ReviewerArgs {
  agentDefPath: string;
  role: string;
  model: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string | undefined;
}

/**
 * Find the "reviewer-gpt" (or "reviewer") agent def, resolve its provider,
 * and return the spawn args. Returns `null` if no suitable enabled agent is
 * found or if the associated provider is not configured.
 *
 * Mirrors the readAgentDef + resolveProvider + loadProviderConfig logic
 * used by handleDelegate in chat-sync.ts (lines 711-752).
 */
export async function resolveReviewerArgs(): Promise<ReviewerArgs | null> {
  // 1. List all agent defs and pick the reviewer.
  let defs;
  try {
    defs = await listAgentDefs("all");
  } catch (err) {
    console.warn("[supervisors] listAgentDefs failed:", err);
    return null;
  }

  const reviewer =
    defs.find((d) => d.enabled && d.name === "reviewer-gpt") ??
    defs.find((d) => d.enabled && d.name === "reviewer");

  if (!reviewer) {
    console.warn("[supervisors] no enabled reviewer agent found (reviewer-gpt / reviewer)");
    return null;
  }

  // If the def has no pinned model, there is nothing to resolve.
  if (!reviewer.model) {
    console.warn("[supervisors] reviewer agent has no model pinned — skip");
    return null;
  }

  // 2. Resolve provider from the pinned model.
  const {
    providerId,
    protocol: defDefaultProto,
    baseUrl: defDefaultBase,
    model: realModel,
  } = resolveProvider(reviewer.model);

  // 3. Check provider is enabled.
  let enabled: string | null;
  try {
    enabled = await getProviderEnabled(providerId);
  } catch {
    enabled = null;
  }
  if (enabled !== "true") {
    console.warn(`[supervisors] reviewer provider "${providerId}" not enabled — skip`);
    return null;
  }

  // 4. Load provider config + override custom protocol (mirrors chat-sync lines 734-751).
  const cfg = await loadProviderConfig(providerId);
  let protocol: Protocol = defDefaultProto;
  if (defDefaultProto === "custom") {
    const stored = await getConfig(providerId, "protocol");
    if (
      stored === "anthropic" ||
      stored === "openai"    ||
      stored === "ollama"    ||
      stored === "custom"
    ) {
      protocol = stored;
    }
  }

  const baseUrl = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : defDefaultBase;
  const apiKey  = cfg.apiKey  && cfg.apiKey  !== "" ? cfg.apiKey  : undefined;

  return {
    agentDefPath: reviewer.path,
    role:         reviewer.baseRole || "researcher",
    model:        realModel,
    protocol,
    baseUrl,
    apiKey,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// supervisePlan — S2 gate: plan → review → inject warning if BLOQUÉ
// ────────────────────────────────────────────────────────────────────────────

/**
 * S2 — automatic plan review before execution.
 *
 * 1. Spawns the orchestrator in "plan-only" mode (prompt instructs it not to
 *    write any file, only produce a step-by-step plan).
 * 2. Spawns the reviewer to evaluate that plan.
 * 3. Appends two messages: the plan, then the plan-review verdict.
 * 4. If the reviewer returns BLOQUÉ, injects an advisory warning into the
 *    returned `augmentedTask`. The caller uses this as the real task prompt
 *    for the execution spawn. A BLOQUÉ verdict does NOT stop execution — it
 *    only annotates the task so the orchestrator is aware of the reviewer's
 *    concerns during execution.
 *
 * Returns `null` on ANY internal error — caller must proceed normally in that
 * case (safe-no-op contract, same as superviseDeliverable).
 */
export async function supervisePlan(args: {
  convId: string;
  task: string;
  orch: {
    model: string;
    protocol: Protocol;
    baseUrl: string;
    apiKey: string | undefined;
  };
}): Promise<{ augmentedTask: string } | null> {
  const { convId, task, orch } = args;

  if (activeSupervisions >= MAX_CONCURRENT_SUPERVISIONS) {
    console.warn("[supervisors] limite de supervisions concurrentes — skip");
    return null;
  }
  activeSupervisions++;

  try {
    // Break circular import: chat-sync imports supervisors, so we load
    // appendMessage lazily (same pattern used in chat-sync.ts:890).
    const { appendMessage } = await import("@/features/chat/chat-sync");

    // 1. Resolver le reviewer — si absent, on saute S2.
    const rev = await resolveReviewerArgs();
    if (!rev) {
      console.warn("[supervisors] reviewer unavailable, skip supervisePlan");
      return null;
    }

    // 2. Spawn the orchestrator in "plan-only" mode.
    //    Note: spawnAgent has no flag to disable file-write tools at the JS
    //    layer — the prompt itself instructs the orchestrator not to execute
    //    or write anything. This is best-effort; a poorly-behaved model may
    //    still try to write, but the reviewer step will catch regressions.
    const planPrompt =
      `Produis UNIQUEMENT un plan étape-par-étape pour la tâche suivante.\n` +
      `N'EXÉCUTE rien, n'écris AUCUN fichier, ne modifie rien.\n\n` +
      `Tâche :\n${task}`;

    const plannerId = await spawnAgent({
      role: "orchestrator",
      task: planPrompt,
      model: orch.model,
      protocol: orch.protocol,
      baseUrl: orch.baseUrl,
      apiKey: orch.apiKey,
      conversationId: convId,
    });

    // 3. Await the plan output (90 s cap — plan generation is short).
    const [planPromise] = awaitAgentComplete(plannerId, { timeoutMs: 90_000 });
    const { output: planText } = await planPromise;

    // 4. Persist the plan as a review row (kind = "plan", verdict = "unknown").
    await db.reviews.save({
      id:          `plan_${plannerId}`,
      agent_id:    plannerId,
      reviewer_id: plannerId,
      kind:        "plan",
      verdict:     "unknown",
      validated:   0,
      body:        planText,
      ts:          Date.now(),
    });

    // 5. Spawn the reviewer to evaluate the plan.
    const reviewerPrompt =
      `Voici un PLAN proposé pour la tâche suivante :\n\n` +
      `TÂCHE :\n${task}\n\n` +
      `PLAN :\n${planText}\n\n` +
      `Évalue ce plan : risques, étapes manquantes, erreurs probables, ` +
      `incohérences. Conclus avec un verdict sur une ligne séparée :\n\n` +
      `**APPROUVÉ** | **BLOQUÉ** | **À CORRIGER**`;

    const reviewerId = await spawnAgent({
      role:         rev.role,
      task:         reviewerPrompt,
      model:        rev.model,
      protocol:     rev.protocol,
      baseUrl:      rev.baseUrl,
      apiKey:       rev.apiKey,
      agentDefPath: rev.agentDefPath,
      conversationId: convId,
    });

    // 6. Await reviewer completion.
    const [reviewPromise] = awaitAgentComplete(reviewerId, { timeoutMs: 90_000 });
    const { output: reviewOutput } = await reviewPromise;
    const verdict = parseVerdict(reviewOutput);

    // 7. Persist the plan-review row.
    await db.reviews.save({
      id:          `planrev_${reviewerId}`,
      agent_id:    plannerId,
      reviewer_id: reviewerId,
      kind:        "plan-review",
      verdict,
      validated:   0,
      body:        reviewOutput,
      ts:          Date.now(),
    });

    // Best-effort vector index (fire-and-forget).
    void vecIndex("patterns", reviewerId, reviewOutput).catch(() => {});

    // 8. Append the plan message then the review message to the conversation.
    await appendMessage(convId, {
      id:       newMessageId("r"),
      role:     "ai",
      body:     `📋 Plan proposé\n\n${planText}`,
      ts:       nowHHMM(),
      viaAgent: true,
      agentId:  plannerId,
    });

    await appendMessage(convId, {
      id:       newMessageId("r"),
      role:     "ai",
      body:     `🔎 Revue du plan (${verdict})\n\n${reviewOutput}`,
      ts:       nowHHMM(),
      viaAgent: true,
      agentId:  reviewerId,
    });

    // 9. If BLOQUÉ, augment the task with the reviewer's concerns as an
    //    advisory warning. The execution proceeds regardless — the warning
    //    is injected into the task so the orchestrator is aware of the issues.
    if (verdict === "BLOQUÉ") {
      return {
        augmentedTask:
          task +
          "\n\n[AVERTISSEMENT DU REVIEWER SUR LE PLAN — corrige ces points pendant l'exécution]\n" +
          reviewOutput,
      };
    }

    return { augmentedTask: task };

  } catch (err) {
    // supervisePlan MUST NOT propagate — log and return null so the caller
    // proceeds with a normal (unaugmented) execution.
    console.warn("[supervisors] supervisePlan failed:", err);
    return null;
  } finally {
    activeSupervisions--;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// superviseDeliverable — main entry point
// ────────────────────────────────────────────────────────────────────────────

/**
 * S1 — automatic deliverable review.
 *
 * Spawns the configured reviewer agent against the transcript of `agentId`,
 * persists the review to `agent_reviews`, indexes it for semantic search,
 * and appends a summary message to `convId`.
 *
 * NEVER throws — all errors are caught and logged so the caller's happy path
 * is never interrupted.
 */
export async function superviseDeliverable(args: {
  convId:  string;
  agentId: string;
  task:    string;
}): Promise<void> {
  const { convId, agentId, task } = args;

  if (activeSupervisions >= MAX_CONCURRENT_SUPERVISIONS) {
    console.warn("[supervisors] limite de supervisions concurrentes — skip");
    return;
  }
  activeSupervisions++;

  try {
    // Break circular import: chat-sync imports supervisors, so we load
    // appendMessage lazily (same pattern used in chat-sync.ts:890).
    const { appendMessage } = await import("@/features/chat/chat-sync");

    // 1. Resolve reviewer spawn args.
    const rev = await resolveReviewerArgs();
    if (!rev) {
      console.warn("[supervisors] reviewer unavailable, skip superviseDeliverable");
      return;
    }

    // 2. Fetch the agent's full transcript.
    const transcript = await getAgentTranscript(agentId);

    // 3. Build contextual diff + distress count.
    const diff     = buildDiffSummary(transcript.events);
    const distress = countDistress(transcript.events);

    // 4. Build the reviewer prompt (French, structured).
    const diffSection = diff
      ? `\n\n## Fichiers modifiés\n\n${diff}`
      : "\n\n*(Aucun fichier modifié détecté dans le transcript.)*";

    const prompt =
      `Tu es un reviewer de code. Voici la tâche originale confiée à l'agent :\n\n` +
      `> ${task}\n` +
      `${diffSection}\n\n` +
      `L'agent a rencontré **${distress} erreur(s) d'outil** durant son exécution.\n\n` +
      `**Consigne** : Ne lis PAS d'autres fichiers — le diff ci-dessus te suffit.\n` +
      `Donne une revue structurée (points positifs, points à améliorer, risques) ` +
      `et conclus avec un verdict sur une ligne séparée :\n\n` +
      `**APPROUVÉ** | **BLOQUÉ** | **À CORRIGER**`;

    // 5. Spawn the reviewer agent.
    const reviewerId = await spawnAgent({
      role:         rev.role,
      task:         prompt,
      model:        rev.model,
      protocol:     rev.protocol,
      baseUrl:      rev.baseUrl,
      apiKey:       rev.apiKey,
      agentDefPath: rev.agentDefPath,
      conversationId: convId,
    });

    // 6. Await completion (90 s — reviews are typically short).
    const [waitPromise] = awaitAgentComplete(reviewerId, { timeoutMs: 90_000 });
    const { output } = await waitPromise;

    // 7. Parse the verdict from the reviewer's output.
    const verdict = parseVerdict(output);

    // 8. Persist the review row.
    const reviewRow: ReviewRow = {
      id:          `rev_${reviewerId}`,
      agent_id:    agentId,
      reviewer_id: reviewerId,
      kind:        "deliverable",
      verdict,
      validated:   0,
      body:        output,
      ts:          Date.now(),
    };
    await db.reviews.save(reviewRow);

    // 9. Best-effort vector index (fire-and-forget).
    void vecIndex("patterns", reviewerId, output).catch(() => {});

    // 10. Append the review summary to the conversation.
    const reviewMsg: Message = {
      id:       newMessageId("r"),
      role:     "ai",
      body:     `🔎 Revue (${verdict})\n\n${output}`,
      ts:       nowHHMM(),
      viaAgent: true,
      agentId:  reviewerId,
    };
    await appendMessage(convId, reviewMsg);

  } catch (err) {
    // The supervisor MUST NOT propagate errors — log and return silently.
    console.warn("[supervisors] superviseDeliverable failed:", err);
  } finally {
    activeSupervisions--;
  }
}
