// Shugu Forge — pont entre le LSPClient (singleton module-level, hors React)
// et la couche shell React (Lot B §2).
//
// ShuguWorkspace.displayFile doit OUVRIR un fichier (logique qui vit dans
// RootLayout.openFile) et récupérer l'EditorView du fichier actif. Le LSPClient
// ne peut pas recevoir de props React (c'est un singleton créé hors du cycle
// React). RootLayout publie donc ces capacités ici au montage ; ShuguWorkspace
// les lit. Même pattern que editorSelectionStore (publication hors-React lue
// par un consommateur), conforme à feedback_useshell_in_rootlayout.
import type { EditorView } from "@codemirror/view";

export interface LspBridge {
  /** Ouvre (ou active) un fichier dans l'éditeur. Lit le disque si besoin. */
  openFile: (path: string) => Promise<void>;
  /** Retourne l'EditorView du fichier actif s'il correspond à `path`, sinon null.
   *  (Architecture mono-éditeur : un seul EditorView vivant = le fichier actif.) */
  getViewForPath: (path: string) => EditorView | null;
}

let bridge: LspBridge | null = null;

/** Publié par RootLayout au montage (useEffect). */
export function setLspBridge(b: LspBridge): void {
  bridge = b;
}

export function getLspBridge(): LspBridge | null {
  return bridge;
}
