// Shugu Forge — Outline panel (LOT 2.2).
//
// Affiche les symboles structurels du fichier ouvert (fonctions, classes,
// headings markdown). Source : syntax tree Lezer extrait via parseLezerSymbols
// (cf. outline/queries.ts).
//
// En LOT 3, la source sera remplacée par textDocument/documentSymbol du LSP
// quand un client est disponible pour la langue, avec fallback Lezer sinon.
// L'interface OutlineSymbol est volontairement alignée sur LSP DocumentSymbol
// pour permettre ce swap sans toucher la UI.
//
// Click sur un symbole = move cursor + scroll into view.

import { useEffect, useState, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { useOutline, type OutlineSymbol, type SymbolKind } from "./outline/queries";
import type { CodeMirrorEditorHandle } from "./CodeMirrorEditor";

interface OutlinePanelProps {
  /** Handle ref du CodeMirrorEditor — utilisé pour récupérer view + docVersion
   *  sans avoir à modifier la config de l'éditeur depuis l'extérieur. */
  editorHandle: RefObject<CodeMirrorEditorHandle> | undefined;
  /** Path du fichier actif (utilisé comme cache key). */
  filePath: string | null;
}

/**
 * Hook : récupère la view CodeMirror via le handle ref. La ref est null tant
 * que CodeMirror n'a pas mounté ; on poll à 100 ms pour détecter quand elle
 * devient disponible. Re-poll aussi quand le filePath change (re-mount de
 * l'éditeur sur changement de langage).
 */
function useEditorView(
  handle: RefObject<CodeMirrorEditorHandle> | undefined,
  filePath: string | null,
): EditorView | null {
  const [view, setView] = useState<EditorView | null>(null);
  useEffect(() => {
    if (!handle) {
      setView(null);
      return;
    }
    const id = setInterval(() => {
      const v = handle.current?.getView() ?? null;
      setView((prev) => (prev === v ? prev : v));
    }, 100);
    return () => clearInterval(id);
  }, [handle, filePath]);
  return view;
}

/**
 * Hook : poll le compteur getDocVersion() du handle. Le compteur est
 * incrémenté à chaque docChanged dans le updateListener de l'éditeur, donc
 * toute édition (y compris same-length comme un rename) bumpe la version.
 *
 * Polling 250 ms = équilibre UX/perf : l'utilisateur perçoit l'outline
 * comme "instantané" sans noyer le CPU.
 */
function useDocVersion(
  handle: RefObject<CodeMirrorEditorHandle> | undefined,
): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!handle) return;
    const id = setInterval(() => {
      const v = handle.current?.getDocVersion() ?? 0;
      setVersion((prev) => (prev === v ? prev : v));
    }, 250);
    return () => clearInterval(id);
  }, [handle]);
  return version;
}

// Smoke test feedback — labels lisibles (mots) au lieu de glyphs Unicode.
// Plus propre, plus VS Code-like, et plus accessible (un screen reader
// dit "function App" au lieu de "ƒ App").
const LABEL_FOR_KIND: Record<SymbolKind, string> = {
  function: "fn",
  class: "class",
  method: "fn",
  interface: "interface",
  type: "type",
  enum: "enum",
  variable: "var",
  heading: "h",
  query: "query",
  mutation: "mutation",
};

const COLOR_FOR_KIND: Record<SymbolKind, string> = {
  function: "var(--tertiary)",
  class: "var(--secondary)",
  method: "var(--tertiary-dim)",
  interface: "var(--primary)",
  type: "var(--primary-dim)",
  enum: "var(--warn)",
  variable: "var(--on-surface-variant)",
  heading: "var(--primary)",
  // TanStack kinds : couleurs spécifiques pour distinguer query/mutation
  // (Aligné avec la convention dans dev tools React Query).
  query: "var(--success)",     // green-mint — read
  mutation: "var(--secondary)", // pink — write
};

export function OutlinePanel({ editorHandle, filePath }: OutlinePanelProps) {
  const view = useEditorView(editorHandle, filePath);
  const docVersion = useDocVersion(editorHandle);
  const { data: symbols } = useOutline(filePath, docVersion, view?.state ?? null);

  if (!filePath) {
    return (
      <div className="outline-panel outline-panel--empty">
        <span>No file open</span>
      </div>
    );
  }

  if (!symbols || symbols.length === 0) {
    return (
      <div className="outline-panel outline-panel--empty">
        <span>No symbols found</span>
      </div>
    );
  }

  const onClick = (sym: OutlineSymbol) => {
    if (!view) return;
    view.dispatch({
      selection: EditorSelection.cursor(sym.from),
      scrollIntoView: true,
    });
    view.focus();
  };

  return (
    <div className="outline-panel scroll">
      <div className="outline-panel__head">Outline</div>
      <SymbolList symbols={symbols} depth={0} onClick={onClick} />
    </div>
  );
}

function SymbolList({
  symbols,
  depth,
  onClick,
}: {
  symbols: OutlineSymbol[];
  depth: number;
  onClick: (sym: OutlineSymbol) => void;
}) {
  return (
    <div className="outline-panel__list">
      {symbols.map((sym, i) => (
        // key stable : `from` est unique dans un document.
        <div key={`${sym.from}-${i}`}>
          <button
            className="outline-panel__item"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onClick(sym)}
            type="button"
            title={`${sym.kind} ${sym.name}`}
          >
            <span
              className="outline-panel__kind"
              style={{ color: COLOR_FOR_KIND[sym.kind] }}
            >
              {LABEL_FOR_KIND[sym.kind]}
            </span>
            <span className="outline-panel__name">{sym.name}</span>
          </button>
          {sym.children && sym.children.length > 0 && (
            <SymbolList symbols={sym.children} depth={depth + 1} onClick={onClick} />
          )}
        </div>
      ))}
    </div>
  );
}
