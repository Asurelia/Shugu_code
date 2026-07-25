import { describe, it, expect } from "vitest";
import {
  aggregateTokenUsage,
  totalTokens,
  formatTokens,
  contextFill,
  usageSourceLabel,
  latestContextUsage,
  compactionInfo,
  CONTEXT_WARN_FRACTION,
} from "./tokenUsage";
import type { AgentEvent } from "@/lib/agents";

const usage = (agentId: string, fields: Partial<{
  inputTokens: number; outputTokens: number;
  cacheCreationInputTokens: number; cacheReadInputTokens: number;
}>): AgentEvent => ({ kind: "tokenUsage", agentId, ...fields });

describe("aggregateTokenUsage", () => {
  it("somme champ par champ, Option-aware (jamais de zéros fabriqués)", () => {
    const agg = aggregateTokenUsage([
      usage("a", { inputTokens: 100, outputTokens: 10 }),
      usage("a", { inputTokens: 50 }), // pas de output ce tour
      usage("a", { cacheCreationInputTokens: 20, cacheReadInputTokens: 30 }),
    ]);
    expect(agg).toEqual({
      input: 150,
      output: 10,
      cacheCreation: 20,
      cacheRead: 30,
      turns: 3,
    });
  });

  it("un provider sans usage ne produit AUCUN champ (undefined, pas 0)", () => {
    const agg = aggregateTokenUsage([]);
    expect(agg.turns).toBe(0);
    expect(agg.input).toBeUndefined();
    expect(agg.output).toBeUndefined();
    expect(totalTokens(agg)).toBeUndefined();
  });

  it("total = entrée cache incluse + sortie", () => {
    const agg = aggregateTokenUsage([
      usage("a", { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 40 }),
    ]);
    expect(totalTokens(agg)).toBe(145);
  });
});

describe("formatTokens", () => {
  it("formate en FR compact", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12340)).toBe("12,3 k");
    expect(formatTokens(250_000)).toBe("250 k");
    expect(formatTokens(1_250_000)).toBe("1,25 M");
  });
});

describe("contextFill", () => {
  it("calcule le pourcentage et la zone d'alerte (75 % = budget compaction)", () => {
    expect(contextFill(50, 200)).toEqual({ pct: 25, warn: false, over: false });
    expect(contextFill(150, 200).warn).toBe(true);
    expect(CONTEXT_WARN_FRACTION).toBe(0.75);
  });

  it("borne la barre à 100 % mais signale le dépassement", () => {
    const f = contextFill(300, 200);
    expect(f.pct).toBe(100);
    expect(f.over).toBe(true);
  });

  it("fenêtre nulle = état neutre", () => {
    expect(contextFill(10, 0)).toEqual({ pct: 0, warn: false, over: false });
  });
});

describe("usageSourceLabel", () => {
  it("distingue honnêtement mesuré et estimé", () => {
    expect(usageSourceLabel("provider")).toBe("mesuré (provider)");
    expect(usageSourceLabel("estimate")).toBe("estimé");
  });
});

describe("latestContextUsage / compactionInfo", () => {
  const ctx = (used: number, source: "provider" | "estimate"): AgentEvent =>
    ({ kind: "contextWindowUsage", agentId: "a", used, window: 8000, source });

  it("le dernier event gagne", () => {
    expect(latestContextUsage([ctx(100, "estimate"), ctx(200, "provider")])).toEqual({
      used: 200, window: 8000, source: "provider",
    });
    expect(latestContextUsage([])).toBeNull();
  });

  it("compactionInfo agrège count + folded, null si jamais compacté", () => {
    const events: AgentEvent[] = [
      { kind: "memoryCompacted", agentId: "a", role: "orchestrator", folded: 12 },
      { kind: "memoryCompacted", agentId: "a", role: "orchestrator", folded: 8 },
    ];
    expect(compactionInfo(events)).toEqual({ count: 2, folded: 20 });
    expect(compactionInfo([])).toBeNull();
  });
});
