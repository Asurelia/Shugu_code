// src/features/chat/editorContext.test.ts
import { describe, it, expect } from "vitest";
import { buildEditorContext } from "./editorContext";

describe("buildEditorContext", () => {
  it("renvoie '' sans fichier actif", () => {
    expect(buildEditorContext({ path: "", content: "" })).toBe("");
  });

  it("inclut le chemin + contenu du fichier actif", () => {
    const out = buildEditorContext({ path: "src/a.ts", content: "const x = 1;" });
    expect(out).toContain("src/a.ts");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("Fichier ouvert");
  });

  it("inclut la sélection avec ses lignes quand présente", () => {
    const out = buildEditorContext({
      path: "src/a.ts",
      content: "a\nb\nc",
      selection: { text: "b", startLine: 2, endLine: 2 },
    });
    expect(out).toContain("Sélection");
    expect(out).toContain("L2");
    expect(out).toContain("b");
  });

  it("tronque un fichier au-delà du cap (24 KiB)", () => {
    const big = "x".repeat(30_000);
    const out = buildEditorContext({ path: "src/big.ts", content: big });
    expect(out).toContain("[tronqué]");
    expect(out.length).toBeLessThan(30_000 + 500);
  });

  it("omet le fichier actif s'il est dans skipPaths (déjà @-mentionné)", () => {
    const out = buildEditorContext(
      { path: "src/a.ts", content: "const x = 1;" },
      { skipPaths: ["src/a.ts"] },
    );
    expect(out).toBe("");
  });
});
