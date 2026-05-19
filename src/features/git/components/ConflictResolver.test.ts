// Pure-function tests for ConflictResolver. We don't render the
// component itself here — those would need a ShellContext mock and
// a TanStack QueryClient. The parser + resolver are the bug-prone parts.

import { describe, it, expect } from "vitest";
import { parseConflicts, applyResolution } from "./ConflictResolver";

describe("parseConflicts", () => {
  it("returns [] when no markers", () => {
    expect(parseConflicts("hello\nworld\n")).toEqual([]);
  });

  it("parses one block", () => {
    const text =
      "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\nz\n";
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      startLine: 1,
      separatorLine: 3,
      endLine: 5,
      current: "ours",
      incoming: "theirs",
    });
  });

  it("parses multiple blocks", () => {
    const text = [
      "a",
      "<<<<<<< HEAD",
      "X1",
      "=======",
      "Y1",
      ">>>>>>> b",
      "b",
      "<<<<<<< HEAD",
      "X2",
      "=======",
      "Y2",
      ">>>>>>> b",
      "c",
    ].join("\n");
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].current).toBe("X1");
    expect(blocks[1].current).toBe("X2");
    expect(blocks[1].incoming).toBe("Y2");
  });

  it("handles CRLF line endings", () => {
    const text = "a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> b\r\nz\r\n";
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].current).toBe("ours");
    expect(blocks[0].incoming).toBe("theirs");
  });

  it("ignores stray separator without an open marker", () => {
    const text = "a\n=======\nb\n";
    expect(parseConflicts(text)).toEqual([]);
  });

  it("ignores unclosed conflict (no >>>>>>> line)", () => {
    const text = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n";
    expect(parseConflicts(text)).toEqual([]);
  });

  it("handles empty sides", () => {
    const text = "<<<<<<< HEAD\n=======\n>>>>>>> b\n";
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].current).toBe("");
    expect(blocks[0].incoming).toBe("");
  });
});

describe("applyResolution", () => {
  const text = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\nz\n";
  const block = parseConflicts(text)[0];

  it("accepts current (ours)", () => {
    const out = applyResolution(text, block, block.current);
    expect(out).toBe("a\nours\nz\n");
  });

  it("accepts incoming (theirs)", () => {
    const out = applyResolution(text, block, block.incoming);
    expect(out).toBe("a\ntheirs\nz\n");
  });

  it("accepts both", () => {
    const out = applyResolution(text, block, `${block.current}\n${block.incoming}`);
    expect(out).toBe("a\nours\ntheirs\nz\n");
  });

  it("supports empty resolution (drop the block entirely)", () => {
    const out = applyResolution(text, block, "");
    expect(out).toBe("a\nz\n");
  });
});
