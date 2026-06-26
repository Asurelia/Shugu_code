// Phase 7 #2 — tests unitaires PURS du parsing d'id de hit sémantique.
// Aucun React / DOM : ce module est volontairement isolable.

import { describe, it, expect } from "vitest";
import { parseVecHit, buildResultLabel } from "./parseVecHit";

describe("parseVecHit", () => {
  it("parses a multi-line range id `path#L10-20`", () => {
    expect(parseVecHit("src/x.ts#L10-20")).toEqual({
      path: "src/x.ts",
      startLine: 10,
      endLine: 20,
    });
  });

  it("parses a single-line id `path#L10` (start === end)", () => {
    expect(parseVecHit("src/x.ts#L10")).toEqual({
      path: "src/x.ts",
      startLine: 10,
      endLine: 10,
    });
  });

  it("falls back gracefully on a malformed id (no #L marker)", () => {
    // Tout l'id est traité comme un chemin ; lignes par défaut = 1.
    expect(parseVecHit("not-a-real-id")).toEqual({
      path: "not-a-real-id",
      startLine: 1,
      endLine: 1,
    });
  });

  it("falls back to line 1 when the range suffix is non-numeric", () => {
    expect(parseVecHit("src/x.ts#Labc")).toEqual({
      path: "src/x.ts",
      startLine: 1,
      endLine: 1,
    });
  });

  it("falls back to line 1 when both range bounds are non-numeric", () => {
    expect(parseVecHit("src/x.ts#Lfoo-bar")).toEqual({
      path: "src/x.ts",
      startLine: 1,
      endLine: 1,
    });
  });

  it("keeps the path and uses the readable bound when one side is junk", () => {
    expect(parseVecHit("src/x.ts#L12-zz")).toEqual({
      path: "src/x.ts",
      startLine: 12,
      endLine: 12,
    });
  });

  it("normalises an inverted range so start <= end", () => {
    expect(parseVecHit("src/x.ts#L30-10")).toEqual({
      path: "src/x.ts",
      startLine: 10,
      endLine: 30,
    });
  });

  it("preserves a deeply nested path with extension", () => {
    expect(parseVecHit("src/features/code/SemanticSearchPalette.tsx#L1-5")).toEqual({
      path: "src/features/code/SemanticSearchPalette.tsx",
      startLine: 1,
      endLine: 5,
    });
  });

  it("treats an empty range (`path#L`) as line 1", () => {
    expect(parseVecHit("src/x.ts#L")).toEqual({
      path: "src/x.ts",
      startLine: 1,
      endLine: 1,
    });
  });
});

describe("buildResultLabel", () => {
  it("renders `#Lstart-end` for a multi-line chunk", () => {
    expect(buildResultLabel({ id: "src/x.ts#L10-20", distance: 0.1 })).toBe("#L10-20");
  });

  it("renders `#Lline` for a single-line chunk", () => {
    expect(buildResultLabel({ id: "src/x.ts#L42", distance: 0.2 })).toBe("#L42");
  });

  it("renders `#L1` for a malformed id (graceful fallback)", () => {
    expect(buildResultLabel({ id: "garbage", distance: 0.9 })).toBe("#L1");
  });
});
