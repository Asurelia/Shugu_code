// Shugu Forge — Phase 7 #2 : parsing pur des ids de hit sémantique.
//
// Le backend `semantic_search` (lib/vector.ts::semanticSearch) renvoie des
// `VecHit` dont l'`id` encode le chunk de code sous la forme :
//
//     <path>#L<start>-<end>      (chunk multi-lignes)   ex: "src/x.ts#L10-20"
//     <path>#L<line>             (chunk d'une ligne)     ex: "src/x.ts#L10"
//
// Ce module est PUR (aucun import React / Tauri) → testable unitairement et
// réutilisable côté palette comme côté tests. Toute la logique de découpage
// d'id vit ici pour que `SemanticSearchPalette` reste une coquille UI mince.

import type { VecHit } from "@/lib/vector";

/** Coordonnées de localisation extraites d'un id de hit. */
export interface ParsedVecHit {
  /** Chemin du fichier (relatif au workspace), tel qu'encodé avant `#L`. */
  path: string;
  /** Première ligne du chunk (1-based). 1 par défaut si non parsable. */
  startLine: number;
  /** Dernière ligne du chunk (1-based). Égale à `startLine` si mono-ligne. */
  endLine: number;
}

/**
 * Convertit `n` en entier de ligne 1-based valide, ou `null` si la chaîne
 * n'est pas un entier strictement positif. Tolère les espaces parasites.
 */
function parseLine(n: string): number | null {
  const trimmed = n.trim();
  // N'accepte que des chiffres (pas de signe, pas de décimale, pas de "10px").
  if (!/^\d+$/.test(trimmed)) return null;
  const v = Number.parseInt(trimmed, 10);
  return Number.isFinite(v) && v >= 1 ? v : null;
}

/**
 * Découpe un id de hit (`path#Lstart-end`, `path#Lstart`, ou malformé) en
 * `{ path, startLine, endLine }`.
 *
 * Robustesse (un index froid / corrompu ne doit JAMAIS faire planter la
 * palette) :
 *   - pas de `#L`            → tout l'id est le path, lignes = 1..1
 *   - `#L10`                 → mono-ligne, start = end = 10
 *   - `#L10-20`              → start = 10, end = 20
 *   - `#L20-10` (inversé)    → on normalise (start ≤ end)
 *   - `#L` ou `#Labc` (vide / non numérique) → fallback ligne 1, path conservé
 *
 * Le path est toujours conservé tel quel (même si le suffixe est illisible) :
 * pouvoir ouvrir le fichier vaut mieux que perdre le résultat entièrement.
 */
export function parseVecHit(id: string): ParsedVecHit {
  // On scinde sur le PREMIER `#L` : un path peut théoriquement contenir un
  // `#` (rare mais légal sous POSIX), seul le marqueur de ligne `#L` compte.
  const marker = id.indexOf("#L");
  if (marker === -1) {
    // Aucun marqueur de ligne — l'id entier est le chemin.
    return { path: id, startLine: 1, endLine: 1 };
  }

  const path = id.slice(0, marker);
  const range = id.slice(marker + 2); // après "#L"

  const dash = range.indexOf("-");
  if (dash === -1) {
    // Forme mono-ligne `path#L10` (ou suffixe non numérique → fallback 1).
    const line = parseLine(range) ?? 1;
    return { path, startLine: line, endLine: line };
  }

  // Forme intervalle `path#L10-20`.
  const start = parseLine(range.slice(0, dash));
  const end = parseLine(range.slice(dash + 1));

  if (start === null && end === null) {
    return { path, startLine: 1, endLine: 1 };
  }
  // Si un seul côté est lisible, on l'utilise pour les deux bornes.
  const s = start ?? end!;
  const e = end ?? start!;
  // Normalise un intervalle inversé pour garantir start ≤ end.
  return s <= e
    ? { path, startLine: s, endLine: e }
    : { path, startLine: e, endLine: s };
}

/**
 * Construit le libellé `#Lstart-end` (ou `#Lline` pour un chunk mono-ligne)
 * à afficher en hint muet à côté du chemin dans la palette.
 */
export function buildResultLabel(hit: VecHit): string {
  const { startLine, endLine } = parseVecHit(hit.id);
  return startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`;
}
