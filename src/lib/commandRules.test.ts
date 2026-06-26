// Phase 7 #3 — tests des helpers PURS des règles de commandes.

import { describe, it, expect } from "vitest";
import { parseRiskFlag, deriveCommandPattern } from "./commandRules";

describe("parseRiskFlag", () => {
  it("extrait reason + detail du préfixe [RISK: …] (1re ligne)", () => {
    // Format EXACT de tools.rs : « [RISK: <reason>] <detail>\n<sortie commande> ».
    const out = "[RISK: recursiveDelete] suppression récursive — irréversible\nrm: removed 12 files";
    expect(parseRiskFlag(out)).toEqual({
      reason: "recursiveDelete",
      detail: "suppression récursive — irréversible",
    });
  });

  it("retourne undefined sans marqueur", () => {
    expect(parseRiskFlag("[exit 0] ok\nbuild done")).toBeUndefined();
    expect(parseRiskFlag("rien de spécial")).toBeUndefined();
    expect(parseRiskFlag(undefined)).toBeUndefined();
    expect(parseRiskFlag("")).toBeUndefined();
  });

  it("tolère un detail vide", () => {
    expect(parseRiskFlag("[RISK: forcePush] \nremote updated")).toEqual({
      reason: "forcePush",
      detail: "",
    });
  });
});

describe("deriveCommandPattern", () => {
  it("premier token + ` *` quand il y a des arguments", () => {
    expect(deriveCommandPattern("git push origin main")).toBe("git *");
    expect(deriveCommandPattern("rm -rf node_modules")).toBe("rm *");
    expect(deriveCommandPattern("  cargo   test  ")).toBe("cargo *");
  });

  it("token seul quand pas d'argument", () => {
    expect(deriveCommandPattern("pnpm")).toBe("pnpm");
  });

  it("chaîne vide / indéfinie → motif vide (l'UI bloque l'enregistrement)", () => {
    expect(deriveCommandPattern("")).toBe("");
    expect(deriveCommandPattern(undefined)).toBe("");
    expect(deriveCommandPattern("   ")).toBe("");
  });
});
