import { describe, it, expect } from "vitest";
import { detectFimFamily, buildFimPrompt, fimWindow } from "./fimPrompt";

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
