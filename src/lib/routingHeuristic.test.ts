// Tests unitaires pour routingHeuristic — routeur de délégation (cockpit/mascotte).
// Exécuter : vitest run src/lib/routingHeuristic.test.ts
//
// NOTE : resolveModelTier + classifyComplexity ont été supprimés (ne gataient
// que l'advisor, désormais opt-in) — leurs tests aussi.
import { describe, it, expect } from "vitest";
import { resolveRoute, parseDelegateOverride } from "./routingHeuristic";

// ────────────────────────────────────────────────────────────────────
// resolveRoute — régression (fonctions existantes non cassées)
// ────────────────────────────────────────────────────────────────────
describe("resolveRoute — existing behavior unchanged", () => {
  it('always-delegate override → delegate', () => {
    expect(resolveRoute("merci !", "always-delegate")).toBe("delegate");
  });

  it('never-delegate override → no delegate', () => {
    const r = resolveRoute("crée un agent de test", "never-delegate");
    expect(r).not.toBe("delegate");
  });

  it('casual message → chat-direct (no override)', () => {
    expect(resolveRoute("merci !")).toBe("chat-direct");
  });

  it('delegate-pattern message → delegate (no override)', () => {
    expect(resolveRoute("crée un agent qui fait X")).toBe("delegate");
  });

  // ── Builds de produit haut-niveau « depuis zéro » → delegate (le bug signalé)
  it('crée un jeu vidéo depuis zéro → delegate', () => {
    expect(resolveRoute("crée un jeu vidéo depuis zéro")).toBe("delegate");
  });
  it('build me a todo app → delegate', () => {
    expect(resolveRoute("build me a todo app")).toBe("delegate");
  });
  it('fais un site portfolio → delegate', () => {
    expect(resolveRoute("fais un site portfolio")).toBe("delegate");
  });
  it('develop a CLI tool → delegate', () => {
    expect(resolveRoute("develop a small CLI tool for me")).toBe("delegate");
  });
  it('code-moi un clone de Tetris → delegate', () => {
    expect(resolveRoute("code-moi un clone de Tetris")).toBe("delegate");
  });
  it('génère une application de gestion → delegate', () => {
    expect(resolveRoute("génère une application de gestion de stock")).toBe("delegate");
  });

  // ── Anti-faux-positifs (confirmés par revue adverse) ───────────────────────
  // 1. NOM sans verbe build
  it('question sur un jeu (pas de verbe build) → pas delegate', () => {
    expect(resolveRoute("quel est ton jeu vidéo préféré ?")).not.toBe("delegate");
  });
  it('parler d\'une app sans verbe build → pas delegate', () => {
    expect(resolveRoute("c'est quoi la meilleure app de notes ?")).not.toBe("delegate");
  });
  // 2. Partitif « des/les » après le verbe (pas un déterminant de création)
  it('« j\'adore coder des jeux » → pas delegate (partitif)', () => {
    expect(resolveRoute("j'adore coder des jeux")).not.toBe("delegate");
  });
  it('« tu sais coder des jeux ? » → pas delegate', () => {
    expect(resolveRoute("tu sais coder des jeux ?")).not.toBe("delegate");
  });
  // 3. Collocations idiomatiques make/fais (pas de déterminant juste après)
  it('« make sure the app works » → pas delegate', () => {
    expect(resolveRoute("make sure the app works")).not.toBe("delegate");
  });
  it('« fais comme tu veux avec ce projet » → pas delegate', () => {
    expect(resolveRoute("fais comme tu veux avec ce projet")).not.toBe("delegate");
  });
  it('« fais attention au projet » → pas delegate', () => {
    expect(resolveRoute("fais attention au projet")).not.toBe("delegate");
  });
  // 4. Aspiration / musing / question (garde NON_COMMAND)
  it('« créer un jeu c\'est compliqué non ? » → pas delegate', () => {
    expect(resolveRoute("créer un jeu c'est compliqué non ?")).not.toBe("delegate");
  });
  it('« je voudrais créer une app un jour » → pas delegate (un jour)', () => {
    expect(resolveRoute("je voudrais créer une app un jour")).not.toBe("delegate");
  });
  it('« je rêve de développer mon propre jeu » → pas delegate', () => {
    expect(resolveRoute("je rêve de développer mon propre jeu")).not.toBe("delegate");
  });
  it('« comment créer un jeu vidéo ? » → pas delegate (question how-to)', () => {
    expect(resolveRoute("comment créer un jeu vidéo ?")).not.toBe("delegate");
  });
  // 5. Mais une demande POLIE reste une commande → delegate
  it('« peux-tu me coder un clone de Tetris ? » → delegate (commande polie)', () => {
    expect(resolveRoute("peux-tu me coder un clone de Tetris ?")).toBe("delegate");
  });
});

// ────────────────────────────────────────────────────────────────────
// parseDelegateOverride — régression
// ────────────────────────────────────────────────────────────────────
describe("parseDelegateOverride", () => {
  it('"always-delegate" → always-delegate', () => {
    expect(parseDelegateOverride("always-delegate")).toBe("always-delegate");
  });

  it('"never-delegate" → never-delegate', () => {
    expect(parseDelegateOverride("never-delegate")).toBe("never-delegate");
  });

  it('null → undefined', () => {
    expect(parseDelegateOverride(null)).toBeUndefined();
  });

  it('unknown string → undefined', () => {
    expect(parseDelegateOverride("something-else")).toBeUndefined();
  });
});
