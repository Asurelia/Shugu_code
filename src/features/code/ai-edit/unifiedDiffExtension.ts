// Shugu Forge — Lot 1 (Éditeur⇄AI) — extension diff inline + read-only.
//
// `aiEditCompartment` est un Compartment singleton module-level (même pattern
// que gitDiffCompartment / blameCompartment / stickyScrollCompartment) : il est
// seedé vide dans CodeMirrorEditor.tsx, et reconfiguré DE L'EXTÉRIEUR par
// aiEditController au fil des phases (streaming → preview → idle).
//
// Pourquoi un singleton et pas un useMemo per-instance (comme lspCompartment) :
// le contrôleur vit hors du composant React ; il doit pouvoir dispatcher un
// `aiEditCompartment.reconfigure(...)` sur la view courante sans passer par un
// state React. Le slot de compartiment doit donc être partagé.

import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";

/** Slot de compartiment partagé — seedé `of([])` dans CodeMirrorEditor.tsx. */
export const aiEditCompartment = new Compartment();

/**
 * Annotation marquant les transactions émises par le STREAM d'édition AI.
 * L'updateListener de CodeMirrorEditor saute `onChange` (→ setFileContents)
 * pour ces transactions : sinon chaque token streamé déclencherait un
 * setFileContents → re-render de RootLayout, soit N re-renders par seconde
 * (cause connue du freeze WebView2). Seules les transactions d'Accept/Reject
 * finales (non annotées) propagent vers l'état applicatif.
 */
export const aiEditStreamAnnotation = Annotation.define<boolean>();

/**
 * Extension "phase streaming" : éditeur read-only + non-éditable. Les
 * `view.dispatch` programmatiques du contrôleur passent quand même (readOnly
 * ne bloque que les entrées utilisateur), donc le texte AI peut s'écrire en
 * live pendant que la frappe utilisateur est gelée (évite la course
 * texte-streamé vs frappe).
 */
function lockExtension(): Extension[] {
  return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
}

/**
 * Extension "phase preview" : le diff inline. unifiedMergeView compare le doc
 * COURANT de l'éditeur (= nouvelle version, déjà écrite par le stream) contre
 * `original` (= ancienne version snapshotée). `mergeControls:false` car on
 * pilote Accept/Reject globalement depuis la barre du widget (1 décision pour
 * tout l'édit, façon Cursor) — contrôle total de la sémantique d'undo.
 * On garde l'éditeur verrouillé tant que la preview est en cours.
 */
function previewExtension(originalDoc: string): Extension {
  return [
    unifiedMergeView({
      original: originalDoc,
      mergeControls: false,
      gutter: true,
      highlightChanges: true,
      syntaxHighlightDeletions: true,
    }),
    ...lockExtension(),
  ];
}

/** Passe l'éditeur en mode "stream en cours" (verrouillé, pas encore de diff). */
export function enterStreaming(view: EditorView): void {
  view.dispatch({ effects: aiEditCompartment.reconfigure(lockExtension()) });
}

/** Monte le diff inline (original vs doc courant) + garde le verrou. */
export function enterPreview(view: EditorView, originalDoc: string): void {
  view.dispatch({ effects: aiEditCompartment.reconfigure(previewExtension(originalDoc)) });
}

/** Retire toute extension ai-edit (diff + verrou) — retour à l'éditeur normal. */
export function clearAiEdit(view: EditorView): void {
  view.dispatch({ effects: aiEditCompartment.reconfigure([]) });
}
