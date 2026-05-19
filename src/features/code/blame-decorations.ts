// Shugu Forge — Git blame inline gutter decorations (LOT 3 bis).
//
// ## Design
//
// `blameCompartment` is a module-level singleton Compartment — same pattern
// as `gitDiffCompartment` in `git-decorations.ts` (mirror that file for
// style). Creating the Compartment per-instance via `useMemo` would risk
// reconfigure() landing on a slot absent from the editor state (see
// `git-decorations.ts:38` rationale).
//
// ## Usage in CodeMirrorEditor.tsx
//
//   1. Include `blameCompartment.of([])` in the initial extension list
//      (after `gitDiffCompartment.of([])` to keep the visual order
//      consistent with the rest of the LOT 3 IPC contract).
//   2. On mount + whenever `blame` or `gitBlameEnabled` change:
//      view.dispatch({ effects: blameCompartment.reconfigure(
//        buildBlameGutter(blame, gitBlameEnabled),
//      )});
//
// ## What `buildBlameGutter` returns
//
// - When `enabled` is false (user toggle off via `editorPrefs.gitBlame`):
//   returns `[]` — no gutter, no tooltip extension.
// - When `blameLines` is null (loading, untracked file, not a repo):
//   returns `[]`.
// - Otherwise: returns `[gutter(...), hoverTooltip(...)]` configured with
//   per-line GutterMarker instances showing short SHA + author first name
//   + relative time, plus a rich hover tooltip with full metadata.
//
// ## Why a custom GutterMarker subclass
//
// `gutter({ markers })` expects a RangeSet<GutterMarker>. The CM6 docs
// emphasize that GutterMarker subclasses MUST override `eq()` so RangeSet
// diffing skips identical markers across viewport updates (avoids re-render
// of the gutter on every keystroke). We compare by `oid` because blame is
// keyed by commit OID — two adjacent lines from the same commit produce
// equal markers and can be deduped.
//
// ## Bounds safety
//
// The blame array reflects HEAD content; the live doc may be shorter or
// longer (uncommitted edits). We iterate the blame array and guard with
// `entry.lineNumber <= doc.lines` before calling `doc.line(n)` (which
// throws when out of range). Same guard in the hoverTooltip source.

import { Compartment, RangeSet, RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { GutterMarker, gutter, hoverTooltip } from "@codemirror/view";
import type { EditorView, Tooltip, TooltipView } from "@codemirror/view";
import type { GitBlameLine } from "@/lib/types";

// ---------------------------------------------------------------------------
// Module-level singleton — must NOT be recreated on re-render.
// ---------------------------------------------------------------------------

export const blameCompartment = new Compartment();

// ---------------------------------------------------------------------------
// Relative-time formatter (pure, injectable `now` for tests)
// ---------------------------------------------------------------------------

/** Seconds in common time buckets. */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Convert a Unix timestamp (seconds) into a short human-readable relative
 * time label like "5m", "2h", "3d", "5w", "2mo", "1y", "now", "future".
 *
 * The `nowSecs` parameter MUST be injectable so unit tests can pin "now"
 * to a known value and check boundary conditions deterministically.
 *
 * @param timestampSecs - Unix seconds (UTC).
 * @param nowSecs - "Now" reference in Unix seconds. Defaults to wall clock.
 */
export function formatRelativeTime(
  timestampSecs: number,
  nowSecs: number = Math.floor(Date.now() / 1000),
): string {
  const delta = nowSecs - timestampSecs;
  // Future timestamps (clock skew, rebased commits with weird author dates):
  // collapse to a single label rather than rendering a negative number.
  if (delta < 0) return "future";
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d`;
  if (delta < MONTH) return `${Math.floor(delta / WEEK)}w`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}

/**
 * First-name extraction — "Alice Wonderland" → "Alice".
 * Falls back to the full string when there is no whitespace.
 * Exported only for tests; not part of the public API surface.
 */
export function firstName(authorName: string): string {
  const trimmed = authorName.trim();
  if (trimmed.length === 0) return "";
  const space = trimmed.indexOf(" ");
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

// ---------------------------------------------------------------------------
// GutterMarker subclass
// ---------------------------------------------------------------------------

/**
 * Renders a single blame line in the gutter: "abc1234 Alice 3d" — or
 * "------- Uncommitted" for lines not yet committed.
 *
 * `eq()` compares by OID + uncommitted flag so RangeSet diffing skips
 * identical adjacent lines and identical viewport updates.
 */
class BlameGutterMarker extends GutterMarker {
  constructor(
    private readonly entry: GitBlameLine,
    private readonly nowSecs: number,
  ) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    if (!(other instanceof BlameGutterMarker)) return false;
    // Two markers are equivalent when they point to the same commit AND
    // share the uncommitted flag. We deliberately don't compare `nowSecs`
    // — relative time labels are stable across a single render pass.
    return (
      this.entry.oid === other.entry.oid &&
      this.entry.isUncommitted === other.entry.isUncommitted
    );
  }

  override toDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "cm-blame-marker";
    if (this.entry.isUncommitted) {
      dom.classList.add("cm-blame-uncommitted");
      dom.textContent = "------- Uncommitted";
      return dom;
    }
    const sha = this.entry.shortOid.slice(0, 7);
    const name = firstName(this.entry.authorName);
    const time = formatRelativeTime(this.entry.timestamp, this.nowSecs);
    dom.textContent = `${sha} ${name} ${time}`;
    return dom;
  }
}

// ---------------------------------------------------------------------------
// Index helper
// ---------------------------------------------------------------------------

/**
 * Build a Map<lineNumber, GitBlameLine> for O(1) lookup by 1-indexed line.
 * Lines outside the blame coverage (uncommitted edits past HEAD length)
 * simply won't appear in the map — callers must handle the `undefined`
 * case.
 *
 * Exported for tests so we can verify indexing behavior without touching
 * a real EditorView.
 */
export function indexBlameByLine(
  blameLines: GitBlameLine[],
): Map<number, GitBlameLine> {
  const map = new Map<number, GitBlameLine>();
  for (const entry of blameLines) {
    map.set(entry.lineNumber, entry);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Builds the extension list to put inside `blameCompartment`.
 *
 * @param blameLines - Per-line blame from `gitBlame(path)`. Pass `null`
 *   when loading, untracked, or not a git repo.
 * @param enabled - Whether the user enabled inline blame in prefs.
 */
export function buildBlameGutter(
  blameLines: GitBlameLine[] | null,
  enabled: boolean,
): Extension[] {
  if (!enabled || blameLines === null) {
    return [];
  }

  const byLine = indexBlameByLine(blameLines);
  // Pin "now" at build time so every marker in a single reconfigure pass
  // produces identical relative-time labels — avoids the "3d / 3d / 4d"
  // flicker that would occur if each marker called Date.now() separately
  // near a day boundary.
  const nowSecs = Math.floor(Date.now() / 1000);

  // ── Gutter — per-line blame markers ────────────────────────────────
  const blameGutterExtension = gutter({
    class: "cm-gutter-blame",
    markers: (view: EditorView): RangeSet<GutterMarker> => {
      const builder = new RangeSetBuilder<GutterMarker>();
      const docLines = view.state.doc.lines;
      // Iterate the blame array (typically O(file_lines)) and place a
      // marker at each line's `from` position. Guard against blame
      // entries past the live doc length — happens when the user has
      // deleted lines locally and we still have the HEAD blame loaded.
      for (const entry of blameLines) {
        if (entry.lineNumber < 1 || entry.lineNumber > docLines) continue;
        const line = view.state.doc.line(entry.lineNumber);
        builder.add(line.from, line.from, new BlameGutterMarker(entry, nowSecs));
      }
      return builder.finish();
    },
    // The blame markers depend only on the immutable `blameLines` array
    // captured in this closure; they never change for the lifetime of
    // this compartment value. So we don't need lineMarkerChange — when
    // the data changes, the caller reconfigures the compartment with a
    // fresh `buildBlameGutter()` call.
  });

  // ── Hover tooltip — rich popup with full SHA / author / summary ───
  const blameHoverExtension = hoverTooltip(
    (view: EditorView, pos: number): Tooltip | null => {
      const docLines = view.state.doc.lines;
      const lineInfo = view.state.doc.lineAt(pos);
      if (lineInfo.number < 1 || lineInfo.number > docLines) return null;
      const entry = byLine.get(lineInfo.number);
      if (!entry) return null;

      return {
        pos: lineInfo.from,
        end: lineInfo.to,
        above: true,
        create: (): TooltipView => buildBlameTooltipView(entry, nowSecs),
      };
    },
    { hoverTime: 300 },
  );

  return [blameGutterExtension, blameHoverExtension];
}

// ---------------------------------------------------------------------------
// Tooltip view builder
// ---------------------------------------------------------------------------

/**
 * Renders the rich blame tooltip DOM. Kept as a separate function so the
 * structure is easy to inspect (and could be unit-tested if needed),
 * without polluting the main `buildBlameGutter` flow.
 */
function buildBlameTooltipView(
  entry: GitBlameLine,
  nowSecs: number,
): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-blame-tooltip";

  if (entry.isUncommitted) {
    const header = document.createElement("div");
    header.className = "cm-blame-tooltip-uncommitted";
    header.textContent = "Uncommitted changes";
    dom.appendChild(header);
    return { dom };
  }

  // Header: full SHA + relative time.
  const header = document.createElement("div");
  header.className = "cm-blame-tooltip-header";
  const shaSpan = document.createElement("span");
  shaSpan.className = "cm-blame-tooltip-sha";
  shaSpan.textContent = entry.oid;
  const timeSpan = document.createElement("span");
  timeSpan.className = "cm-blame-tooltip-time";
  timeSpan.textContent = formatRelativeTime(entry.timestamp, nowSecs);
  header.appendChild(shaSpan);
  header.appendChild(timeSpan);
  dom.appendChild(header);

  // Author block.
  const author = document.createElement("div");
  author.className = "cm-blame-tooltip-author";
  author.textContent = `${entry.authorName} <${entry.authorEmail}>`;
  dom.appendChild(author);

  // Commit summary.
  const summary = document.createElement("div");
  summary.className = "cm-blame-tooltip-summary";
  summary.textContent = entry.summary;
  dom.appendChild(summary);

  return { dom };
}
