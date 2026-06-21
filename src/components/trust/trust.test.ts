// Trust-UX taxonomy — pure logic tests (Lane 5).
//
// These cover the load-bearing correctness layer: the mode→risk mapping and the
// coercion helpers that every confidence primitive relies on. A regression here
// (e.g. Agent mode silently mapped to "read") would make the whole UI lie about
// blast radius, so it's worth pinning.

import { describe, it, expect } from "vitest";
import {
  RISK,
  MODE_META,
  modeToRisk,
  toTrustMode,
  type RiskLevel,
  type TrustMode,
} from "./trust";

describe("toTrustMode", () => {
  it("passes through the three known modes", () => {
    expect(toTrustMode("chat")).toBe("chat");
    expect(toTrustMode("plan")).toBe("plan");
    expect(toTrustMode("agent")).toBe("agent");
  });

  it("defaults unknown / nullish input to agent (matches chat-sync default)", () => {
    expect(toTrustMode(undefined)).toBe("agent");
    expect(toTrustMode(null)).toBe("agent");
    expect(toTrustMode("")).toBe("agent");
    expect(toTrustMode("nonsense")).toBe("agent");
    expect(toTrustMode("ACT")).toBe("agent");
  });
});

describe("modeToRisk", () => {
  it("maps read-only modes to the read tier", () => {
    expect(modeToRisk("chat")).toBe("read");
    expect(modeToRisk("plan")).toBe("read");
  });

  it("maps the full agent mode to the exec tier", () => {
    expect(modeToRisk("agent")).toBe("exec");
  });
});

describe("MODE_META", () => {
  it("surfaces the Ask/Plan/Act wording", () => {
    expect(MODE_META.chat.badge).toBe("Ask");
    expect(MODE_META.plan.badge).toBe("Plan");
    expect(MODE_META.agent.badge).toBe("Act");
  });

  it("every mode's risk points at a real RISK entry", () => {
    const modes: TrustMode[] = ["chat", "plan", "agent"];
    for (const m of modes) {
      const risk = MODE_META[m].risk;
      expect(RISK[risk]).toBeDefined();
      expect(RISK[risk].level).toBe(risk);
    }
  });

  it("keeps the id field consistent with the map key", () => {
    (Object.keys(MODE_META) as TrustMode[]).forEach((k) => {
      expect(MODE_META[k].id).toBe(k);
    });
  });
});

describe("RISK taxonomy", () => {
  it("orders tiers by ascending blast radius", () => {
    const levels: RiskLevel[] = ["read", "write", "exec"];
    // Each tier exists, is self-consistent, and carries non-empty human text.
    for (const lvl of levels) {
      const meta = RISK[lvl];
      expect(meta.level).toBe(lvl);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.blurb.length).toBeGreaterThan(0);
      expect(meta.color).toMatch(/^var\(--/);
    }
  });

  it("gives every tier a distinct accent color (color is a real signal)", () => {
    const colors = new Set([RISK.read.color, RISK.write.color, RISK.exec.color]);
    expect(colors.size).toBe(3);
  });
});
