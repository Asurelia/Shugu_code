import { describe, it, expect } from "vitest";
import {
  processStatusLabel,
  processStatusTone,
  sessionStatusLabel,
  formatTail,
} from "./processesUtils";

describe("processStatusLabel / processStatusTone", () => {
  it("statuts honnêtes (interrupted dit le suivi perdu)", () => {
    expect(processStatusLabel("running")).toBe("en cours");
    expect(processStatusLabel("exited")).toBe("terminé");
    expect(processStatusLabel("interrupted")).toContain("suivi perdu");
    expect(processStatusLabel("killed")).toBe("tué");
    expect(processStatusLabel("bizarre")).toBe("bizarre");
  });

  it("teintes cohérentes", () => {
    expect(processStatusTone("running")).toBe("success");
    expect(processStatusTone("interrupted")).toBe("warn");
    expect(processStatusTone("killed")).toBe("danger");
    expect(processStatusTone("exited")).toBe("muted");
  });
});

describe("sessionStatusLabel", () => {
  it("active / terminée", () => {
    expect(sessionStatusLabel(true)).toBe("active");
    expect(sessionStatusLabel(false)).toBe("terminée");
  });
});

describe("formatTail", () => {
  it("sortie vide → marqueur honnête", () => {
    expect(formatTail("")).toBe("(pas de sortie)");
    expect(formatTail("  \n ")).toBe("(pas de sortie)");
  });

  it("normalise les CRLF", () => {
    expect(formatTail("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("borne le nombre de lignes avec marqueur de troncature", () => {
    const many = Array.from({ length: 50 }, (_, i) => `ligne-${i}`).join("\n");
    const out = formatTail(many);
    expect(out).toContain("10 ligne(s) plus tôt masquée(s)");
    expect(out).toContain("ligne-49");
    expect(out).not.toContain("ligne-9\n");
  });

  it("borne la longueur des lignes", () => {
    const long = "x".repeat(500);
    const out = formatTail(long);
    expect(out.length).toBeLessThan(420);
    expect(out).toContain("…");
  });
});
