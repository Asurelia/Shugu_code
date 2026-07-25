import { describe, it, expect } from "vitest";
import {
  toggleDisabledId,
  hookOutcomeLabel,
  hookOutcomeTone,
  hookEventLabel,
  hookSourceLabel,
  describeHookTest,
} from "./hooksUtils";

describe("toggleDisabledId", () => {
  it("ajoute une fois, retire proprement, sans muter l'entrée", () => {
    const start = ["a"];
    const added = toggleDisabledId(start, "b", true);
    expect(added).toEqual(["a", "b"]);
    expect(start).toEqual(["a"]);
    expect(toggleDisabledId(added, "b", true)).toEqual(["a", "b"]);
    expect(toggleDisabledId(added, "a", false)).toEqual(["b"]);
    expect(toggleDisabledId([], "x", false)).toEqual([]);
  });
});

describe("hookOutcomeLabel / hookOutcomeTone", () => {
  it("chaque outcome connu a un libellé honnête et une teinte", () => {
    expect(hookOutcomeLabel("block")).toBe("bloqué");
    expect(hookOutcomeTone("block")).toBe("danger");
    expect(hookOutcomeLabel("timeout")).toContain("fail-open");
    expect(hookOutcomeTone("timeout")).toBe("warn");
    expect(hookOutcomeLabel("context")).toBe("contexte injecté");
    expect(hookOutcomeTone("context")).toBe("success");
    expect(hookOutcomeLabel("block-ignored")).toContain("borne Stop");
    expect(hookOutcomeTone("error")).toBe("warn");
  });

  it("un outcome inconnu passe tel quel (pas d'invention)", () => {
    expect(hookOutcomeLabel("bizarre")).toBe("bizarre");
    expect(hookOutcomeTone("bizarre")).toBe("muted");
  });
});

describe("hookEventLabel / hookSourceLabel", () => {
  it("traduit les events connus, conserve les inconnus", () => {
    expect(hookEventLabel("PreToolUse")).toBe("avant outil");
    expect(hookEventLabel("Stop")).toBe("fin de run");
    expect(hookEventLabel("Custom")).toBe("Custom");
    expect(hookSourceLabel("project")).toBe("projet");
    expect(hookSourceLabel("user")).toBe("utilisateur");
  });
});

describe("describeHookTest", () => {
  it("résume outcome + exit + durée", () => {
    expect(describeHookTest({ outcome: "ok", exitCode: 0, durationMs: 42 })).toBe(
      "exécuté · exit 0 · 42 ms",
    );
    expect(describeHookTest({ outcome: "timeout", exitCode: 124, durationMs: 1000 })).toContain(
      "timeout (fail-open)",
    );
  });
});
