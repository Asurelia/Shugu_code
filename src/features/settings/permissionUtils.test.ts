import { describe, it, expect } from "vitest";
import {
  decisionLabel,
  buildTestArgs,
  describeEvaluation,
  scopeLabel,
  permissionAnswerText,
} from "./permissionUtils";

describe("decisionLabel", () => {
  it("trois décisions traduites", () => {
    expect(decisionLabel("allow")).toBe("Autoriser");
    expect(decisionLabel("ask")).toBe("Demander");
    expect(decisionLabel("deny")).toBe("Refuser");
  });
});

describe("buildTestArgs", () => {
  it("mapping identique au dispatch (command / url / path)", () => {
    expect(buildTestArgs("run_command", "git push")).toEqual({ command: "git push" });
    expect(buildTestArgs("web_fetch", "https://x.io")).toEqual({ url: "https://x.io" });
    expect(buildTestArgs("fs_write_file", "src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(buildTestArgs("fs_edit", "b.md")).toEqual({ path: "b.md" });
  });
});

describe("describeEvaluation", () => {
  it("noRule dit honnêtement le fallback statique", () => {
    expect(
      describeEvaluation({ outcome: "noRule", matchedPattern: null, reason: "aucune" }),
    ).toContain("classifieur statique");
  });

  it("décision + motif + raison", () => {
    expect(
      describeEvaluation({
        outcome: "deny",
        matchedPattern: "git push *",
        reason: "refusé par la règle",
      }),
    ).toBe("Refuser — règle « git push * » (refusé par la règle)");
    expect(
      describeEvaluation({ outcome: "ask", matchedPattern: "cargo *", reason: null }),
    ).toBe("Demander — règle « cargo * »");
  });
});

describe("scopeLabel", () => {
  it("global / projet courant / autre chemin", () => {
    expect(scopeLabel("", "C:/proj")).toBe("global");
    expect(scopeLabel("C:/proj", "C:/proj")).toBe("projet");
    expect(scopeLabel("C:/autre", "C:/proj")).toBe("C:/autre");
    expect(scopeLabel("C:/proj", null)).toBe("C:/proj");
  });
});

describe("permissionAnswerText (contrat backend)", () => {
  it("préfixes AUTORISÉ / REFUSÉ lus par answered_permission_on_conn", () => {
    expect(permissionAnswerText(true, "run_command", "git push")).toMatch(/^AUTORISÉ/);
    expect(permissionAnswerText(false, "run_command", "git push")).toMatch(/^REFUSÉ/);
    expect(permissionAnswerText(true, "run_command", "git push")).toContain("git push");
    expect(permissionAnswerText(true, "run_command", "git push")).toContain("run_command");
    expect(permissionAnswerText(false, "run_command", "git push")).toContain("git push");
  });
});
