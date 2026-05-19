/**
 * format-diff.test.ts
 *
 * Tests for computeMinimalChanges. We apply the ChangeSpecs to verify
 * the result equals `formatted` — this tests both correctness and offset
 * arithmetic.
 *
 * Helper: apply ChangeSpec[] to a string (mirrors CodeMirror's apply logic).
 */

import { describe, it, expect } from "vitest";
import { Text, ChangeSet } from "@codemirror/state";
import { computeMinimalChanges } from "./format-diff";

/**
 * Apply a list of ChangeSpecs to a string and return the result.
 * This mirrors what CodeMirror does with view.dispatch({ changes }).
 */
function applyChanges(original: string, changes: ReturnType<typeof computeMinimalChanges>): string {
  if (changes.length === 0) return original;
  const doc = Text.of(original.split("\n"));
  const cs = ChangeSet.of(changes, doc.length);
  return cs.apply(doc).toString();
}

describe("computeMinimalChanges", () => {
  it("identical input returns empty array", () => {
    const src = "const x = 1;\nconst y = 2;\n";
    const doc = Text.of(src.split("\n"));
    const changes = computeMinimalChanges(doc, src);
    expect(changes).toEqual([]);
  });

  it("single whitespace fix mid-line", () => {
    const original = "const  x = 1;\nconst y = 2;\n";
    const formatted = "const x = 1;\nconst y = 2;\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(changes.length).toBeGreaterThan(0);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("trailing newline added by rustfmt (original has none)", () => {
    const original = "fn main() {}";
    const formatted = "fn main() {}\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("trailing newline removed (opposite direction)", () => {
    const original = "const x = 1;\n";
    const formatted = "const x = 1;";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("CRLF original → LF formatted (gofmt normalization)", () => {
    const original = "package main\r\n\r\nfunc main() {}\r\n";
    const formatted = "package main\n\nfunc main() {}\n";
    const doc = Text.of(original.split("\n"));
    // After LF split, the \r remain in the line content — changes must remove them
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("multi-line replace where line count shrinks (5→3)", () => {
    const original = "a\nb\nc\nd\ne\n";
    const formatted = "a\nb\ne\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("multi-line replace where line count grows (3→5)", () => {
    const original = "a\nb\ne\n";
    const formatted = "a\nb\nc\nd\ne\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("empty original → non-empty formatted (new file)", () => {
    const original = "";
    const formatted = "const x = 1;\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("prepend-only change", () => {
    const original = "const y = 2;\n";
    const formatted = "const x = 1;\nconst y = 2;\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("append-only change", () => {
    const original = "const x = 1;\n";
    const formatted = "const x = 1;\nconst y = 2;\n";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(applyChanges(original, changes)).toBe(formatted);
  });

  it("doc > 500000 chars falls back to single full-replace ChangeSpec", () => {
    const bigLine = "x".repeat(1000);
    const lines = Array.from({ length: 600 }, () => bigLine);
    const original = lines.join("\n");
    const formatted = original + "\n// extra";
    const doc = Text.of(original.split("\n"));
    const changes = computeMinimalChanges(doc, formatted);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: 0, to: doc.length, insert: formatted });
  });
});
