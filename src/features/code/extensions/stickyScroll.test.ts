// Tests for the findStickyHeaders pure logic helper.
//
// Uses EditorState.create with regionFoldingService so foldable() returns
// real ranges for our #region markers. This avoids walking language-specific
// Lezer node names while still exercising the real backward-walk algorithm.
//
// The ViewPlugin DOM behaviour (overlay rendering) is excluded — that requires
// a real browser and is covered by the smoke test plan.

import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { findStickyHeaders } from "./stickyScroll";
import { regionFoldingService } from "./regionFolding";

function makeState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [regionFoldingService("typescript")],
  });
}

describe("findStickyHeaders", () => {
  it("returns empty array when viewportTopLine is 1 (no lines above)", () => {
    const state = makeState("// #region a\nline2\n// #endregion\nline4");
    const headers = findStickyHeaders(state, 1);
    expect(headers).toEqual([]);
  });

  it("returns empty array for a flat file with no foldable lines", () => {
    const doc = Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const state = makeState(doc);
    // Scroll to line 15 — no enclosing regions above
    const headers = findStickyHeaders(state, 15);
    expect(headers).toEqual([]);
  });

  it("detects a single enclosing region header", () => {
    // Line 1 = region start. Line 4 = viewport (inside region).
    const doc = "// #region outer\nline2\nline3\nline4\n// #endregion\nline6";
    const state = makeState(doc);

    // viewportTopLine = 4 -> walk back: line 3 (no fold), line 2 (no fold),
    // line 1 -> foldable returns range from line1.to to line5.from-1 (>= line4.from)
    const headers = findStickyHeaders(state, 4);
    expect(headers).toContain(1);
    expect(headers.length).toBeGreaterThan(0);
  });

  it("returns headers in top-down order (outermost first)", () => {
    // Nested regions: outer starts at line 1, inner at line 3.
    const doc = [
      "// #region outer",  // line 1
      "line2",             // line 2
      "// #region inner",  // line 3
      "line4",             // line 4
      "// #endregion",     // line 5
      "line6",             // line 6
      "// #endregion",     // line 7
    ].join("\n");
    const state = makeState(doc);

    // viewportTopLine = 4 -> both line 1 and line 3 should be headers.
    const headers = findStickyHeaders(state, 4);
    // Assert length FIRST — the previous `if (headers.length >= 2)` wrap
    // would silently pass if the test produced 0 or 1 results. Reviewer A
    // LOT 2a MINOR finding (hidden test gap).
    expect(headers.length).toBeGreaterThanOrEqual(2);
    // Outer (line 1) must appear before inner (line 3).
    expect(headers.indexOf(1)).toBeLessThan(headers.indexOf(3));
  });

  it("respects maxDepth cap", () => {
    // Build 10 nested regions. Only maxDepth should be returned.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`// #region level${i}`);
    lines.push("innermost");
    for (let i = 0; i < 10; i++) lines.push("// #endregion");
    const doc = lines.join("\n");
    const state = makeState(doc);

    const viewportLine = 11; // "innermost"
    const headers = findStickyHeaders(state, viewportLine, 3, 500);
    expect(headers.length).toBeLessThanOrEqual(3);
  });

  it("respects maxWalk cap and returns partial results", () => {
    // Flat file with 1000 lines. Walk with maxWalk=5 should find nothing
    // (no foldable lines in a flat doc) and return early.
    const doc = Array.from({ length: 1000 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const state = makeState(doc);

    const start = Date.now();
    const headers = findStickyHeaders(state, 500, 5, 5);
    const elapsed = Date.now() - start;

    expect(headers.length).toBe(0);
    expect(elapsed).toBeLessThan(100); // maxWalk=5 -> should be near-instant
  });

  it("does not include lines whose fold range ends before viewport", () => {
    // Region that ends BEFORE the current viewport — should not be included.
    const doc = [
      "// #region early",  // line 1
      "line2",             // line 2
      "// #endregion",     // line 3
      "gap line",          // line 4
      "gap line",          // line 5
      "viewport here",     // line 6
    ].join("\n");
    const state = makeState(doc);

    // viewportTopLine = 6. The region at line 1 ends at line 3 (before line 6).
    const headers = findStickyHeaders(state, 6);
    expect(headers).not.toContain(1);
  });
});
