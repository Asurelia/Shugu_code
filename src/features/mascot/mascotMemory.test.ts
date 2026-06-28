import { describe, it, expect } from "vitest";
import { normalizeCategory, validateFactInput, normalizeFactInput } from "./mascotMemory";

describe("normalizeCategory", () => {
  it("garde une catégorie connue", () => {
    expect(normalizeCategory("tech")).toBe("tech");
    expect(normalizeCategory("relation")).toBe("relation");
  });
  it("retombe sur general si inconnue/absente", () => {
    expect(normalizeCategory("zzz")).toBe("general");
    expect(normalizeCategory(undefined)).toBe("general");
    expect(normalizeCategory(null)).toBe("general");
  });
});

describe("validateFactInput", () => {
  it("rejette une clé vide", () => {
    expect(validateFactInput({ key: "  ", value: "x" })).not.toBeNull();
  });
  it("rejette une valeur vide", () => {
    expect(validateFactInput({ key: "x", value: "" })).not.toBeNull();
  });
  it("rejette une clé trop longue", () => {
    expect(validateFactInput({ key: "k".repeat(81), value: "v" })).not.toBeNull();
  });
  it("accepte une entrée valide (retourne null)", () => {
    expect(validateFactInput({ key: "ton", value: "taquin" })).toBeNull();
  });
});

describe("normalizeFactInput", () => {
  it("trim + garde une catégorie connue", () => {
    expect(normalizeFactInput({ category: "relation", key: " ton ", value: " taquin " }))
      .toEqual({ category: "relation", key: "ton", value: "taquin" });
  });
  it("rabat une catégorie inconnue sur general", () => {
    expect(normalizeFactInput({ category: "xxx", key: "a", value: "b" }).category).toBe("general");
  });
});
