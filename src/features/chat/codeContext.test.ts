import { describe, it, expect } from "vitest";
import { buildCodeContext } from "./codeContext";

describe("buildCodeContext", () => {
  it("empty → ''", () => {
    expect(buildCodeContext([])).toBe("");
  });

  it("formats a chunk with path:lines header + fenced block", () => {
    const ctx = buildCodeContext([
      { path: "src/a.ts", startLine: 3, endLine: 9, text: "const x = 1;" },
    ]);
    expect(ctx).toContain("### src/a.ts:3-9");
    expect(ctx).toContain("const x = 1;");
    expect(ctx).toContain("```");
  });

  it("includes every chunk", () => {
    const ctx = buildCodeContext([
      { path: "a.ts", startLine: 1, endLine: 2, text: "A" },
      { path: "b.ts", startLine: 5, endLine: 6, text: "B" },
    ]);
    expect(ctx).toContain("### a.ts:1-2");
    expect(ctx).toContain("### b.ts:5-6");
  });
});
