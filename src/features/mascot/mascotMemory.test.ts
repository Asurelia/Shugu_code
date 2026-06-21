import { describe, it, expect } from "vitest";
import { normalizeCategory, coerceFactInput } from "./mascotMemory";

describe("normalizeCategory", () => {
  it("garde une catégorie connue", () => {
    expect(normalizeCategory("tech")).toBe("tech");
  });
  it("retombe sur general si inconnue/absente", () => {
    expect(normalizeCategory("zzz")).toBe("general");
    expect(normalizeCategory(undefined)).toBe("general");
    expect(normalizeCategory(null)).toBe("general");
  });
});

describe("coerceFactInput", () => {
  it("rejette une clé vide", () => {
    expect(coerceFactInput({ key: "  ", value: "x" }).ok).toBe(false);
  });
  it("rejette une valeur vide", () => {
    expect(coerceFactInput({ key: "x", value: "" }).ok).toBe(false);
  });
  it("trim + normalise une entrée valide", () => {
    expect(coerceFactInput({ category: "relation", key: " ton ", value: " taquin " }))
      .toEqual({ ok: true, value: { category: "relation", key: "ton", value: "taquin" } });
  });
  it("rabat une catégorie inconnue sur general", () => {
    const r = coerceFactInput({ category: "xxx", key: "a", value: "b" });
    expect(r.ok && r.value.category).toBe("general");
  });
});
