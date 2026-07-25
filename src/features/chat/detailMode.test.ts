import { describe, it, expect } from "vitest";
import {
  parseDetailMode,
  showToolTimeline,
  expandToolDetails,
  showReasoning,
  expandReasoning,
  presentActivity,
  DEFAULT_DETAIL_MODE,
  type DetailMode,
} from "./detailMode";
import type { AgentActivityItem } from "./useMessageDisplay";

const MODES: DetailMode[] = ["recit", "etapes", "execution"];

describe("parseDetailMode", () => {
  it("défaut Étapes quand la clé est absente ou invalide", () => {
    expect(parseDetailMode(undefined)).toBe(DEFAULT_DETAIL_MODE);
    expect(parseDetailMode(null)).toBe(DEFAULT_DETAIL_MODE);
    expect(parseDetailMode("")).toBe(DEFAULT_DETAIL_MODE);
    expect(parseDetailMode("tout")).toBe(DEFAULT_DETAIL_MODE);
    expect(DEFAULT_DETAIL_MODE).toBe("etapes");
  });

  it("accepte les trois modes persistés", () => {
    for (const m of MODES) expect(parseDetailMode(m)).toBe(m);
  });
});

describe("gates de présentation", () => {
  it("Récit masque timeline + reasoning, ne déplie rien", () => {
    expect(showToolTimeline("recit")).toBe(false);
    expect(showReasoning("recit")).toBe(false);
    expect(expandToolDetails("recit")).toBe(false);
    expect(expandReasoning("recit")).toBe(false);
  });

  it("Étapes = rendu actuel : timeline visible, rien de déplié", () => {
    expect(showToolTimeline("etapes")).toBe(true);
    expect(showReasoning("etapes")).toBe(true);
    expect(expandToolDetails("etapes")).toBe(false);
    expect(expandReasoning("etapes")).toBe(false);
  });

  it("Exécution : tout visible ET tout déplié", () => {
    expect(showToolTimeline("execution")).toBe(true);
    expect(expandToolDetails("execution")).toBe(true);
    expect(expandReasoning("execution")).toBe(true);
  });
});

describe("presentActivity — filtré ≠ supprimé (zéro perte de données)", () => {
  const items: AgentActivityItem[] = [
    { key: "c1", icon: "📖", label: "lit", detail: "a.ts", status: "ok" },
    { key: "c2", icon: "⚙️", label: "exécute", detail: "pnpm test", status: "error", result: "[exit 1]" },
    { key: "c3", icon: "✍️", label: "écrit", detail: "b.ts", status: "running" },
  ];

  it("Étapes et Exécution renvoient la MÊME référence (aucune copie)", () => {
    expect(presentActivity(items, "etapes")).toBe(items);
    expect(presentActivity(items, "execution")).toBe(items);
  });

  it("Récit cache la timeline mais la liste source est INTACTE", () => {
    const presented = presentActivity(items, "recit");
    expect(presented).toEqual([]);
    expect(items).toHaveLength(3);
    expect(items[2].status).toBe("running");
  });

  it("undefined reste une liste vide dans tous les modes", () => {
    for (const m of MODES) expect(presentActivity(undefined, m)).toEqual([]);
  });
});
