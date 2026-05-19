// Shugu Forge — Sticky scroll overlay for CodeMirror 6.
//
// Uses foldable() from @codemirror/language to detect enclosing scope headers
// without walking Lezer node names (language-agnostic, no per-lang maintenance).
//
// DOM strategy: the overlay is appended to view.scrollDOM.parentNode (= .cm-editor),
// making it a sibling of .cm-scroller. This is intentional: position:sticky inside
// .cm-content fights CodeMirror's virtualization. The sibling placement lets us
// use position:absolute with a known coordinate system (.cm-editor is the offset
// parent for both the overlay and the scroller).

import { ViewPlugin, type EditorView, type ViewUpdate, type PluginValue } from "@codemirror/view";
import { Compartment, type EditorState } from "@codemirror/state";
import { foldable } from "@codemirror/language";

// ─── Module-level Compartment singleton ───────────────────────
//
// Singleton (not useMemo) because it is shared across all CodeMirrorEditor
// instances and never needs to change identity. Matches the wordWrapCompartment
// pattern from extensions/wordWrap.ts.
export const stickyScrollCompartment = new Compartment();

// ─── Pure logic helper (exported for unit testing) ────────────

/**
 * Walk backward from viewportTopLine, collecting enclosing fold headers.
 *
 * A line L is an "enclosing header" if:
 *   - foldable(state, L.from, L.to) returns a range
 *   - that range's `to` is >= viewportTopPos (the fold encloses the viewport)
 *
 * The walk stops when maxDepth headers are found OR maxWalk lines have been
 * examined — whichever comes first. The 500-line walk cap prevents O(N) work
 * on flat files with no folding structure.
 *
 * Returns line numbers (1-based) in top-down order (outermost first).
 */
export function findStickyHeaders(
  state: EditorState,
  viewportTopLine: number,
  maxDepth = 5,
  maxWalk = 500,
): number[] {
  // Defensive bounds — protect callers (including tests) from throwing on
  // out-of-range line numbers. Reviewer A LOT 2a tester finding.
  if (viewportTopLine < 1 || viewportTopLine > state.doc.lines) return [];

  const stack: number[] = [];
  const viewportTopPos = state.doc.line(viewportTopLine).from;
  let walked = 0;

  for (let lineNo = viewportTopLine - 1; lineNo >= 1; lineNo--) {
    if (walked >= maxWalk || stack.length >= maxDepth) break;
    walked++;

    const line = state.doc.line(lineNo);
    let range: { from: number; to: number } | null = null;
    try {
      range = foldable(state, line.from, line.to);
    } catch {
      // foldable can throw on malformed state during rapid edits; skip safely.
    }
    if (range && range.to >= viewportTopPos) {
      // Push to front: we're walking backward, so prepend to get top-down order.
      stack.unshift(lineNo);
    }
  }

  return stack;
}

// ─── ViewPlugin ───────────────────────────────────────────────

class StickyScrollPlugin implements PluginValue {
  private readonly overlay: HTMLDivElement;
  private rafId: number | null = null;
  private readonly scrollHandler: () => void;

  constructor(private readonly view: EditorView) {
    this.overlay = document.createElement("div");
    this.overlay.className = "cm-sticky-overlay";

    // Sibling of .cm-scroller inside .cm-editor (= view.scrollDOM.parentNode).
    // .cm-editor is position:relative, so absolute positioning is correct.
    const parent = view.scrollDOM.parentNode;
    if (parent) {
      parent.appendChild(this.overlay);
    }

    this.scrollHandler = () => {
      if (this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.renderOverlay();
      });
    };

    view.scrollDOM.addEventListener("scroll", this.scrollHandler, { passive: true });

    // First paint: if the file opens already scrolled (cursor restoration),
    // the overlay would otherwise stay blank until the first scroll/update
    // event. Render once here so the user sees correct state on first frame.
    // Reviewer A LOT 2a MAJOR finding.
    this.renderOverlay();
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.geometryChanged) {
      this.renderOverlay();
    }
  }

  destroy() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.view.scrollDOM.removeEventListener("scroll", this.scrollHandler);
    this.overlay.remove();
  }

  private renderOverlay() {
    const view = this.view;
    const { state } = view;
    const scrollTop = view.scrollDOM.scrollTop;

    // Find the document position at the current scroll top.
    // CM6 heights are document-relative (from view.documentTop), but
    // scrollDOM.scrollTop is scroller-relative. Subtract documentTop (which
    // is negative when scrolled down) to convert. Without this correction,
    // the overlay trails by .cm-content padding-top (16px in the veil theme).
    // Reviewer A LOT 2a BLOCKING finding.
    let viewportTopPos: number;
    try {
      const block = view.elementAtHeight(scrollTop - view.documentTop);
      viewportTopPos = block.from;
    } catch {
      this.hideOverlay();
      return;
    }

    const viewportTopLine = state.doc.lineAt(viewportTopPos).number;

    // Hide overlay only when the user hasn't scrolled (line 1 visible at top).
    // The previous `viewportTopPos <= 0` guard rejected scrolling exactly to
    // the document top AND, after the coord-space fix, would falsely match
    // every fold range when viewportTopPos === 0. Reviewer A LOT 2a BLOCKING.
    if (viewportTopLine <= 1) {
      this.hideOverlay();
      return;
    }

    const headerLines = findStickyHeaders(state, viewportTopLine);

    if (headerLines.length === 0) {
      this.hideOverlay();
      return;
    }

    // Sync overlay width with the scroll container minus gutter width.
    // This aligns horizontal scroll so lines appear in the correct column.
    const gutter = view.dom.querySelector(".cm-gutters") as HTMLElement | null;
    const gutterWidth = gutter ? gutter.offsetWidth : 0;
    const totalWidth = view.scrollDOM.clientWidth;
    this.overlay.style.width = `${totalWidth}px`;
    this.overlay.style.paddingLeft = `${gutterWidth}px`;

    // Build header lines as DOM nodes (NOT innerHTML). Each line is a faux
    // .cm-line so it inherits editor typography. textContent eliminates the
    // entire HTML-injection surface — even exotic chars like U+2028 / U+2029
    // / NUL cannot break layout. Reviewer A LOT 2a MAJOR finding.
    this.overlay.replaceChildren();
    for (const lineNo of headerLines) {
      const div = document.createElement("div");
      div.className = "cm-line cm-sticky-line";
      div.textContent = state.doc.line(lineNo).text;
      this.overlay.appendChild(div);
    }
    this.overlay.style.display = "";
  }

  private hideOverlay() {
    this.overlay.replaceChildren();
    this.overlay.style.display = "none";
  }
}

// ─── Extension ────────────────────────────────────────────────

export const stickyScrollExtension = ViewPlugin.fromClass(StickyScrollPlugin);
