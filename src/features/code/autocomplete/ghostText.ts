// Shugu Forge — Lot 5 (scaffold) — ghost text inline (CodeMirror 6).
//
// Affiche la suggestion d'autocomplete en texte fantôme (grisé) APRÈS le
// curseur, sans modifier le document. Tab insère la suggestion, Échap (ou toute
// frappe / déplacement du curseur) la rejette. Auto-contenu : exposer
// ghostTextExtension() dans les extensions de l'éditeur + piloter via
// showGhost/clearGhost. Le DÉCLENCHEMENT (debounce + requête FIM) n'est PAS
// monté ici — c'est l'étape d'activation runtime (cf. flag du lot).

import { StateEffect, StateField, Prec } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from "@codemirror/view";

interface GhostState {
  text: string;
  /** Position d'ancrage (le curseur au moment de la suggestion). */
  pos: number;
}

/** Pose (ou efface avec null) la suggestion courante. */
export const setGhostText = StateEffect.define<GhostState | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    // Première ligne inline ; les suivantes en pre pour garder les sauts.
    span.textContent = this.text;
    return span;
  }
  // Le widget n'est pas éditable et ne doit pas capturer les events.
  ignoreEvent(): boolean {
    return true;
  }
}

const ghostField = StateField.define<GhostState | null>({
  create: () => null,
  update(value, tr) {
    // Un effet explicite gagne toujours (set/clear), y compris sur la
    // transaction d'acceptation (qui efface en même temps qu'elle insère).
    for (const e of tr.effects) {
      if (e.is(setGhostText)) return e.value;
    }
    // Toute frappe ou déplacement du curseur invalide la suggestion.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (st): DecorationSet => {
      if (!st || !st.text) return Decoration.none;
      return Decoration.set([
        Decoration.widget({ widget: new GhostWidget(st.text), side: 1 }).range(st.pos),
      ]);
    }),
});

/** Lecture de la suggestion courante (ou null). */
export function currentGhost(view: EditorView): GhostState | null {
  return view.state.field(ghostField, false) ?? null;
}

/** Affiche `text` en ghost à `pos` (par défaut la tête de sélection). */
export function showGhost(view: EditorView, text: string, pos?: number): void {
  const anchor = pos ?? view.state.selection.main.head;
  view.dispatch({ effects: setGhostText.of(text ? { text, pos: anchor } : null) });
}

/** Efface la suggestion. */
export function clearGhost(view: EditorView): void {
  if (currentGhost(view)) view.dispatch({ effects: setGhostText.of(null) });
}

// Tab accepte (insère la suggestion), Échap rejette. Prec.highest pour passer
// avant l'indentation Tab par défaut — mais on retourne false si pas de ghost,
// laissant alors le comportement normal de Tab/Échap intact.
const ghostKeymap = Prec.highest(
  keymap.of([
    {
      key: "Tab",
      run: (view) => {
        const g = currentGhost(view);
        if (!g || !g.text) return false;
        view.dispatch({
          changes: { from: g.pos, insert: g.text },
          selection: { anchor: g.pos + g.text.length },
          effects: setGhostText.of(null),
        });
        return true;
      },
    },
    {
      key: "Escape",
      run: (view) => {
        if (!currentGhost(view)) return false;
        clearGhost(view);
        return true;
      },
    },
  ]),
);

/** Extension à ajouter aux extensions de l'éditeur pour activer le ghost text. */
export function ghostTextExtension() {
  return [ghostField, ghostKeymap];
}
