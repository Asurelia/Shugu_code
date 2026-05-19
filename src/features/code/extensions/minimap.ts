// Shugu Forge — Minimap extension wrapper for CodeMirror 6.
//
// Uses @replit/codemirror-minimap (the only maintained CM6 minimap package).
//
// Word wrap interaction: the minimap package does not support line wrapping.
// The effective minimap value is always derived from `minimap && !wordWrap` in
// CodeMirrorEditor.tsx — a single computed source prevents the two effects from
// fighting each other.

import { Compartment, type EditorState } from "@codemirror/state";
import { showMinimap, type MinimapConfig } from "@replit/codemirror-minimap";
import type { Extension } from "@codemirror/state";

// ─── Module-level Compartment singleton ───────────────────────
//
// Singleton (not useMemo) — same pattern as wordWrapCompartment / stickyScrollCompartment.
export const minimapCompartment = new Compartment();

// ─── Pure logic helper (exported for unit testing) ────────────

/**
 * Compute the minimap configuration for a given editor state.
 *
 * Returns null if the document has more than 5000 lines (performance guard —
 * rendering a full-document minimap for very large files causes measurable
 * frame-rate drops).
 *
 * This function is pure (depends only on state.doc.lines) and is exported so
 * unit tests can exercise the guard without a real EditorView.
 */
export function minimapConfig(state: EditorState): MinimapConfig | null {
  if (state.doc.lines > 5000) return null;
  return {
    create: () => ({ dom: document.createElement("div") }),
    displayText: "blocks",
    showOverlay: "always",
  };
}

// ─── Extension builder ────────────────────────────────────────

/**
 * Build a minimap Extension. Uses Facet.compute so the doc-size guard is
 * REACTIVE: when the user opens / pastes into a file that crosses 5000 lines,
 * the minimap automatically disables. When they trim back below, it re-enables.
 *
 * Without compute, `showMinimap.of(config)` would hardcode the config at build
 * time and the guard in `minimapConfig()` would never run at runtime — only
 * the unit tests would exercise it (silently useless).
 *
 * Call this inside `minimapCompartment.reconfigure(buildMinimap())` to enable,
 * or `minimapCompartment.reconfigure([])` to disable.
 */
export function buildMinimap(): Extension {
  return showMinimap.compute(["doc"], (state) => minimapConfig(state));
}
