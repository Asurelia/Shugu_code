import { describe, it, expect } from "vitest";
import { parseAiReply, detectBlockPath, stripPathComment } from "./markdown";

describe("parseAiReply — fences + lang", () => {
  it("returns empty for empty / non-string input", () => {
    expect(parseAiReply("")).toEqual({ prose: "", codeBlocks: [] });
    expect(parseAiReply(null as unknown as string)).toEqual({ prose: "", codeBlocks: [] });
  });

  it("extracts a simple fenced block + surrounding prose", () => {
    const r = parseAiReply("Here:\n```ts\nconst a = 1;\n```\nDone.");
    expect(r.codeBlocks).toHaveLength(1);
    expect(r.codeBlocks[0].lang).toBe("ts");
    expect(r.codeBlocks[0].text).toBe("const a = 1;");
    expect(r.codeBlocks[0].path).toBeUndefined();
    // Extraction leaves the blank line between the two prose segments; only
    // runs of 3+ newlines are collapsed (to 2), so "\n\n" survives.
    expect(r.prose).toBe("Here:\n\nDone.");
  });

  it("defaults lang to 'text' when the fence has no info-string", () => {
    const r = parseAiReply("```\nplain\n```");
    expect(r.codeBlocks[0].lang).toBe("text");
  });

  it("lowercases the lang id", () => {
    expect(parseAiReply("```TS\nx\n```").codeBlocks[0].lang).toBe("ts");
  });

  it("extracts multiple blocks in order", () => {
    const r = parseAiReply("```js\na\n```\nmid\n```py\nb\n```");
    expect(r.codeBlocks.map((b) => b.lang)).toEqual(["js", "py"]);
    expect(r.codeBlocks.map((b) => b.text)).toEqual(["a", "b"]);
    expect(r.prose).toBe("mid");
  });

  it("preserves leading indentation inside a block", () => {
    const r = parseAiReply("```py\n    indented = True\n```");
    expect(r.codeBlocks[0].text).toBe("    indented = True");
  });
});

describe("parseAiReply — FENCE_RE info-string fix (regression)", () => {
  // The old `[a-z0-9+_#-]*` info pattern silently DROPPED any fence whose
  // info-string carried a path/attribute (the block never matched).
  it("matches a block whose info-string carries a path", () => {
    const r = parseAiReply("```ts src/foo.ts\nconst a = 1;\n```");
    expect(r.codeBlocks).toHaveLength(1);
    expect(r.codeBlocks[0].lang).toBe("ts");
    expect(r.codeBlocks[0].text).toBe("const a = 1;");
    expect(r.codeBlocks[0].path).toBe("src/foo.ts");
  });

  it("matches a block whose info-string carries attributes (no false path)", () => {
    const r = parseAiReply('```js title="demo.js"\nx\n```');
    expect(r.codeBlocks).toHaveLength(1);
    expect(r.codeBlocks[0].lang).toBe("js");
    expect(r.codeBlocks[0].path).toBeUndefined();
  });

  it("treats a path-only info-string as lang 'text' + path", () => {
    const r = parseAiReply("```src/foo.ts\nx\n```");
    expect(r.codeBlocks[0].lang).toBe("text");
    expect(r.codeBlocks[0].path).toBe("src/foo.ts");
  });
});

describe("detectBlockPath — keyword comments", () => {
  it.each([
    ["// path: src/foo.ts", "src/foo.ts"],
    ["// filepath: src/foo.ts", "src/foo.ts"],
    ["// file: a/b.tsx", "a/b.tsx"],
    ["# path: scripts/run.py", "scripts/run.py"],
    ["# filepath: scripts/run.py", "scripts/run.py"],
    ["-- path: db/schema.sql", "db/schema.sql"],
    ["<!-- path: public/index.html -->", "public/index.html"],
    ["/* path: styles/main.css */", "styles/main.css"],
    ["// PATH: SRC/Foo.ts", "SRC/Foo.ts"],
    ["//path:src/x.ts", "src/x.ts"],
  ])("detects %s", (line, expected) => {
    expect(detectBlockPath(`${line}\ncode here`)).toBe(expected);
  });
});

describe("detectBlockPath — bare path comments", () => {
  it.each([
    ["// src/bare/path.ts", "src/bare/path.ts"],
    ["# scripts/deploy.sh", "scripts/deploy.sh"],
    ["// foo.ts", "foo.ts"],
  ])("detects %s", (line, expected) => {
    expect(detectBlockPath(`${line}\ncode`)).toBe(expected);
  });
});

describe("detectBlockPath — false positives rejected", () => {
  it.each([
    "// TODO: refactor this",
    "// just a normal comment",
    "// utils",
    "# coding: utf-8",
    "#!/usr/bin/env python",
    "// https://example.com/foo.ts",
    "const x = 1; // path: not-a-real-header.ts",
    "no comment marker at all foo.ts",
  ])("rejects %s", (line) => {
    expect(detectBlockPath(`${line}\ncode`)).toBeUndefined();
  });

  it("only inspects the FIRST line", () => {
    expect(detectBlockPath("code\n// path: src/foo.ts")).toBeUndefined();
  });
});

describe("detectBlockPath — normalisation", () => {
  it("strips surrounding quotes", () => {
    expect(detectBlockPath('// path: "src/foo.ts"')).toBe("src/foo.ts");
    expect(detectBlockPath("// path: `src/foo.ts`")).toBe("src/foo.ts");
  });
  it("drops a leading ./", () => {
    expect(detectBlockPath("// path: ./src/foo.ts")).toBe("src/foo.ts");
  });
  it("converts backslashes to forward slashes", () => {
    expect(detectBlockPath("// path: src\\win\\foo.ts")).toBe("src/win/foo.ts");
  });
});

describe("stripPathComment", () => {
  it("strips the keyword comment line + one trailing blank line", () => {
    expect(stripPathComment("// path: src/foo.ts\n\nconst a = 1;")).toBe("const a = 1;");
  });
  it("strips a bare path comment line", () => {
    expect(stripPathComment("// src/foo.ts\nconst a = 1;")).toBe("const a = 1;");
  });
  it("is a no-op when the first line is not a path declaration", () => {
    expect(stripPathComment("const a = 1;\nconst b = 2;")).toBe("const a = 1;\nconst b = 2;");
  });
  it("keeps subsequent content intact (only one blank line removed)", () => {
    expect(stripPathComment("// path: x.ts\n\n\nbody")).toBe("\nbody");
  });
});

describe("parseAiReply — path detection end-to-end", () => {
  it("detects a comment path and KEEPS the comment in text (reload-safe)", () => {
    const r = parseAiReply("```ts\n// path: src/foo.ts\nconst a = 1;\n```");
    expect(r.codeBlocks[0].path).toBe("src/foo.ts");
    // The comment stays in text so the path is re-detectable after the
    // message round-trips through SQLite (which only persists lang+text).
    expect(r.codeBlocks[0].text).toBe("// path: src/foo.ts\nconst a = 1;");
    // …and is removed only at apply time:
    expect(stripPathComment(r.codeBlocks[0].text)).toBe("const a = 1;");
  });

  it("prefers an info-string path over a comment", () => {
    const r = parseAiReply("```ts src/info.ts\n// path: src/comment.ts\nx\n```");
    expect(r.codeBlocks[0].path).toBe("src/info.ts");
  });
});
