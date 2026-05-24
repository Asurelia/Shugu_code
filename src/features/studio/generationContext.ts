// Shugu Forge — Design Studio · generation-context assembler (Phase C+D+E).
//
// One pure function turns the assistant's inputs (optional design system OR a
// chosen colour direction, the discovery answers, and the skill catalogue)
// into the single `designContext` string that rides the existing agent
// channel: spawnAgent({ designContext }) → SpawnArgs.design_context →
// run_agent_task appends it after GENERATION_MODE_PROMPT (runner.rs:228-234).
//
// Why a pure builder (no React, no fetch): the hard part is the *budget*
// arithmetic — a full DESIGN.md is ~14 KB and the skill catalogue is ~132
// entries, which together overflow a local model's 8–32 KB context. Keeping
// the assembly pure makes that logic unit-testable (generationContext.test.ts)
// without mounting components or mocking Tauri.
//
// Design decisions baked in here:
//   - Design system XOR colour direction. A system IS the brand spec, so when
//     one is active the direction is ignored — the agent never receives two
//     conflicting palette sources.
//   - The user does NOT pick a skill; the AGENT does. We inject the catalogue
//     (name — description) and instruct the orchestrator to select + apply the
//     most relevant skill(s). Local skills are catalogue stubs, so this biases
//     by described approach — full upstream skill execution is Phase K.

import type { ActiveDesignSystem } from "@/features/design/activeDesignSystem";
import { buildDesignSystemPrompt } from "@/features/design/activeDesignSystem";
import type { DesignSkillMeta } from "@/features/design/queries";

// ────────────────────────────────────────────────────────────────────
// Public types (shared with the wizard sub-components)
// ────────────────────────────────────────────────────────────────────

/**
 * Structured discovery answers (Phase D). Dimensions mirror open-design's own
 * `design-brief` skill (palette / typography / layout / mood / density /
 * constraints) plus audience + tone from its `brainstorming` skill. Each is
 * optional; "" (or undefined) means "no preference" and is omitted from the
 * prompt rather than sent as an empty instruction.
 */
export interface DiscoveryAnswers {
  palette?: string;
  typography?: string;
  layout?: string;
  mood?: string;
  density?: string;
  audience?: string;
  tone?: string;
  constraints?: string;
}

export interface DirectionColor {
  /** CSS custom-property base name (becomes `--<name>`), e.g. "primary". */
  name: string;
  /** An OKLch value, e.g. "oklch(0.72 0.16 250)". */
  oklch: string;
}

export interface DirectionFonts {
  display: string;
  body: string;
}

/** A curated or AI-generated visual direction (Phase E). */
export interface Direction {
  id: string;
  name: string;
  colors: DirectionColor[];
  fonts: DirectionFonts;
}

export interface GenerationContextInput {
  /** Active design system, or null when the user chose a direction instead. */
  system: ActiveDesignSystem | null;
  /** Full skill catalogue (queries.useDesignSkills) for agent self-selection. */
  skills: DesignSkillMeta[];
  discovery: DiscoveryAnswers;
  /** Chosen colour direction — applied ONLY when no system is active. */
  direction: Direction | null;
  /** The brief; used only to rank skills by relevance when over budget. */
  brief: string;
}

// ────────────────────────────────────────────────────────────────────
// Budgets (chars). Mirrors buildDesignSystemPrompt's own clip approach.
// ────────────────────────────────────────────────────────────────────

const DEFAULT_MAX = 16000;
// When a full design system is present we cap its slice so the skill catalogue
// and discovery still fit. buildDesignSystemPrompt itself defaults to 14000.
const SYSTEM_BUDGET = 9000;
// Below this remaining budget the skills section is dropped entirely rather
// than emitting a stub with no usable entries.
const MIN_SKILL_BUDGET = 400;

const DISCOVERY_LABELS: Record<keyof DiscoveryAnswers, string> = {
  palette: "Palette",
  typography: "Typography",
  layout: "Layout",
  mood: "Mood",
  density: "Density",
  audience: "Audience",
  tone: "Tone",
  constraints: "Constraints",
};

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n\n[…truncated, ${s.length - n} chars omitted]`;
}

// ────────────────────────────────────────────────────────────────────
// Section builders
// ────────────────────────────────────────────────────────────────────

function directionBlock(d: Direction): string {
  const swatches = d.colors.map((c) => `  --${c.name}: ${c.oklch};`).join("\n");
  const colorList = d.colors.map((c) => `${c.name} ${c.oklch}`).join(", ");
  return [
    `Apply the "${d.name}" colour direction.`,
    `Palette (OKLch): ${colorList}.`,
    `Typography — display: "${d.fonts.display}", body: "${d.fonts.body}" ` +
      `(load both from Google Fonts via a <link> in <head>).`,
    `Declare the palette + fonts as CSS custom properties in :root, e.g.:`,
    "```css",
    ":root {",
    swatches,
    `  --font-display: "${d.fonts.display}", system-ui, sans-serif;`,
    `  --font-body: "${d.fonts.body}", system-ui, sans-serif;`,
    "}",
    "```",
  ].join("\n");
}

function discoveryBlock(a: DiscoveryAnswers): string {
  const keys = Object.keys(DISCOVERY_LABELS) as (keyof DiscoveryAnswers)[];
  return keys
    .map((k) => {
      const v = (a[k] ?? "").trim();
      return v ? `- ${DISCOVERY_LABELS[k]}: ${v}` : null;
    })
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** Term-overlap score of a skill against the brief (cheap, deterministic). */
function scoreSkill(skill: DesignSkillMeta, terms: string[]): number {
  const hay = `${skill.name} ${skill.description} ${skill.category}`.toLowerCase();
  let score = 0;
  for (const t of terms) if (hay.includes(t)) score += 1;
  return score;
}

/**
 * The skill catalogue, as `- name — description` lines. When the full list
 * fits the budget it's emitted whole (agent chooses freely). When it doesn't,
 * we rank by brief-relevance and keep as many top entries as fit, with an
 * explicit trim marker so the model knows the list is partial.
 */
function skillsBlock(skills: DesignSkillMeta[], brief: string, budget: number): string {
  const entry = (s: DesignSkillMeta) => `- ${s.name} — ${s.description}`.trim();
  const full = skills.map(entry).join("\n");
  if (full.length <= budget) return full;

  const terms = brief
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const ranked = [...skills]
    .map((s, i) => ({ s, i, score: scoreSkill(s, terms) }))
    // stable sort: score desc, then original order
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const picked: string[] = [];
  let used = 0;
  for (const { s } of ranked) {
    const line = entry(s);
    if (used + line.length + 1 > budget) break;
    picked.push(line);
    used += line.length + 1;
  }
  const marker = `\n\n[catalogue trimmed to the ${picked.length} most relevant of ${skills.length} skills]`;
  return picked.join("\n") + marker;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Assemble the full `designContext` string for a Studio generation. Sections
 * are self-headed (## …) so they read correctly regardless of which the Rust
 * label precedes them, and the whole is hard-clipped to `maxChars`.
 *
 * Returns "" when there is genuinely nothing to inject (no system, no
 * direction, no discovery, no skills) — callers should pass `undefined` to
 * spawnAgent in that case so the normal (non-generation) path is unaffected.
 */
export function buildGenerationContext(
  input: GenerationContextInput,
  maxChars = DEFAULT_MAX,
): string {
  const { system, skills, discovery, direction, brief } = input;
  const parts: string[] = [];

  // 1. Brand source — design system XOR colour direction.
  if (system) {
    parts.push(`## DESIGN SYSTEM\n${buildDesignSystemPrompt(system, SYSTEM_BUDGET)}`);
  } else if (direction) {
    parts.push(`## COLOUR DIRECTION\n${directionBlock(direction)}`);
  }

  // 2. Discovery (only non-empty dimensions).
  const disc = discoveryBlock(discovery);
  if (disc) parts.push(`## USER PREFERENCES (discovery)\n${disc}`);

  // 3. Skill catalogue for agent self-selection (fills remaining budget).
  if (skills.length > 0) {
    const used = parts.join("\n\n").length;
    const skillBudget = maxChars - used - 400; // reserve room for the header
    if (skillBudget >= MIN_SKILL_BUDGET) {
      const block = skillsBlock(skills, brief, skillBudget);
      parts.push(
        "## AVAILABLE DESIGN SKILLS\n" +
          "Select the design skill(s) most relevant to the request, apply their " +
          "approach, and state which you applied. Then build the UI.\n\n" +
          block,
      );
    }
  }

  return clip(parts.join("\n\n"), maxChars);
}
