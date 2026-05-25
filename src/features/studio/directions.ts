// Shugu Forge — Design Studio · colour directions (Phase E).
//
// When the user has NOT picked a catalogue design system, the assistant offers
// 5 visual "directions" (OKLch palette + font pairing) — open-design's
// no-brand-spec step. Hybrid model:
//   - CURATED_DIRECTIONS: 5 hand-tuned presets. Local, offline, deterministic
//     — the default and the fallback.
//   - "Regenerate with AI": the orchestrator proposes 5 fresh directions for
//     the brief (DIRECTIONS_PROMPT + parseDirections). No new Rust/provider
//     code — it reuses the existing agent call; a malformed reply falls back to
//     the curated set.
//
// A Direction's colours become CSS custom properties in the generated project
// (see generationContext.directionBlock).

import type { Direction, DiscoveryAnswers } from "./generationContext";

// ────────────────────────────────────────────────────────────────────
// Curated presets — original values (OKLch facts + Google-Fonts pairings).
// Colour roles are consistent across directions so the generated CSS is
// predictable: bg / surface / text / primary / secondary / accent.
// ────────────────────────────────────────────────────────────────────

export const CURATED_DIRECTIONS: Direction[] = [
  {
    id: "midnight-aurora",
    name: "Midnight Aurora",
    colors: [
      { name: "bg", oklch: "oklch(0.18 0.03 265)" },
      { name: "surface", oklch: "oklch(0.24 0.04 265)" },
      { name: "text", oklch: "oklch(0.96 0.01 250)" },
      { name: "primary", oklch: "oklch(0.78 0.14 200)" },
      { name: "secondary", oklch: "oklch(0.62 0.19 290)" },
      { name: "accent", oklch: "oklch(0.72 0.20 330)" },
    ],
    fonts: { display: "Space Grotesk", body: "Inter" },
  },
  {
    id: "terracotta-studio",
    name: "Terracotta Studio",
    colors: [
      { name: "bg", oklch: "oklch(0.97 0.02 80)" },
      { name: "surface", oklch: "oklch(0.94 0.03 75)" },
      { name: "text", oklch: "oklch(0.26 0.03 60)" },
      { name: "primary", oklch: "oklch(0.64 0.15 45)" },
      { name: "secondary", oklch: "oklch(0.58 0.09 130)" },
      { name: "accent", oklch: "oklch(0.70 0.13 30)" },
    ],
    fonts: { display: "Fraunces", body: "Work Sans" },
  },
  {
    id: "nordic-mist",
    name: "Nordic Mist",
    colors: [
      { name: "bg", oklch: "oklch(0.98 0.005 250)" },
      { name: "surface", oklch: "oklch(0.95 0.01 240)" },
      { name: "text", oklch: "oklch(0.30 0.02 250)" },
      { name: "primary", oklch: "oklch(0.55 0.08 250)" },
      { name: "secondary", oklch: "oklch(0.70 0.06 160)" },
      { name: "accent", oklch: "oklch(0.68 0.10 200)" },
    ],
    fonts: { display: "Outfit", body: "Inter" },
  },
  {
    id: "citrus-pop",
    name: "Citrus Pop",
    colors: [
      { name: "bg", oklch: "oklch(0.99 0.005 110)" },
      { name: "surface", oklch: "oklch(0.96 0.02 110)" },
      { name: "text", oklch: "oklch(0.22 0.02 150)" },
      { name: "primary", oklch: "oklch(0.80 0.18 130)" },
      { name: "secondary", oklch: "oklch(0.75 0.17 60)" },
      { name: "accent", oklch: "oklch(0.70 0.18 350)" },
    ],
    fonts: { display: "Poppins", body: "DM Sans" },
  },
  {
    id: "mono-ink",
    name: "Mono Ink",
    colors: [
      { name: "bg", oklch: "oklch(0.98 0 0)" },
      { name: "surface", oklch: "oklch(0.94 0 0)" },
      { name: "text", oklch: "oklch(0.18 0 0)" },
      { name: "primary", oklch: "oklch(0.22 0 0)" },
      { name: "secondary", oklch: "oklch(0.55 0 0)" },
      { name: "accent", oklch: "oklch(0.55 0.20 25)" },
    ],
    fonts: { display: "Playfair Display", body: "Source Sans 3" },
  },
];

// ────────────────────────────────────────────────────────────────────
// AI regeneration
// ────────────────────────────────────────────────────────────────────

function preferencesLine(d: DiscoveryAnswers): string {
  const bits = [
    d.palette && `palette: ${d.palette}`,
    d.mood && `mood: ${d.mood}`,
    d.tone && `tone: ${d.tone}`,
    d.audience && `audience: ${d.audience}`,
    d.typography && `typography: ${d.typography}`,
  ].filter(Boolean);
  return bits.length ? bits.join("; ") : "no specific preferences";
}

/**
 * One-shot prompt asking the orchestrator for 5 directions as strict JSON.
 * Spawned WITHOUT designContext, so the generation mode is never triggered and
 * the agent replies with text (not files).
 */
export function DIRECTIONS_PROMPT(brief: string, discovery: DiscoveryAnswers): string {
  return [
    "You are a senior brand/visual designer. Propose 5 distinct visual directions",
    `for this UI brief: "${brief.trim() || "a modern web interface"}".`,
    `User preferences — ${preferencesLine(discovery)}.`,
    "",
    "Respond with ONLY a JSON array (no prose, no markdown fences) of exactly 5 objects:",
    '[{ "name": string, "colors": [{ "name": string, "oklch": string }], "fonts": { "display": string, "body": string } }]',
    "",
    "Rules:",
    "- Each direction must include colour roles: bg, surface, text, primary, secondary, accent.",
    "- Every colour value MUST be an OKLch string, e.g. \"oklch(0.72 0.16 250)\".",
    "- fonts.display and fonts.body must be real Google Fonts family names.",
    "- Make the 5 directions genuinely different from each other.",
    "- Do NOT write any files. Output the JSON array and nothing else.",
  ].join("\n");
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function isOklch(v: unknown): v is string {
  return typeof v === "string" && /oklch\(/i.test(v);
}

/** Extract the first JSON array from a possibly-noisy model reply. */
function extractJsonArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * Parse + validate the model's reply into Directions. Defensive: coerces each
 * entry, drops malformed ones, and returns whatever valid subset it found
 * (caller falls back to CURATED_DIRECTIONS when this is empty).
 */
export function parseDirections(text: string): Direction[] {
  const json = extractJsonArray(text);
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: Direction[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim() : `Direction ${i + 1}`;

    const colorsRaw = Array.isArray(o.colors) ? o.colors : [];
    const colors = colorsRaw
      .map((c) => {
        const co = (c ?? {}) as Record<string, unknown>;
        return typeof co.name === "string" && isOklch(co.oklch)
          ? { name: co.name.trim().replace(/[^a-z0-9-]/gi, ""), oklch: co.oklch }
          : null;
      })
      .filter((c): c is { name: string; oklch: string } => c !== null);
    if (colors.length === 0) return; // unusable without a palette

    const fontsRaw = (o.fonts ?? {}) as Record<string, unknown>;
    const fonts = {
      display: typeof fontsRaw.display === "string" && fontsRaw.display.trim() ? fontsRaw.display.trim() : "Inter",
      body: typeof fontsRaw.body === "string" && fontsRaw.body.trim() ? fontsRaw.body.trim() : "Inter",
    };

    out.push({ id: `${slug(name) || "direction"}-${i}`, name, colors, fonts });
  });
  return out;
}
