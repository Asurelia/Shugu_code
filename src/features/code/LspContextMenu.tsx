// Shugu Forge — menu clic-droit LSP dans l'éditeur (Lot B §3c).
//
// Le menu d'annotation générique (panels/ContextMenu.tsx) est volontairement
// exclu de .cm-editor (RootLayout onContext). On fournit donc un petit menu
// DÉDIÉ au LSP, ouvert par l'événement contextmenu de l'éditeur. Il réutilise
// les classes CSS existantes (.ctx-menu/.ctx-item/.ctx-section) pour rester
// cohérent visuellement sans toucher le menu d'annotation.
//
// §3c : chaque entrée est GRISÉE si le serveur ne déclare pas la capacité
// correspondante (serverCapabilities) — pas d'action morte.
import type { EditorView } from "@codemirror/view";
import {
  LSPPlugin,
  jumpToDefinition,
  jumpToTypeDefinition,
  jumpToImplementation,
  findReferences,
  renameSymbol,
  formatDocument,
} from "@codemirror/lsp-client";

export interface LspMenuState {
  x: number;
  y: number;
  view: EditorView;
}

// serverCapabilities est typé `ServerCapabilities | null` par le package ; on
// le lit via le plugin sans réimporter le type (évite une dép transitive sur
// vscode-languageserver-protocol). `Caps` = forme minimale qu'on consulte.
type Caps = Record<string, unknown> | null;

interface Action {
  label: string;
  kbd?: string;
  run: (v: EditorView) => void;
  /** Clé de capacité LSP requise — l'entrée est grisée si absente du serveur. */
  capKey: string;
}

const ACTIONS: Action[] = [
  { label: "Aller à la définition", kbd: "F12", run: jumpToDefinition, capKey: "definitionProvider" },
  { label: "Aller au type", run: jumpToTypeDefinition, capKey: "typeDefinitionProvider" },
  { label: "Aller à l'implémentation", run: jumpToImplementation, capKey: "implementationProvider" },
  { label: "Rechercher les références", kbd: "⇧F12", run: findReferences, capKey: "referencesProvider" },
  { label: "Renommer le symbole", kbd: "F2", run: renameSymbol, capKey: "renameProvider" },
  { label: "Formater le document", kbd: "⇧⌥F", run: formatDocument, capKey: "documentFormattingProvider" },
];

export function LspContextMenu({
  state,
  onClose,
}: {
  state: LspMenuState | null;
  onClose: () => void;
}) {
  if (!state) return null;
  const W = 240, H = 240;
  // Math.max(8, …) — même garde que ContextMenu : jamais de left/top négatif
  // (menu coupé) quand la fenêtre est plus petite que l'estimation W/H.
  const left = Math.max(8, Math.min(state.x, window.innerWidth - W - 8));
  const top = Math.max(8, Math.min(state.y, window.innerHeight - H - 8));

  // Capacités du serveur attaché (null si pas encore initialisé → tout activé
  // par défaut, le serveur rejettera proprement si besoin).
  const caps = (LSPPlugin.get(state.view)?.client.serverCapabilities ?? null) as Caps;

  const onItem = (a: Action, enabled: boolean) => {
    if (!enabled) return;
    a.run(state.view);
    onClose();
  };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div className="ctx-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
        <div className="ctx-section">Language Server</div>
        {ACTIONS.map((a) => {
          // Pas de capacités connues → on active (le serveur tranchera) ; sinon
          // on respecte la capacité déclarée (truthy = supporté).
          const enabled = caps ? Boolean(caps[a.capKey]) : true;
          return (
            <button
              key={a.label}
              className="ctx-item"
              type="button"
              disabled={!enabled}
              style={enabled ? undefined : { opacity: 0.4, cursor: "default" }}
              onClick={() => onItem(a, enabled)}
            >
              <span className="label">{a.label}</span>
              {a.kbd && <span className="kbd">{a.kbd}</span>}
            </button>
          );
        })}
      </div>
    </>
  );
}
