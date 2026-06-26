// Phase 7 #5 — tests du parser PUR du summary `browser_test`.
//
// Les fixtures reproduisent EXACTEMENT le format produit par browser.rs
// `render_outcome` (en-tête PASSED/FAILED, « URL finale : », bloc
// « Assertions : » + lignes « ✓/✗ kind target », bloc erreurs/console).

import { describe, it, expect } from "vitest";
import { parseBrowserTestSummary } from "./parseBrowserTest";

describe("parseBrowserTestSummary", () => {
  it("parse un test PASSED avec assertions + console propre", () => {
    const summary = [
      "browser_test: PASSED ✅",
      "URL finale : http://localhost:5173/",
      "Assertions :",
      "  ✓ selector #app",
      "  ✓ text Bienvenue",
      "Console : aucune erreur.",
    ].join("\n");

    const p = parseBrowserTestSummary(summary);
    expect(p.passed).toBe(true);
    expect(p.finalUrl).toBe("http://localhost:5173/");
    expect(p.assertions).toEqual([
      { ok: true, kind: "selector", target: "#app" },
      { ok: true, kind: "text", target: "Bienvenue" },
    ]);
    // L'en-tête PASSED, l'URL et l'en-tête « Assertions : » sont consommés ;
    // seule la ligne console reste.
    expect(p.rest).toBe("Console : aucune erreur.");
  });

  it("parse un test FAILED avec assertion en échec + erreurs (format backend réel)", () => {
    // Format EXACT de browser.rs render_outcome : erreurs page « ⚠ <msg> »,
    // erreurs console « ⚠ console: <text> », + ligne « Capture : <chemin> ».
    const summary = [
      "browser_test: FAILED ❌",
      "URL finale : http://localhost:5173/login",
      "Assertions :",
      "  ✗ selector #missing",
      "Erreurs (1 page, 1 console) :",
      "  ⚠ ResizeObserver loop limit exceeded",
      "  ⚠ console: Uncaught TypeError: x is not a function",
      "Capture : C:\\Users\\me\\AppData\\shugu\\browser-tests\\a-1.png",
    ].join("\n");

    const p = parseBrowserTestSummary(summary);
    expect(p.passed).toBe(false);
    expect(p.finalUrl).toBe("http://localhost:5173/login");
    expect(p.assertions).toEqual([
      { ok: false, kind: "selector", target: "#missing" },
    ]);
    // Le bloc erreurs (en-tête + lignes ⚠) retombe dans `rest`…
    expect(p.rest).toContain("Erreurs (1 page, 1 console) :");
    expect(p.rest).toContain("ResizeObserver loop limit exceeded");
    expect(p.rest).toContain("⚠ console: Uncaught TypeError");
    // …mais la ligne « Capture : » est retirée (l'image est rendue à part).
    expect(p.rest).not.toContain("Capture :");
  });

  it("retourne passed=null et tout en `rest` pour une panne d'infra", () => {
    const summary =
      "browser_test indisponible (playwright-missing). Playwright n'est pas installé dans ce projet.";
    const p = parseBrowserTestSummary(summary);
    expect(p.passed).toBeNull();
    expect(p.finalUrl).toBeUndefined();
    expect(p.assertions).toEqual([]);
    expect(p.rest).toBe(summary);
  });

  it("tolère un summary sans assertions ni URL", () => {
    const p = parseBrowserTestSummary("browser_test: PASSED ✅\nConsole : aucune erreur.");
    expect(p.passed).toBe(true);
    expect(p.assertions).toEqual([]);
    expect(p.finalUrl).toBeUndefined();
    expect(p.rest).toBe("Console : aucune erreur.");
  });
});
