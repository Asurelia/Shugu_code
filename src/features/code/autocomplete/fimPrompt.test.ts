import { describe, it, expect } from "vitest";
import { detectFimFamily, buildFimPrompt, fimWindow, buildFimRequest } from "./fimPrompt";

describe("detectFimFamily", () => {
  it.each([
    ["qwen2.5-coder-7b", "qwen"],
    ["Qwen2.5-Coder", "qwen"],
    ["deepseek-coder-v2", "deepseek"],
    ["codellama-13b", "codellama"],
    ["code-llama-7b", "codellama"],
    ["starcoder2-15b", "starcoder"],
    ["santacoder", "starcoder"],
    ["gpt-4o", "generic"],
    ["", "generic"],
  ] as const)("%s → %s", (model, fam) => {
    expect(detectFimFamily(model)).toBe(fam);
  });
});

describe("buildFimPrompt", () => {
  const parts = { prefix: "const x = ", suffix: ";\n" };

  it("qwen + deepseek share the <|fim_*|> sentinels", () => {
    const expected = "<|fim_prefix|>const x = <|fim_suffix|>;\n<|fim_middle|>";
    expect(buildFimPrompt(parts, "qwen")).toBe(expected);
    expect(buildFimPrompt(parts, "deepseek")).toBe(expected);
  });

  it("codellama uses <PRE>/<SUF>/<MID>", () => {
    expect(buildFimPrompt(parts, "codellama")).toBe("<PRE> const x =  <SUF>;\n <MID>");
  });

  it("starcoder uses <fim_*>", () => {
    expect(buildFimPrompt(parts, "starcoder")).toBe("<fim_prefix>const x = <fim_suffix>;\n<fim_middle>");
  });

  it("generic falls back to prefix only", () => {
    expect(buildFimPrompt(parts, "generic")).toBe("const x = ");
  });
});

describe("fimWindow", () => {
  const doc = "0123456789ABCDEF";

  it("slices prefix/suffix around the cursor", () => {
    expect(fimWindow(doc, 10)).toEqual({ prefix: "0123456789", suffix: "ABCDEF" });
  });

  it("caps both windows", () => {
    expect(fimWindow(doc, 10, 4, 3)).toEqual({ prefix: "6789", suffix: "ABC" });
  });

  it("clamps an out-of-range cursor", () => {
    expect(fimWindow(doc, 999)).toEqual({ prefix: doc, suffix: "" });
    expect(fimWindow(doc, -5)).toEqual({ prefix: "", suffix: doc });
  });
});

describe("buildFimRequest", () => {
  // « const x = |42; » (curseur après « = »).
  const doc = "const x = 42;";
  const cursor = 10; // juste après "const x = "

  it("ollama : prefix + suffix BRUTS (ollama template côté serveur)", () => {
    const r = buildFimRequest(doc, cursor, "ollama", "qwen2.5-coder");
    expect(r).toEqual({ prompt: "const x = ", suffix: "42;" });
  });

  it("openai : prompt sentinel-encodé, suffix OMIS (ignoré côté serveur)", () => {
    const r = buildFimRequest(doc, cursor, "openai", "qwen2.5-coder");
    expect(r.prompt).toBe("<|fim_prefix|>const x = <|fim_suffix|>42;<|fim_middle|>");
    expect(r.suffix).toBeUndefined();
  });

  it("custom : même encodage que openai (selon la famille du modèle)", () => {
    const r = buildFimRequest(doc, cursor, "custom", "codellama-13b");
    expect(r.prompt).toBe("<PRE> const x =  <SUF>42; <MID>");
    expect(r.suffix).toBeUndefined();
  });
});
