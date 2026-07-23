import { describe, expect, it } from "vitest";
import { getContrastingTextColor } from "./colors";

describe("getContrastingTextColor", () => {
  it("uses white on dark provider colors", () => {
    expect(getContrastingTextColor("#000")).toBe("#fff");
    expect(getContrastingTextColor("#7c3aed")).toBe("#fff");
  });

  it("uses black on bright provider colors", () => {
    expect(getContrastingTextColor("#10a37f")).toBe("#000");
    expect(getContrastingTextColor("#ff4d4f")).toBe("#000");
    expect(getContrastingTextColor("#fff")).toBe("#000");
  });

  it("fails safely for a non-hex custom value", () => {
    expect(getContrastingTextColor("var(--brand)")).toBe("#fff");
  });
});
