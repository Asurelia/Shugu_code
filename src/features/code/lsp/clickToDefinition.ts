// Shugu Forge — Ctrl/Cmd+Clic = Aller à la définition (Lot B §3a).
//
// Le geste n°1 de Cursor/VS Code. Monté dans le lspCompartment (donc actif
// seulement quand un LSP est attaché). Si Ctrl (Win/Linux) ou Cmd (Mac) est
// enfoncé au mousedown, on place le curseur sous la souris puis on lance
// jumpToDefinition (qui, via ShuguWorkspace.displayFile, sait sauter dans un
// autre fichier).
import { EditorView } from "@codemirror/view";
import { jumpToDefinition } from "@codemirror/lsp-client";

export function clickToDefinition(): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0) return false; // bouton gauche uniquement
      if (!event.ctrlKey && !event.metaKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      view.dispatch({ selection: { anchor: pos } });
      // jumpToDefinition est async ; on déclenche et on consomme l'événement
      // pour éviter une sélection de texte parasite sous le Ctrl+clic.
      jumpToDefinition(view);
      event.preventDefault();
      return true;
    },
  });
}
