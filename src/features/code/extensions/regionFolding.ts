// Shugu Forge — Region folding extension (// #region / // #endregion style).
//
// LOT 1 — registers a foldService handler that recognizes `#region` /
// `#endregion` markers in a variety of comment syntaxes per language.
//
// The handler is invoked by CodeMirror's fold infrastructure (foldGutter,
// Ctrl+Alt+[ keybinding from defaultKeymap, and foldable() which will be
// used by the sticky scroll in LOT 2a). Having this registered here means
// LOT 2a's sticky scroll implementation gets region awareness for free.
//
// Depth 1 (no nesting) for MVP — a nested `#region` inside another is
// treated as a plain line, not as a sub-fold. This covers the vast majority
// of real-world usage and avoids quadratic line scanning on large files.

import { foldService } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

// Per-langId region marker regexes.
// All patterns are anchored (^\s*) — no backtracking risk.
const REGION_MARKERS: Record<string, { begin: RegExp; end: RegExp }> = {
  // Python / Ruby / YAML / Dockerfile use `#`
  python:     { begin: /^\s*#\s*region\b/i,         end: /^\s*#\s*endregion\b/i },
  ruby:       { begin: /^\s*#\s*region\b/i,         end: /^\s*#\s*endregion\b/i },
  yaml:       { begin: /^\s*#\s*region\b/i,         end: /^\s*#\s*endregion\b/i },
  dockerfile: { begin: /^\s*#\s*region\b/i,         end: /^\s*#\s*endregion\b/i },
  // SQL uses `--`
  sql:      { begin: /^\s*--\s*#?region\b/i,      end: /^\s*--\s*#?endregion\b/i },
  // HTML / XML / Vue / Svelte / Markdown use `<!--`
  html:     { begin: /^\s*<!--\s*#?region\b/i,    end: /^\s*<!--\s*#?endregion\b/i },
  xml:      { begin: /^\s*<!--\s*#?region\b/i,    end: /^\s*<!--\s*#?endregion\b/i },
  vue:      { begin: /^\s*<!--\s*#?region\b/i,    end: /^\s*<!--\s*#?endregion\b/i },
  svelte:   { begin: /^\s*<!--\s*#?region\b/i,    end: /^\s*<!--\s*#?endregion\b/i },
  markdown: { begin: /^\s*<!--\s*#?region\b/i,    end: /^\s*<!--\s*#?endregion\b/i },
  // CSS uses `/* ... */`
  css:      { begin: /^\s*\/\*\s*#?region\b/i,    end: /^\s*\/\*\s*#?endregion\b/i },
  // Default: C-style `//` (JS / TS / Rust / Go / Java / C / C++ / PHP …)
  default:  { begin: /^\s*\/\/\s*#?region\b/i,    end: /^\s*\/\/\s*#?endregion\b/i },
};

/**
 * Returns the CodeMirror `foldService` extension that handles `#region` /
 * `#endregion` markers for the given language id.
 *
 * Called once per EditorState.create() — `langId` is captured in the closure
 * so the correct markers are used for the lifetime of that editor instance.
 * A new instance is created on every file-type change (which already triggers
 * a full re-mount via the `[langExt]` useEffect dep).
 */
export function regionFoldingService(langId: string): Extension {
  const markers = REGION_MARKERS[langId] ?? REGION_MARKERS.default;

  return foldService.of((state, lineStart, _lineEnd) => {
    const line = state.doc.lineAt(lineStart);
    const text = line.text;

    // Only handle lines that open a region.
    if (!markers.begin.test(text)) return null;

    // Scan forward for the matching #endregion (depth 1 — no nesting).
    // Bound at +5000 lines from the begin marker: prevents viewport freezes
    // on unclosed #region (mid-typing, generated files where the user hasn't
    // added the closing marker yet). Zero cost for real usage where region
    // bodies never approach this size. Caught by Reviewer A LOT 1.
    const maxLine = Math.min(state.doc.lines, line.number + 5000);
    for (let lineNum = line.number + 1; lineNum <= maxLine; lineNum++) {
      const candidate = state.doc.line(lineNum);
      if (markers.end.test(candidate.text)) {
        // Fold from end of the begin-line to start of the end-line (exclusive).
        // This hides the body but leaves both marker lines visible — standard
        // VS Code behaviour for #region folding.
        return { from: line.to, to: candidate.from - 1 };
      }
    }

    // No matching #endregion found — do not fold.
    return null;
  });
}
