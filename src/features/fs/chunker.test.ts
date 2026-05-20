import { describe, it, expect } from "vitest";
import { chunkSource, chunkId, parseChunkId } from "./chunker";

describe("chunkSource", () => {
  it("empty / whitespace → []", () => {
    expect(chunkSource("")).toEqual([]);
    expect(chunkSource("   \n  \n")).toEqual([]);
  });

  it("small boundary-less file → single chunk", () => {
    const r = chunkSource("line1\nline2\nline3");
    expect(r).toHaveLength(1);
    expect(r[0]).toEqual({ text: "line1\nline2\nline3", startLine: 1, endLine: 3 });
  });

  it("splits at a top-level function boundary once the chunk reaches MIN size", () => {
    const src = [
      "function a() {", //  1
      "  return 1;", //     2
      "}", //              3
      "// filler", //      4
      "// filler", //      5
      "// filler", //      6
      "function b() {", // 7 ← boundary, chunk so far = 6 lines ≥ MIN
      "  return 2;", //    8
      "}", //              9
    ].join("\n");
    const r = chunkSource(src);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ startLine: 1, endLine: 6 });
    expect(r[1]).toMatchObject({ startLine: 7, endLine: 9 });
    expect(r[1].text).toContain("function b()");
  });

  it("does NOT split tiny consecutive declarations below MIN size", () => {
    const src = ["const a = 1;", "const b = 2;", "const c = 3;"].join("\n");
    expect(chunkSource(src)).toHaveLength(1);
  });

  it("enforces the hard MAX_CHUNK_LINES cap on boundary-less text", () => {
    const src = Array.from({ length: 400 }, (_, i) => `data line ${i}`).join("\n");
    const r = chunkSource(src);
    expect(r.length).toBeGreaterThanOrEqual(3);
    for (const c of r) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(160);
    }
  });

  it("produces contiguous, non-overlapping chunks covering all lines", () => {
    const src = [
      "function a() {", "  x", "}", "f", "f", "f",
      "function b() {", "  y", "}",
    ].join("\n");
    const r = chunkSource(src);
    for (let i = 1; i < r.length; i++) {
      expect(r[i].startLine).toBe(r[i - 1].endLine + 1);
    }
    expect(r[0].startLine).toBe(1);
    expect(r[r.length - 1].endLine).toBe(9);
  });

  it("normalizes CRLF to LF in chunk text", () => {
    const r = chunkSource("a\r\nb\r\nc");
    expect(r).toHaveLength(1);
    expect(r[0].text).toBe("a\nb\nc");
  });

  it("detects Python and Rust boundaries too", () => {
    const py = ["def a():", "  pass", "  pass", "  pass", "  pass", "  pass", "def b():", "  pass"].join("\n");
    expect(chunkSource(py).length).toBe(2);
    const rs = ["fn a() {", "  1", "  1", "  1", "  1", "  1", "fn b() {", "  2", "}"].join("\n");
    expect(chunkSource(rs).length).toBe(2);
  });
});

describe("chunkId", () => {
  it("encodes path + 1-indexed line range", () => {
    expect(chunkId("src/foo.ts", { text: "x", startLine: 7, endLine: 12 })).toBe(
      "src/foo.ts#L7-12",
    );
  });
});

describe("parseChunkId", () => {
  it("round-trips with chunkId", () => {
    const id = chunkId("src/a/b.ts", { text: "x", startLine: 3, endLine: 40 });
    expect(parseChunkId(id)).toEqual({ path: "src/a/b.ts", startLine: 3, endLine: 40 });
  });

  it("returns null for a malformed id", () => {
    expect(parseChunkId("src/foo.ts")).toBeNull();
    expect(parseChunkId("garbage")).toBeNull();
  });

  it("keeps a path that itself contains a hash-like fragment", () => {
    // Greedy prefix anchors on the final #L<n>-<n> suffix.
    expect(parseChunkId("a#b/c.ts#L1-2")).toEqual({ path: "a#b/c.ts", startLine: 1, endLine: 2 });
  });
});
