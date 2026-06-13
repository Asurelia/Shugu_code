// Tests unitaires pour routingHeuristic — classifieur de complexité et tier modèle.
// Exécuter : vitest run src/lib/routingHeuristic.test.ts
import { describe, it, expect } from "vitest";
import {
  resolveModelTier,
  classifyComplexity,
  resolveRoute,
  parseDelegateOverride,
} from "./routingHeuristic";

// ────────────────────────────────────────────────────────────────────
// resolveModelTier
// ────────────────────────────────────────────────────────────────────
describe("resolveModelTier", () => {
  // Weak models
  it('gpt-4o-mini → weak (mini wins over gpt-4o)', () => {
    expect(resolveModelTier("openai/gpt-4o-mini")).toBe("weak");
  });

  it('llamacpp prefix → weak', () => {
    expect(resolveModelTier("llamacpp/whatever")).toBe("weak");
  });

  it('ollama prefix → weak', () => {
    expect(resolveModelTier("ollama/llama3:8b")).toBe("weak");
  });

  it('7b in model id → weak', () => {
    expect(resolveModelTier("mistral/mistral-7b")).toBe("weak");
  });

  it('haiku → weak', () => {
    expect(resolveModelTier("anthropic/claude-haiku-3")).toBe("weak");
  });

  it('unknown/xyz → weak (safe default)', () => {
    expect(resolveModelTier("inconnu/xyz")).toBe("weak");
  });

  it('empty string → weak (safe default)', () => {
    expect(resolveModelTier("")).toBe("weak");
  });

  // Strong models
  it('claude-opus → strong', () => {
    expect(resolveModelTier("anthropic/claude-opus-4")).toBe("strong");
  });

  it('claude-sonnet → strong', () => {
    expect(resolveModelTier("anthropic/claude-sonnet-4")).toBe("strong");
  });

  it('gpt-4o (non-mini) → strong', () => {
    expect(resolveModelTier("openai/gpt-4o")).toBe("strong");
  });

  it('gpt-4.1 → strong', () => {
    expect(resolveModelTier("openai/gpt-4.1")).toBe("strong");
  });

  it('gpt-5 → strong', () => {
    expect(resolveModelTier("openai/gpt-5")).toBe("strong");
  });

  it('minimax-m3 → strong', () => {
    expect(resolveModelTier("minimax/minimax-m3")).toBe("strong");
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyComplexity — direction invariant test (critical)
// ────────────────────────────────────────────────────────────────────
describe("classifyComplexity — direction invariant", () => {
  // Score = 2 (refactor signal seul) : ≥ seuil weak (2) → complex pour weak,
  // mais < seuil strong (4) → simple pour strong. C'est le seuil différenciateur.
  const moderateTask = "refactore la gestion des sessions utilisateurs";

  it('même tâche modérée : weak → complex, strong → simple (invariant anti-inversion)', () => {
    expect(classifyComplexity(moderateTask, "llamacpp/codellama-7b")).toBe("complex");
    expect(classifyComplexity(moderateTask, "anthropic/claude-opus-4")).toBe("simple");
  });

  it('tâche triviale → simple pour les deux tiers', () => {
    const trivial = "merci !";
    expect(classifyComplexity(trivial, "llamacpp/codellama-7b")).toBe("simple");
    expect(classifyComplexity(trivial, "anthropic/claude-opus-4")).toBe("simple");
  });
});

// ────────────────────────────────────────────────────────────────────
// classifyComplexity — scoring détaillé
// ────────────────────────────────────────────────────────────────────
describe("classifyComplexity — scoring", () => {
  it('tâche multi-étapes (puis/ensuite) → complex pour weak', () => {
    const task = "d'abord installe le package puis configure le provider";
    expect(classifyComplexity(task, "openai/gpt-4o-mini")).toBe("complex");
  });

  it('tâche multi-fichiers → complex pour weak', () => {
    const task = "migre tous les fichiers vers la nouvelle API";
    expect(classifyComplexity(task, "ollama/llama3:8b")).toBe("complex");
  });

  it('tâche complexe multi-signaux → complex même pour strong', () => {
    // score 2+2+2 = 6 ≥ threshold 4 pour strong
    const task = "refactore les fichiers du module auth, puis migre les routes vers la nouvelle API, ensuite update les tests";
    expect(classifyComplexity(task, "anthropic/claude-opus-4")).toBe("complex");
  });

  it('verbes action × 3 → ajoute 1 point au score', () => {
    // Exactement 3 verbes action, pas d'autre signal → score=1 pour weak (threshold=2 → simple)
    // Ajout d'un signal multi-fichiers pour dépasser le seuil weak
    const task = "create add implement les fichiers";
    // score: actionVerbs(3)→1 + multi-fichiers→2 = 3 ≥ 2 (weak threshold) → complex
    expect(classifyComplexity(task, "llamacpp/any")).toBe("complex");
    // score 3 < 4 (strong threshold) → simple
    expect(classifyComplexity(task, "anthropic/claude-sonnet-4")).toBe("simple");
  });
});

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

  // ── Anti-faux-positifs : une QUESTION sur un jeu ne délègue pas
  it('question sur un jeu (pas de verbe build) → pas delegate', () => {
    expect(resolveRoute("quel est ton jeu vidéo préféré ?")).not.toBe("delegate");
  });
  it('parler d\'une app sans verbe build → pas delegate', () => {
    expect(resolveRoute("c'est quoi la meilleure app de notes ?")).not.toBe("delegate");
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
