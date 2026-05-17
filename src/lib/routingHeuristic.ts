// Shugu Forge — routing heuristic for the mascot send path.
//
// Classifies each user message into one of three routes:
//
//   "chat-direct"  Casual / conversational. Send to the chat model
//                  directly, thinking suppressed (fast path).
//   "chat-think"   Substantive question or analytical task. Send to
//                  the chat model with thinking enabled (quality path).
//   "delegate"     Action / development task. Spawn an orchestrator
//                  agent; relay its output verbatim into the chat.
//
// The heuristic is intentionally CHEAP (regex, no LLM call). Settings
// expose a manual override (`routing.delegateOverride`) that takes
// precedence over the regex — "always delegate" forces orchestrator
// for every message, "never delegate" disables routing entirely.
//
// Decision tree (first match wins):
//   1. override = "always-delegate"  → "delegate"
//   2. override = "never-delegate"   → fall through to thinking classifier
//   3. matches a delegate pattern    → "delegate"
//   4. matches a casual pattern      → "chat-direct"
//   5. otherwise                     → "chat-think"
//
// We DO NOT call the LLM to classify. A learned classifier was the
// architecturally tempting choice but adds: (a) one round-trip latency
// before every send, (b) a configuration surface (which model to use as
// router?), (c) a regression vector when the router model itself starts
// hallucinating routes. Regex covers ~95% of real conversations and the
// "always/never" override + the in-chat "you can ask me to delegate
// X" affordance cover the rest.

import { resolveThinking } from "@/lib/thinkingHeuristic";

export type Route = "chat-direct" | "chat-think" | "delegate";

export type DelegateOverride = "always-delegate" | "never-delegate";

/** Parse a stored override value safely. Returns undefined for nulls,
 *  empty strings, or any unknown token. */
export function parseDelegateOverride(stored: string | null | undefined): DelegateOverride | undefined {
  if (stored === "always-delegate" || stored === "never-delegate") return stored;
  return undefined;
}

// ────────────────────────────────────────────────────────────────────
// Patterns
// ────────────────────────────────────────────────────────────────────

// Delegate-signal patterns. Lowercase; matching is case-insensitive
// because `resolveRoute` lowercases the text once before testing.
//
// Categories layered roughly by specificity — the early ones fire on
// short prompts ("crée un agent..."), later ones on long descriptions.
// Order doesn't matter for correctness (any match → delegate); we just
// keep the more readable categories at the top.
const DELEGATE_PATTERNS: RegExp[] = [
  // Explicit agent / task / pipeline requests
  /\b(lance|start|démarre|crée?|create|make|génère?|generate|build|construis?)\b.{0,40}\b(agent|task|tâche|job|script|pipeline|workflow)\b/,

  // Development actions targeting concrete artifacts
  /\b(implémente|implement|code|écris?|write|ajoute?|add|refactor|réécris?|rewrite|migre|migrate)\b.{0,60}\b(fonction|function|module|class|classe|component|composant|api|endpoint|route|feature|hook|service)\b/,

  // File-system mutations
  /\b(crée?|create|écris?|write|modifi(?:e|es|ez)|modify|edit|supprime|delete|déplace|move|renomme|rename)\b.{0,40}\b(le |la |this |that |un |une |a )?(fichier|file|directory|dossier|folder|path)\b/,

  // Git operations
  /\b(commit|push|pull|fetch|branch|branche|merge|rebase|cherry.?pick|stash|tag|release)\b/,

  // Test / build / deploy / run cycles
  /\b(test(?:e|s|ez)?|run tests?|lance(?:r)? les tests?|build|compile|deploy|déploie|publish|publie|ship)\b/,

  // Debug with intent to fix
  /\b(fix|corrige|répare?|debug|resolve|résous?|solve)\b.{0,40}\b(bug|erreur|error|crash|issue|problème|exception|stacktrace|trace)\b/,

  // Research with concrete output expected — abstract artifacts.
  /\b(recherche|research|trouve|find|liste?|list|énumère?|enumerate)\b.{0,60}\b(option|alternative|exemple|example|lib|library|package|solution|pattern|approach)\b/,

  // List/explore the filesystem — concrete artifacts on disk. Real
  // workspaces are the natural target of `fs_list_dir` + `fs_read_file`,
  // so this routes anything mentioning files/folders/directories/repos
  // to the orchestrator. Triggered the regression with "liste les
  // fichiers de src/features/agents…" — that prompt obviously needs
  // tools, not the local mascot guessing from training data.
  //
  // CRITICAL gotcha: `\bfichier\b` does NOT match "fichiers" — `\b`
  // requires a word-boundary AFTER `r`, but `s` is itself a word char
  // so there's no boundary. We embed the plural directly in the
  // alternation (`fichiers?`, `files?`, etc.). Same lesson applies to
  // every artifact word that has a plural form in real prompts.
  /\b(liste?z?|list|énumère?z?|enumerate|montre|show|affiche?z?|display|explore[rz]?|inspect(?:e|er|ez)?|scan|parcour[rz]?)\b.{0,40}\b(fichiers?|files?|dossiers?|directory|directories|folders?|repo|repository|projets?|projects?|modules?|composants?|components?|classes?|fonctions?|functions?|code|arborescences?|tree)\b/,

  // Analyze/summarize/explain code artifacts. "résume ce que fait chacun",
  // "explique cette fonction", "analyse le service auth" — all need to
  // READ the files first, so they're orchestrator work.
  /\b(résume?z?|summarize|summary|analyse[rz]?|analyze|examine[rz]?|étudie[rz]?|study|décri(?:s|t|vez|re)|describe|explique?z?|explain|review|revois?z?|audit)\b.{0,60}\b(fichiers?|files?|dossiers?|directory|directories|folders?|repo|repository|projets?|projects?|modules?|composants?|components?|classes?|fonctions?|functions?|code|services?|hooks?|apis?|endpoints?|routes?|features?|architecture|implementations?|implémentations?)\b/,

  // Multi-step intent (a sequence of actions, not a single answer)
  /\b(d'abord|first|step\s*1|étape\s*1).{0,120}\b(puis|ensuite|then|after that|et après|ensuite)\b/,

  // Web search request
  /\b(cherche|search|google|recherche)\b.{0,20}\b(sur (le |l')?(internet|web)|online)\b/,
];

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Decide which route a user message should follow.
 *
 * @param text     The raw user message text (untrimmed is fine; we
 *                 lowercase + trim internally).
 * @param override Optional manual override from settings. When
 *                 "always-delegate" → always returns "delegate". When
 *                 "never-delegate" → never returns "delegate" but the
 *                 thinking classifier still decides direct vs think.
 */
export function resolveRoute(text: string, override?: DelegateOverride): Route {
  if (override === "always-delegate") return "delegate";

  const lower = text.trim().toLowerCase();

  if (override !== "never-delegate") {
    // Try the delegate patterns. First match wins.
    if (DELEGATE_PATTERNS.some((re) => re.test(lower))) {
      return "delegate";
    }
  }

  // Fall through to the chat-direct vs chat-think split. We reuse the
  // existing thinking heuristic with mode="auto" so the two classifiers
  // stay aligned: anything the thinking heuristic considers "casual"
  // (greetings, "merci", etc.) routes to chat-direct; everything else
  // — questions, mid-length text without delegation triggers — routes
  // to chat-think for quality.
  return resolveThinking("auto", text) ? "chat-think" : "chat-direct";
}
