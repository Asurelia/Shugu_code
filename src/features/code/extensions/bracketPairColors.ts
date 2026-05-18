// Shugu Forge — Bracket pair colorization (LOT 1.3).
//
// Pourquoi cette extension custom :
//   CodeMirror 6 n'inclut PAS de bracket pair colorization native (cf. la
//   discussion officielle discuss.codemirror.net/t/bracket-pair-colorization-in-cm6/5656).
//   Le `bracketMatching` du package @codemirror/language ne colore QUE le
//   pair sous le curseur, pas tout le document. Cette extension parcourt
//   le syntax tree Lezer du viewport visible, repère les paires (), [], {},
//   et leur applique une classe CSS rotative selon la profondeur d'imbrication
//   (rainbow style VS Code).
//
// Performance :
//   - Decorations limitées au range visible (viewport) — pas tout le document.
//   - Recalcul UNIQUEMENT sur viewportChanged ou docChanged (pas sur cursor).
//   - Walk Lezer en early-exit dès qu'on sort du viewport.

import { Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// 6 niveaux rainbow — au-delà on cycle. Cohérent avec la convention VS Code
// (qui propose 6 couleurs par défaut depuis 2022).
const LEVELS = 6;

// Decorations pré-construites pour chaque niveau — évite l'allocation
// à chaque render (le RangeSetBuilder réutilise les Decoration objects).
const levelMarks: Decoration[] = Array.from({ length: LEVELS }, (_, i) =>
  Decoration.mark({ class: `cm-bracket-l${i + 1}` })
);

// Filtrage PAR NODE NAME — pas par contenu (sliceString). Les grammars
// Lezer nomment les vrais brackets de structure littéralement "{", "}",
// "(", ")", "[", "]". Les tokens spéciaux qui RESSEMBLENT à un bracket
// (e.g. JS `InterpolationEnd` qui est le `}` fermant un `${...}`, ou
// `JSXStartTag` / `JSXEndTag`) ont leurs PROPRES noms et sont donc
// automatiquement exclus. Ça corrige le bug "rainbow désynchronisé par
// les template literals" repéré au LOT 1 review #2.
const OPENER_NAMES = new Set(["{", "(", "["]);
const CLOSER_NAMES = new Set(["}", ")", "]"]);

// Map fermant → ouvrant pour vérifier le pairing.
const PAIR_OF: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Compute decorations for the currently visible viewport.
 *
 * Stratégie (corrigée vs. v1) : on traverse TOUT le syntax tree pour
 * maintenir une stack { opener, level } qui reflète la profondeur réelle
 * d'imbrication, MAIS on n'émet une decoration que si le bracket tombe
 * dans le range visible. Sans cette correction, scroller au milieu d'un
 * fichier imbriqué donnait un rainbow décalé (les fermants en tête de
 * viewport n'avaient pas d'ouvrant correspondant dans la stack, et les
 * ouvrants redémarraient à 0 au lieu d'hériter de la profondeur réelle).
 *
 * Le walk Lezer reste rapide (l'arbre est incremental et matérialisé en
 * mémoire) ; on iterate sans `{ from, to }` mais on early-exit ne sert
 * à rien — on a besoin de toute l'info pour la stack. Le coût est O(N)
 * où N = nombre de brackets dans le doc (pas le doc entier).
 */
function computeBracketDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = syntaxTree(view.state);

  // Visible range bounds — union des visibleRanges (en cas de folds).
  // Le filtrage par node.name (vs. sliceString) rend `doc` inutile ici.
  const visFrom = view.visibleRanges[0]?.from ?? 0;
  const visTo = view.visibleRanges[view.visibleRanges.length - 1]?.to ?? view.state.doc.length;

  // Stack profondeur (seulement le level + le char attendu en fermant).
  const stack: { char: string; level: number }[] = [];

  // Decorations en attente — émises seulement si dans le visible. On les
  // pousse dans l'ordre du walk (croissant par `from`), donc pas de sort
  // nécessaire après — gain perf vs. v1.
  const pending: { from: number; to: number; level: number }[] = [];

  tree.iterate({
    enter: (node) => {
      // Filtrage par nom — voir commentaire sur OPENER_NAMES/CLOSER_NAMES
      // pour la justification (exclut InterpolationEnd, JSXEndTag, etc.).
      const name = node.name;
      if (OPENER_NAMES.has(name)) {
        const level = stack.length % LEVELS;
        stack.push({ char: name, level });
        if (node.to >= visFrom && node.from <= visTo) {
          pending.push({ from: node.from, to: node.to, level });
        }
      } else if (CLOSER_NAMES.has(name)) {
        const expected = PAIR_OF[name];
        if (stack.length > 0 && stack[stack.length - 1].char === expected) {
          const opener = stack.pop()!;
          if (node.to >= visFrom && node.from <= visTo) {
            pending.push({ from: node.from, to: node.to, level: opener.level });
          }
        }
        // Bracket orphelin (syntaxe cassée) → pas de couleur ; CodeMirror
        // applique sa propre classe error via bracketMatching.
      }
    },
  });

  // Pas de sort : le walk Lezer descend in-order (DFS), donc `pending`
  // est déjà trié par `from` croissant — requis par RangeSetBuilder.add.
  for (const { from, to, level } of pending) {
    builder.add(from, to, levelMarks[level]);
  }

  return builder.finish();
}

/**
 * The ViewPlugin that drives the decorations. Recompute on:
 *   - viewportChanged : user scrolled, new visible ranges.
 *   - docChanged      : user edited the document, brackets may have moved.
 *   - geometryChanged : font/zoom changes that re-layout content.
 *
 * NOT on selectionSet (cursor moved) — that would recompute on every
 * keystroke for nothing.
 */
export const bracketPairColors: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = computeBracketDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.decorations = computeBracketDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  }
);
