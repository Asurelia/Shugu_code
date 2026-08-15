// Shugu Forge — Studio direct manipulation (Lot A).
//
// Click-to-edit text and contextual element sliders apply INSTANTLY in the
// preview iframe (the injected controller sets contentEditable / inline styles
// at runtime). This module makes those edits DURABLE without an agent turn:
//
//   - exploration frames  → patch the node HTML stored in the canvas doc
//   - live/forge frames   → read the served source file, patch, write back
//
// A patch only applies when the match is EXACTLY ONE occurrence — zero or
// several falls back to an agent turn (buildTextEditTask / buildStyleEditTask),
// so a direct edit never silently rewrites the wrong element.
//
// Pure string surgery, no React / Tauri — unit-tested.

import type { CanvasNode } from "./canvas/studioCanvasDoc";
import type { SelectedElement } from "./studioChat";

export type PatchFailure = "empty" | "not-found" | "ambiguous";

export interface PatchResult {
  ok: boolean;
  html?: string;
  reason?: PatchFailure;
}

/** Escape text the way HTML source would (`&`, `<`, `>`, quotes). */
export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return count;
    count += 1;
    from = i + needle.length;
  }
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/**
 * Replace a text node in HTML source. The text must appear as `>text<`
 * (element boundary on both sides) exactly once — trying both the escaped and
 * raw forms (generated pages sometimes contain literal `&`, rarely entities).
 * Whitespace is normalised the way `textContent` reports it: runs collapse.
 */
export function patchTextInHtml(html: string, oldText: string, newText: string): PatchResult {
  const oldTrim = oldText.trim().replace(/\s+/g, " ");
  const newTrim = newText.trim();
  if (!oldTrim || !newTrim || oldTrim === newTrim) return { ok: false, reason: "empty" };

  const candidates = [...new Set([escapeHtmlText(oldTrim), oldTrim])];
  for (const needle of candidates) {
    const wrapped = `>${needle}<`;
    const hits = countOccurrences(html, wrapped);
    if (hits === 1) {
      return { ok: true, html: replaceOnce(html, wrapped, `>${escapeHtmlText(newTrim)}<`) };
    }
    if (hits > 1) return { ok: false, reason: "ambiguous" };
  }
  return { ok: false, reason: "not-found" };
}

/**
 * Upsert one declaration in the `style` attribute of an opening tag, e.g.
 * `<div class="card">` + ("border-radius","12px")
 *   → `<div class="card" style="border-radius: 12px">`.
 * Returns null when the input does not look like a single opening tag.
 */
export function upsertInlineStyle(openTag: string, prop: string, value: string): string | null {
  const p = prop.trim().toLowerCase();
  const v = value.trim().replace(/;$/, "");
  if (!/^<[a-zA-Z][^>]*>$/.test(openTag) || !/^[a-z-]+$/.test(p) || !v) return null;

  const decl = `${p}: ${v}`;
  const m = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/i.exec(openTag);
  if (!m) {
    const close = openTag.endsWith("/>") ? "/>" : ">";
    const head = openTag.slice(0, openTag.length - close.length);
    return `${head} style="${decl}"${close}`;
  }

  const quote = m[2].startsWith('"') ? '"' : "'";
  const body = (m[3] ?? m[4] ?? "").trim();
  const parts = body
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const idx = parts.findIndex((d) => d.toLowerCase().startsWith(`${p}:`) || d.toLowerCase().startsWith(`${p} :`));
  if (idx >= 0) parts[idx] = decl;
  else parts.push(decl);
  const rebuilt = `${m[1]}${quote}${parts.join("; ")}${quote}`;
  return openTag.slice(0, m.index) + rebuilt + openTag.slice(m.index + m[0].length);
}

/**
 * Apply an inline-style upsert to the ONE element whose opening tag appears
 * exactly once in the source. `open` is the descriptor captured by the preview
 * selection bridge (truncated to 200 chars — tags that long are rare, and a
 * truncated tag simply misses and falls back to the agent).
 */
export function patchStyleInHtml(
  html: string,
  open: string,
  prop: string,
  value: string,
): PatchResult {
  if (!open) return { ok: false, reason: "empty" };
  const updated = upsertInlineStyle(open, prop, value);
  if (!updated) return { ok: false, reason: "empty" };
  const hits = countOccurrences(html, open);
  if (hits === 0) return { ok: false, reason: "not-found" };
  if (hits > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, html: replaceOnce(html, open, updated) };
}

/**
 * Where the served HTML of a canvas node lives on disk (workspace-relative),
 * or null when direct patching is impossible:
 *   - exploration WITHOUT route → caller patches `node.html` in the doc instead
 *   - brand → nothing to patch
 *
 * Workspace pages, forge-silo pages and disk explorations are all
 * workspace-relative paths already — the preview protocol serves them through
 * the same trusted root.
 */
export function sourcePathForNode(node: Pick<CanvasNode, "kind" | "route">): string | null {
  if (node.kind === "brand") return null;
  const route = (node.route ?? (node.kind === "live" ? "index.html" : "")).replace(/^\/+/, "");
  return route || null;
}

// ---------------------------------------------------------------------------
// Agent fallbacks (used when a direct patch is not uniquely applicable)
// ---------------------------------------------------------------------------

/** Agent task for a text edit that could not be patched deterministically. */
export function buildTextEditTask(
  sel: SelectedElement,
  oldText: string,
  newText: string,
): string {
  return [
    "Modifie un texte précis du projet existant dans .shugu-forge/preview/.",
    "Lis d'abord les fichiers actuels, localise l'élément, puis remplace son texte.",
    "",
    "Élément ciblé :",
    `- balise : ${sel.tag}`,
    `- sélecteur : ${sel.selector}`,
    `- HTML : ${sel.open}`,
    "",
    `Remplace le texte « ${oldText.trim().slice(0, 120)} » par « ${newText.trim().slice(0, 200)} ».`,
    "Ne change rien d'autre.",
  ].join("\n");
}

/** Agent task for inline-style edits that could not be patched directly. */
export function buildStyleEditTask(
  sel: SelectedElement,
  styles: Record<string, string>,
): string {
  const list = Object.entries(styles)
    .map(([p, v]) => `- ${p}: ${v};`)
    .join("\n");
  return [
    "Ajuste le style d'un élément précis du projet existant dans .shugu-forge/preview/.",
    "Lis d'abord les fichiers actuels, localise l'élément, puis applique ces déclarations",
    "(style inline sur l'élément, ou classe utilitaire dédiée si le projet en utilise) :",
    "",
    "Élément ciblé :",
    `- balise : ${sel.tag}`,
    `- sélecteur : ${sel.selector}`,
    `- HTML : ${sel.open}`,
    "",
    list,
    "",
    "Ne change rien d'autre.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Contextual sliders — computed-style contract shared with the controller
// ---------------------------------------------------------------------------

/** Properties the injected controller reports for the selected element. */
export const PROBED_STYLE_PROPS = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "padding",
  "margin",
  "border-radius",
  "gap",
] as const;

export interface ElStyle {
  prop: string;
  value: string;
}

/** Slider control descriptor for one probed style (length-ish values only). */
export interface ElSlider {
  prop: string;
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
}

/** True when a probed style can be driven by a slider (single length value). */
export function isSingleLength(v: string): boolean {
  return /^-?[\d.]+(px|rem|em|%)?$/i.test(v.trim());
}

/** Build the slider descriptors shown in the inspector for a selected element. */
export function buildElSliders(styles: ElStyle[]): ElSlider[] {
  const out: ElSlider[] = [];
  for (const s of styles) {
    if (!isSingleLength(s.value)) continue;
    const m = /^(-?[\d.]+)([a-z%]*)$/i.exec(s.value.trim());
    const n = m ? parseFloat(m[1]) || 0 : 0;
    const u = (m?.[2] ?? "") || "px";
    const max =
      s.prop === "border-radius" ? Math.max(64, Math.ceil(n * 2)) : Math.max(96, Math.ceil(n * 2));
    out.push({
      prop: s.prop,
      label: s.prop,
      value: n,
      unit: u,
      min: 0,
      max,
      step: u === "px" ? 1 : 0.05,
    });
  }
  return out;
}

/** Colour-ish probed styles (rendered as swatch + text field, like Tweaks). */
export function isColorStyle(prop: string): boolean {
  return prop === "color" || prop === "background-color";
}
