// Shugu Forge — thinking-mode router.
//
// Decides whether a user message warrants the model's `<think>...</think>`
// reasoning phase (Qwen 3.5, DeepSeek-R1, Llama-3.3-R) or whether the
// model should answer directly. The default behaviour of thinking-enabled
// models is to ALWAYS reason, which produces 1500-3000 tokens of `<think>`
// before a 30-token reply to "merci" — wasteful and often overflows the
// context budget.
//
// Three user-selectable modes:
//
//   - "auto" (default): classify each user message with the heuristic
//     below. Casual messages → no thinking. Reasoning-flavoured messages
//     → thinking. Medium-length unclassified → thinking (err on the side
//     of quality).
//
//   - "on": force thinking on every message. Matches the model's
//     untouched default.
//
//   - "off": never think. Direct answers only. Fast + cheap, but quality
//     drops on tasks the model can't one-shot.
//
// The heuristic is intentionally CHEAP (regex, no LLM round-trip). An
// LLM-based classifier would add latency on every send for no real win —
// the user has a manual override (force on/off) for edge cases the
// heuristic gets wrong.

export type ThinkingMode = "auto" | "on" | "off";

/** Parse a stored value (from db.settings) into a ThinkingMode. Falls back
 *  to "auto" for missing/unknown values. Accepts legacy boolean strings
 *  ("true"/"false") that were used before the 3-way refactor. */
export function parseThinkingMode(stored: string | null | undefined): ThinkingMode {
  if (stored === "on" || stored === "true")  return "on";
  if (stored === "off" || stored === "false") return "off";
  return "auto";
}

/** Serialize a ThinkingMode for persistence. Stored under
 *  `provider.<id>.enableThinking` via the credentials/settings API. */
export function serializeThinkingMode(m: ThinkingMode): string {
  return m;
}

// ─── Heuristic patterns ────────────────────────────────────────────────

// Greetings, acknowledgments, conversational filler — never worth a 3000-
// token reasoning chain. Matched case-insensitively at the start of the
// message OR as standalone short messages.
const CASUAL_PATTERNS: RegExp[] = [
  /^(salut|hey|hi|hello|bonjour|bonsoir|coucou|yo)\b/,
  /^(merci|thx|thanks|cheers)\b/,
  /^(ok|okay|d'?accord|noté|nice|cool|super|génial|parfait|bien|bravo|top|👍|✓)\b/,
  /^(au revoir|bye|à plus|à \+|à demain|bonne (nuit|soirée|journée))\b/,
  /^(oui|non|yes|no|ouais|nope|yep)\s*[.!]?\s*$/,
  /^(je sais|je vois|ah(\s+ok)?|haha|hihi|lol|mdr|xd)\b/,
  /^(c'?est (parfait|bon|nickel|sympa|cool|top|génial))/,
];

// Reasoning-flavoured keywords. Their presence in the message strongly
// suggests the model should take its time. Includes both French and
// English forms because the user mixes both.
const REASONING_PATTERNS: RegExp[] = [
  /\b(pourquoi|why|comment|how|explain|explique|décris|describe)\b/,
  /\b(analyse|analyze|compare|compute|calcule|prove|démontre|résous|solve)\b/,
  /\b(code|debug|fix|refactor|optimise|optimize|implement|implémente|review)\b/,
  /\b(algorithm|algorithme|complexité|complexity|architecture|design pattern|big[- ]o)\b/,
  /\b(diff[ée]rence entre|difference between|pros and cons|trade[- ]?offs?)\b/,
  /\b(étape par étape|step[- ]by[- ]step|raisonn|reason)\b/,
];

/**
 * Decide whether the given user message benefits from the model's reasoning
 * phase. Used when ThinkingMode === "auto".
 *
 * Decision tree (first match wins):
 *
 *   1. text ≤ 15 chars              → false (too short to be substantive)
 *   2. text matches CASUAL_PATTERNS → false (greeting/ack)
 *   3. text matches REASONING_PATTERNS → true (explicit reasoning ask)
 *   4. text ends with "?" and < 60 chars → false (quick factual question)
 *   5. text ≥ 60 chars              → true (substantial — err on quality)
 *   6. otherwise                    → false (medium length, no signal → fast path)
 */
export function shouldThink(userText: string): boolean {
  const text = userText.trim().toLowerCase();

  // 1. Very short = casual, no thinking.
  if (text.length <= 15) return false;

  // 2. Greetings / acks → no thinking.
  if (CASUAL_PATTERNS.some((re) => re.test(text))) return false;

  // 3. Explicit reasoning keywords → think.
  if (REASONING_PATTERNS.some((re) => re.test(text))) return true;

  // 4. Quick question mark ending without keywords → likely factual lookup.
  //    Trade-off: factual lookups *can* benefit from thinking on hard
  //    questions, but the 60-char threshold catches "Qui a écrit le Petit
  //    Prince ?" vs "Démontre que sqrt(2) est irrationnel et explique
  //    chaque étape ?" — the latter trips the length floor anyway.
  if (text.endsWith("?") && text.length < 60) return false;

  // 5. Long-form input without a clear signal → think (quality bias).
  if (text.length >= 60) return true;

  // 6. Medium length, no signal → fast path.
  return false;
}

/**
 * Resolve the effective thinking decision for the next send, combining the
 * user's preferred mode with the heuristic when mode is "auto".
 *
 * Returns `true` if the model should reason, `false` if it should answer
 * directly. The caller forwards this to `chat_template_kwargs.enable_thinking`.
 */
export function resolveThinking(mode: ThinkingMode, userText: string): boolean {
  if (mode === "on")  return true;
  if (mode === "off") return false;
  return shouldThink(userText);
}
