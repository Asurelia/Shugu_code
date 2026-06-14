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
import { invoke }              from "@/lib/tauri";
import { invalidateSkills }    from "@/features/agents/skillsQueries";

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
  // 0. Read the user-configured advisor model (routing.advisorModel). When set,
  //    it overrides the model pinned in the reviewer .md (but we still need the
  //    reviewer def for agentDefPath + baseRole).
  let advisorModelSetting: string | null = null;
  try {
    advisorModelSetting = await db.settings.get("routing.advisorModel");
  } catch {
    // non-critical — fall through to reviewer.model
  }

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

  // Effective model: advisorModel setting (if non-empty) takes priority over
  // the reviewer .md pinned model. Fallback = reviewer.model (current behaviour).
  const effectiveModel =
    advisorModelSetting && advisorModelSetting.trim() !== ""
      ? advisorModelSetting.trim()
      : reviewer.model;

  // If neither source gives us a model, there is nothing to resolve.
  if (!effectiveModel) {
    console.warn("[supervisors] reviewer agent has no model pinned and routing.advisorModel is unset — skip");
    return null;
  }

  // 2. Resolve provider from the effective model.
  const {
    providerId,
    protocol: defDefaultProto,
    baseUrl: defDefaultBase,
    model: realModel,
  } = resolveProvider(effectiveModel);

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
// resolveAdvisorArgs — modèle CONSEILLER de l'outil `advisor` in-loop (v2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Résout le modèle conseiller distinct pour l'outil `advisor` IN-LOOP (runner
 * consult_advisor). Lit `routing.advisorModel` ; si vide/absent ou provider
 * désactivé → `null` (le runner retombe sur l'AUTO-consultation = le modèle de
 * l'exécuteur). Contrairement à `resolveReviewerArgs`, n'exige AUCUN agent
 * reviewer : seuls le modèle + son provider comptent (le conseiller in-loop
 * n'est pas un agent spawné, c'est une sous-inférence côté Rust).
 */
export async function resolveAdvisorArgs(): Promise<{
  model: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string | undefined;
} | null> {
  let setting: string | null = null;
  try {
    setting = await db.settings.get("routing.advisorModel");
  } catch {
    return null;
  }
  if (!setting || setting.trim() === "") return null;
  const advisorModel = setting.trim();

  const { providerId, protocol: defProto, baseUrl: defBase, model: realModel } =
    resolveProvider(advisorModel);

  let enabled: string | null;
  try {
    enabled = await getProviderEnabled(providerId);
  } catch {
    enabled = null;
  }
  if (enabled !== "true") return null;

  const cfg = await loadProviderConfig(providerId);
  let protocol: Protocol = defProto;
  if (defProto === "custom") {
    const stored = await getConfig(providerId, "protocol");
    if (stored === "anthropic" || stored === "openai" || stored === "ollama" || stored === "custom") {
      protocol = stored;
    }
  }
  const baseUrl = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : defBase;
  const apiKey = cfg.apiKey && cfg.apiKey !== "" ? cfg.apiKey : undefined;

  return { model: realModel, protocol, baseUrl, apiKey };
}

// ────────────────────────────────────────────────────────────────────────────
// superviseDeliverable — main entry point
// ────────────────────────────────────────────────────────────────────────────
//
// NOTE : `supervisePlan` (ex-S2, revue de plan post-hoc « plan-only ») a été
// RETIRÉ le 2026-06-14 — la planification AVANT l'exécution passe désormais par
// l'outil `advisor` IN-LOOP (model-invoked, runner.rs consult_advisor). Il ne
// reste que S1 (revue du livrable → leçons).

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
      `**APPROUVÉ** | **BLOQUÉ** | **À CORRIGER**\n\n` +
      `---\n\n` +
      `**Distillation de compétence (obligatoire)** : après ton verdict, termine TOUJOURS ` +
      "par un bloc JSON (même si le run est mediocre — renvoie `{}` dans ce cas) :\n\n" +
      "```json\n" +
      '{ "skill_name": "...", "when_to_use": "...", "body": "..." }\n' +
      "```\n\n" +
      "`skill_name` : nom court et réutilisable de la leçon (ex : \"Toujours vérifier X avant Y\").\n" +
      "`when_to_use` : quand appliquer ce skill (1 phrase).\n" +
      "`body` : la leçon concrète, en Markdown, ≤ 200 mots.\n" +
      "Si aucune leçon réutilisable ne se dégage, renvoie exactement `{}`.";

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

    // 7. Parse the verdict from the reviewer's output. Strip JSON code blocks
    //    first — the distillation block appended at the end of the prompt can
    //    contain words like "bloqué" or "à corriger" in the skill body, which
    //    would corrupt the verdict (parseVerdict uses lastIndexOf).
    const verdictSource = output
      .replace(/```json[\s\S]*?```/g, "")   // blocs json fermés
      .replace(/```json[\s\S]*$/g, "");      // bloc json non fermé (LLM tronqué) → jusqu'à la fin
    const verdict = parseVerdict(verdictSource);

    // R3 — validation renforcée. Le run reviewé compte comme un SUCCÈS objectif
    // (→ leçon fiable, réinjectable en S3) seulement s'il s'est terminé proprement
    // (status complete), SANS erreur d'outil (distress 0), et — si le run a exécuté
    // des commandes de vérif — sans `run_command` en échec (exit ≠ 0).
    const runHadFailedExec = (events: AgentEventRow[]): boolean => {
      const execIds = new Set<string>();
      for (const ev of events) {
        if (ev.kind !== "toolCall") continue;
        try {
          const p = JSON.parse(ev.payload) as { tool?: string; toolCallId?: string };
          if (p.tool === "run_command" && p.toolCallId) execIds.add(p.toolCallId);
        } catch { /* payload illisible — ignore */ }
      }
      if (execIds.size === 0) return false;
      for (const ev of events) {
        if (ev.kind !== "toolResult") continue;
        try {
          const p = JSON.parse(ev.payload) as { toolCallId?: string; result?: unknown; error?: string };
          if (!p.toolCallId || !execIds.has(p.toolCallId)) continue;
          if (p.error) return true; // l'outil lui-même a échoué
          const resStr = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
          // run_command préfixe son résultat par "[exit {code}]" ou "[TIMED OUT …]"
          // (tools.rs:546-554). Le timeout est un ÉCHEC. Le préfixe entre crochets
          // est en tête → first-match fiable (le stdout ne masque pas le vrai code,
          // et c'est robuste si `result` est JSON-wrappé).
          if (resStr.includes("[TIMED OUT")) return true;
          const m = resStr.match(/\[exit\s+(-?\d+)\]/);
          if (m && m[1] !== "0") return true;
        } catch { /* ignore */ }
      }
      return false;
    };
    const runSucceeded =
      transcript.agent.status === "complete" &&
      distress === 0 &&
      !runHadFailedExec(transcript.events);

    // 8. Persist the review row.
    const reviewRow: ReviewRow = {
      id:          `rev_${reviewerId}`,
      agent_id:    agentId,
      reviewer_id: reviewerId,
      kind:        "deliverable",
      verdict,
      // S3 — validée immédiatement si le run reviewé est un succès objectif
      // (cf. runSucceeded R3). La promotion ne PEUT PAS se faire au record_outcome
      // Rust : la review n'existe pas encore à ce moment-là.
      validated:   runSucceeded ? 1 : 0,
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

    // 11. Skill distillation — advisor gate: only when the run was objectively
    //     successful (R3). Parse the LAST ```json…``` block from the reviewer's
    //     output, validate non-empty skill_name + body, then persist via
    //     skill_save_advisor. Any parse/network/validation error is silently
    //     swallowed — this step must never block the review flow.
    // Ne distille un skill QUE si le run est un succès objectif (R3) ET que
    // l'advisor a APPROUVÉ — on ne fige pas en leçon le travail d'un run que le
    // reviewer a jugé à corriger/bloqué (revue sécurité m3).
    if (runSucceeded && verdict === "APPROUVÉ") {
      try {
        // Extract the last ```json ... ``` block.
        const jsonBlocks = [...output.matchAll(/```json\s*([\s\S]*?)```/g)];
        const lastBlock  = jsonBlocks.at(-1);
        if (lastBlock) {
          const raw = lastBlock[1].trim();
          // Narrow the parsed value — avoid `any`.
          const parsed: unknown = JSON.parse(raw);
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) {
            const rec = parsed as Record<string, unknown>;
            const skill_name  = rec["skill_name"];
            const when_to_use = rec["when_to_use"];
            const body        = rec["body"];

            if (
              typeof skill_name  === "string" && skill_name.trim()  !== "" &&
              typeof body        === "string" && body.trim()         !== ""
            ) {
              await invoke<void>("skill_save_advisor", {
                role:       transcript.agent.role,
                name:       skill_name.trim(),
                whenToUse:  typeof when_to_use === "string" ? when_to_use.trim() : "",
                body:       body.trim(),
              });
              invalidateSkills(transcript.agent.role);
            }
          }
        }
      } catch {
        // Silently ignore — distillation is best-effort enrichment.
      }
    }

  } catch (err) {
    // The supervisor MUST NOT propagate errors — log and return silently.
    console.warn("[supervisors] superviseDeliverable failed:", err);
  } finally {
    activeSupervisions--;
  }
}
