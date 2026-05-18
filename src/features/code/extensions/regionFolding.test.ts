// LOT 1 — Unit tests for regionFoldingService.
//
// Tests the foldService extension end-to-end: creates a real EditorState with
// regionFoldingService(langId) registered, then calls @codemirror/language's
// foldable() which dispatches to our handler. Returned {from, to} ranges are
// asserted against expected positions.
//
// Covered:
//   * All 5 comment styles (//, #, <!--, /*, --)
//   * Dockerfile regression (was wrongly falling to // before the fix)
//   * Unclosed regions return null (do not crash)
//   * Bounded scan: 6000-line unclosed region returns quickly (no freeze)
//   * Non-region line returns null
//   * Unknown langId falls to default C-style regex

import { describe, test, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { foldable } from "@codemirror/language";
import { regionFoldingService } from "./regionFolding";

function makeState(langId: string, doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [regionFoldingService(langId)],
  });
}

function foldableOfFirstLine(state: EditorState) {
  const line = state.doc.line(1);
  return foldable(state, line.from, line.to);
}

describe("regionFoldingService", () => {
  describe("comment-style detection", () => {
    test("C-style // in TypeScript", () => {
      const doc = "// #region helpers\nfunction a() {}\nfunction b() {}\n// #endregion";
      const state = makeState("typescript", doc);
      const range = foldableOfFirstLine(state);
      expect(range).not.toBeNull();
      const beginLine = state.doc.line(1);
      const endLine = state.doc.line(4);
      expect(range!.from).toBe(beginLine.to);     // body starts after begin line
      expect(range!.to).toBe(endLine.from - 1);   // body ends before endregion line
    });

    test("Hash # in Python", () => {
      const doc = "# region setup\nimport os\nimport sys\n# endregion";
      const state = makeState("python", doc);
      const range = foldableOfFirstLine(state);
      expect(range).not.toBeNull();
    });

    test("Hash # in YAML", () => {
      const doc = "# region config\nkey: value\nother: 42\n# endregion";
      const state = makeState("yaml", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("Hash # in Ruby", () => {
      const doc = "# region helpers\ndef foo\nend\n# endregion";
      const state = makeState("ruby", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("HTML comment <!-- in HTML", () => {
      const doc = "<!-- #region nav -->\n<nav>...</nav>\n<!-- #endregion -->";
      const state = makeState("html", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("HTML comment <!-- in Vue", () => {
      const doc = "<!-- #region template -->\n<div></div>\n<!-- #endregion -->";
      const state = makeState("vue", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("HTML comment <!-- in Svelte", () => {
      const doc = "<!-- #region setup -->\n<script></script>\n<!-- #endregion -->";
      const state = makeState("svelte", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("HTML comment <!-- in Markdown", () => {
      const doc = "<!-- #region intro -->\nText.\n<!-- #endregion -->";
      const state = makeState("markdown", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("CSS comment /* in CSS", () => {
      const doc = "/* #region colors */\n:root { --c: red; }\n/* #endregion */";
      const state = makeState("css", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("SQL comment -- in SQL", () => {
      const doc = "-- #region tables\nCREATE TABLE foo (id int);\n-- #endregion";
      const state = makeState("sql", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });
  });

  describe("dockerfile regression (tester-flagged bug fix)", () => {
    test("Dockerfile uses # not //", () => {
      // BEFORE the fix: dockerfile fell to default C-style `//` regex and
      // # region was silently ignored. After fix: dockerfile is in the
      // # cluster alongside python/ruby/yaml.
      const doc = "# region build\nFROM node:20\nRUN npm install\n# endregion";
      const state = makeState("dockerfile", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("Dockerfile does NOT accept // (would be wrong for shell-style comments)", () => {
      const doc = "// #region wrong\nFROM node:20\n// #endregion";
      const state = makeState("dockerfile", doc);
      expect(foldableOfFirstLine(state)).toBeNull();
    });
  });

  describe("edge cases", () => {
    test("non-region line returns null", () => {
      const doc = "function foo() {}\nfunction bar() {}";
      const state = makeState("typescript", doc);
      expect(foldableOfFirstLine(state)).toBeNull();
    });

    test("unclosed #region (no matching #endregion) returns null", () => {
      const doc = "// #region orphan\nfunction a() {}\nfunction b() {}";
      const state = makeState("typescript", doc);
      expect(foldableOfFirstLine(state)).toBeNull();
    });

    test("unknown langId falls to default C-style regex", () => {
      const doc = "// #region foo\nbody\n// #endregion";
      const state = makeState("klingon", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });

    test("optional # in marker — both 'region' and '#region' accepted", () => {
      const docWithHash = "// #region foo\nbody\n// #endregion";
      const docWithout = "// region foo\nbody\n// endregion";
      expect(foldableOfFirstLine(makeState("typescript", docWithHash))).not.toBeNull();
      expect(foldableOfFirstLine(makeState("typescript", docWithout))).not.toBeNull();
    });

    test("word-boundary: '#regions' (plural) does NOT match", () => {
      const doc = "// #regions plural\nbody\n// #endregion";
      const state = makeState("typescript", doc);
      expect(foldableOfFirstLine(state)).toBeNull();
    });

    test("leading whitespace tolerated", () => {
      const doc = "    // #region indented\nbody\n    // #endregion";
      const state = makeState("typescript", doc);
      expect(foldableOfFirstLine(state)).not.toBeNull();
    });
  });

  describe("bounded forward scan (Reviewer A fix)", () => {
    test("unclosed region in 6000-line file returns null quickly", () => {
      // The scan must bail at line.number + 5000 to avoid viewport freezes.
      // Without the bound, scanning 6000 lines on every gutter refresh would
      // be a perf cliff. With the bound, this completes in < 50 ms.
      const lines = ["// #region orphan"];
      for (let i = 0; i < 6000; i++) lines.push(`const x${i} = ${i};`);
      const doc = lines.join("\n");
      const state = makeState("typescript", doc);

      const start = Date.now();
      const range = foldableOfFirstLine(state);
      const elapsed = Date.now() - start;

      expect(range).toBeNull();
      expect(elapsed).toBeLessThan(200); // generous bound — should be < 50ms in practice
    });

    test("endregion at exactly +5000 lines (the boundary) still matches", () => {
      // line 1: # region. Lines 2..5000: filler. Line 5001: # endregion.
      // Distance from line 1 to line 5001 = 5000 -> maxLine = min(N, 1+5000) = 5001
      // -> loop runs for lineNum in [2, 5001] -> matches at 5001.
      const lines = ["// #region exact"];
      for (let i = 0; i < 4999; i++) lines.push(`const x${i} = ${i};`);
      lines.push("// #endregion");
      const doc = lines.join("\n");
      const state = makeState("typescript", doc);
      const range = foldableOfFirstLine(state);
      expect(range).not.toBeNull();
    });

    test("endregion JUST past +5000 lines is NOT found (by design)", () => {
      // Distance 5001: the bound truncates the scan one line too early.
      // Acceptable trade-off — real regions never approach 5000 lines.
      const lines = ["// #region just-past"];
      for (let i = 0; i < 5000; i++) lines.push(`const x${i} = ${i};`);
      lines.push("// #endregion");
      const doc = lines.join("\n");
      const state = makeState("typescript", doc);
      expect(foldableOfFirstLine(state)).toBeNull();
    });
  });
});
