// Unit tests for parseVerdict — focused on the last-occurrence logic (FIX 1).
import { describe, it, expect } from "vitest";
import { parseVerdict } from "./supervisors";

describe("parseVerdict", () => {
  // Anti-regression: the FIRST occurrence must not win when the LAST differs.
  it("returns BLOQUÉ when text mentions approuv first then bloqu last", () => {
    expect(
      parseVerdict("Le plan ne doit pas être approuvé. Verdict : BLOQUÉ"),
    ).toBe("BLOQUÉ");
  });

  it("returns APPROUVÉ for a simple approval", () => {
    expect(parseVerdict("Tout est bon. APPROUVÉ")).toBe("APPROUVÉ");
  });

  it("returns À CORRIGER for a corriger verdict", () => {
    expect(parseVerdict("Verdict : À CORRIGER")).toBe("À CORRIGER");
  });

  it("returns unknown when no verdict token is present", () => {
    expect(parseVerdict("blabla sans verdict")).toBe("unknown");
  });

  // Extra robustness cases.
  it("returns the LAST verdict when multiple verdicts appear", () => {
    // BLOQUÉ then APPROUVÉ → APPROUVÉ wins
    expect(parseVerdict("Problème grave BLOQUÉ. Mais finalement APPROUVÉ.")).toBe(
      "APPROUVÉ",
    );
  });

  it("returns À CORRIGER when it appears after BLOQUÉ", () => {
    expect(parseVerdict("BLOQUÉ, non en fait À CORRIGER")).toBe("À CORRIGER");
  });

  it("is accent-insensitive (APPROUVE without accent)", () => {
    expect(parseVerdict("APPROUVE")).toBe("APPROUVÉ");
  });

  it("is case-insensitive", () => {
    expect(parseVerdict("approuvé")).toBe("APPROUVÉ");
    expect(parseVerdict("bloqué")).toBe("BLOQUÉ");
  });

  it("returns unknown for empty string", () => {
    expect(parseVerdict("")).toBe("unknown");
  });
});
