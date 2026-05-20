import { describe, it, expect } from "vitest";
import { parseMentions, buildMentionContext } from "./mentions";

describe("parseMentions", () => {
  it("empty / non-string → []", () => {
    expect(parseMentions("")).toEqual([]);
    expect(parseMentions(null as unknown as string)).toEqual([]);
  });

  it("extracts a single path mention", () => {
    expect(parseMentions("explain @src/foo.ts please")).toEqual(["src/foo.ts"]);
  });

  it("extracts multiple mentions in order", () => {
    expect(parseMentions("@a.ts and @b/c.tsx")).toEqual(["a.ts", "b/c.tsx"]);
  });

  it("dedupes repeated mentions", () => {
    expect(parseMentions("@a.ts then @a.ts again")).toEqual(["a.ts"]);
  });

  it("supports quoted paths with spaces", () => {
    expect(parseMentions('see @"my dir/a b.ts"')).toEqual(["my dir/a b.ts"]);
  });

  it("ignores social mentions without a path shape", () => {
    expect(parseMentions("@bob hello @team")).toEqual([]);
  });

  it("strips trailing punctuation around a mention", () => {
    expect(parseMentions("look at @a.ts.")).toEqual(["a.ts"]);
    expect(parseMentions("(@b/c.ts)")).toEqual(["b/c.ts"]);
  });

  it("normalizes backslashes and a leading ./", () => {
    expect(parseMentions("@./src\\foo.ts")).toEqual(["src/foo.ts"]);
  });

  it("accepts a directory path (slash, no extension)", () => {
    expect(parseMentions("@src/features/")).toEqual(["src/features/"]);
  });
});

describe("buildMentionContext", () => {
  it("empty → ''", () => {
    expect(buildMentionContext([])).toBe("");
  });

  it("wraps file content in a fenced block keyed by @path", () => {
    const ctx = buildMentionContext([{ path: "a.ts", content: "const x = 1;" }]);
    expect(ctx).toContain("### @a.ts");
    expect(ctx).toContain("const x = 1;");
    expect(ctx).toContain("```");
  });

  it("renders unreadable files as an error note", () => {
    const ctx = buildMentionContext([{ path: "x.ts", content: "", error: "ENOENT" }]);
    expect(ctx).toContain("impossible de lire");
    expect(ctx).toContain("ENOENT");
  });

  it("includes every resolved file", () => {
    const ctx = buildMentionContext([
      { path: "a.ts", content: "A" },
      { path: "b.ts", content: "B" },
    ]);
    expect(ctx).toContain("### @a.ts");
    expect(ctx).toContain("### @b.ts");
  });
});
