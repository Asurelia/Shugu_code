// Phase 7 #5 — parser PUR du summary texte de l'outil agent `browser_test`.
//
// Séparé du composant (pattern parseVecHit.ts) : logique pure testable + le
// .tsx ne ré-exporte que son composant (fast-refresh propre).
//
// Le backend (browser.rs `render_outcome`) renvoie un `summary` TEXTE déjà
// formaté — première ligne « browser_test: PASSED ✅ » / « FAILED ❌ »,
// « URL finale : … », un bloc « Assertions : » de lignes « ✓/✗ kind target »,
// puis le bloc erreurs/console (lignes « ⚠ … » / « ⚠ console: … »), et — si une
// capture existe — une ligne « Capture : <chemin> ». On ne re-parse PAS du
// JSON : toute ligne non reconnue retombe dans `rest` (robuste).

export interface ParsedAssertion {
  ok: boolean;
  /** « selector » / « text » … */
  kind: string;
  /** La cible asservie (sélecteur CSS, texte attendu…). */
  target: string;
}

export interface ParsedBrowserTest {
  /** true = PASSED, false = FAILED, null = ni l'un ni l'autre (panne d'infra
   *  / message d'erreur — tout part alors dans `rest`). */
  passed: boolean | null;
  finalUrl?: string;
  assertions: ParsedAssertion[];
  /** Lignes non structurées (erreurs page/console, hints d'infra…), jointes. */
  rest: string;
}

/** Parse PUR et tolérant du summary texte de `browser_test`. Tout champ absent
 *  est simplement omis ; aucune exception. */
export function parseBrowserTestSummary(summary: string): ParsedBrowserTest {
  let passed: boolean | null = null;
  let finalUrl: string | undefined;
  const assertions: ParsedAssertion[] = [];
  const rest: string[] = [];

  for (const line of summary.split("\n")) {
    if (passed === null && /^browser_test:\s*PASSED/.test(line)) {
      passed = true;
      continue;
    }
    if (passed === null && /^browser_test:\s*FAILED/.test(line)) {
      passed = false;
      continue;
    }
    const urlM = line.match(/^URL finale\s*:\s*(.+)$/);
    if (urlM) {
      finalUrl = urlM[1].trim();
      continue;
    }
    // En-tête du bloc assertions — purement décoratif, on le retire.
    if (/^Assertions\s*:/.test(line)) continue;
    // « Capture : <chemin> » — l'image est rendue à part, on retire la ligne.
    if (/^Capture\s*:/.test(line)) continue;
    // « <indent>✓ selector #app » / « <indent>✗ text Bonjour ».
    const am = line.match(/^\s*([✓✗])\s+(\S+)\s+(.+)$/);
    if (am) {
      assertions.push({ ok: am[1] === "✓", kind: am[2], target: am[3].trim() });
      continue;
    }
    rest.push(line);
  }

  return { passed, finalUrl, assertions, rest: rest.join("\n").trim() };
}
