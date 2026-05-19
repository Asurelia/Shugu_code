// Shugu Forge — Git inline diff decorations via @codemirror/merge.
//
// ## Design
//
// `gitDiffCompartment` is a module-level singleton Compartment — NOT
// created per-editor-instance via `useMemo`. This mirrors the existing
// pattern for `wordWrapCompartment` (imported into CodeMirrorEditor from
// extensions/wordWrap.ts) and avoids the Compartment recreation trap
// documented in LOT 3 plan section F: recreating the Compartment on each
// render causes CM to treat it as an unknown configuration, silently
// dropping the extension.
//
// ## Usage in CodeMirrorEditor.tsx
//
//   1. Include `gitDiffCompartment.of([])` in the initial extension list.
//   2. On mount + whenever `gitHeadOriginal` changes:
//      view.dispatch({ effects: gitDiffCompartment.reconfigure(
//        buildGitDecorations(gitHeadOriginal, enabled)
//      )});
//
// ## What `buildGitDecorations` returns
//
// - When `original` is null (file untracked, no commits, or git off):
//   returns `[]` — no decoration.
// - When `enabled` is false (user toggled off via editorPrefs.gitDecorations):
//   returns `[]`.
// - Otherwise: returns `[unifiedMergeView({ original, ... })]` configured
//   for read-only merge markers (no interactive merge controls).

import { Compartment } from "@codemirror/state";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Module-level singleton — must NOT be recreated on re-render.
// ---------------------------------------------------------------------------

export const gitDiffCompartment = new Compartment();

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds the extension list to put inside `gitDiffCompartment`.
 *
 * @param original - HEAD content of the file (LF-normalized). Pass `null`
 *   to clear all decorations (untracked file, no commits, or loading).
 * @param enabled - Whether the user has enabled git decorations in prefs.
 */
export function buildGitDecorations(
  original: string | null,
  enabled: boolean,
): Extension[] {
  if (!enabled || original === null) {
    return [];
  }

  return [
    unifiedMergeView({
      original,
      // We show decorations only — no interactive "accept/reject" controls.
      // The merge markers are read-only visual aids, not a conflict resolver.
      mergeControls: false,
      // Highlight changed character ranges within a modified line, not just
      // the full line. Provides finer-grained diff feedback.
      highlightChanges: true,
      // gutter: show added/modified/deleted markers in the line-number gutter.
      gutter: true,
    }),
  ];
}
