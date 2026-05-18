// Shugu Forge — Breadcrumbs au-dessus de l'éditeur (LOT 2.3).
//
// Affiche : workspace › src › features › code › CodeMirrorEditor.tsx › CodeMirrorEditor
// Le dernier segment est le symbole courant (fonction/classe sous le curseur),
// dérivé du syntax tree Lezer.
//
// Dérogation TanStack documentée : ce composant ne fait PAS de useQuery.
// Justification :
//   - Le path file segments est dérivé de filePath (string) — pas de cache,
//     calcul instantané (.split('/')).
//   - Le symbole courant est dérivé du cursor position + syntax tree, qui
//     change à CHAQUE mouvement du curseur. Une query rendrait l'invalidation
//     aussi chère que le calcul direct (le syntaxTree est déjà en mémoire).
//   - Pas de partage cross-component (seule la breadcrumbs lit cette info).
// Conclusion : useState + useEffect listener sur CodeMirror est idiomatique
// React et cohérent avec la politique "TanStack par défaut SAUF dérogation
// justifiée + commentée" du projet.

import { useEffect, useState, type RefObject } from "react";
import { syntaxTree } from "@codemirror/language";
import type { CodeMirrorEditorHandle } from "./CodeMirrorEditor";

interface BreadcrumbsProps {
  /** Path workspace-relative (e.g. "src/features/code/CodeMirrorEditor.tsx"). */
  filePath: string | null;
  /** Handle ref du CodeMirrorEditor. */
  editorHandle: RefObject<CodeMirrorEditorHandle> | undefined;
}

/**
 * Liste des "node names" Lezer qui forment un scope nommé — on les retient
 * pour construire le chemin de symboles ancêtres du curseur. Aligné sur la
 * map KIND_FOR_NODE de outline/queries.ts pour cohérence (mêmes node names
 * que ceux qui apparaissent dans l'outline panel).
 */
const SCOPE_NODE_NAMES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunction",
  "ClassDeclaration",
  "ClassExpression",
  "MethodDeclaration",
  "InterfaceDeclaration",
  "TypeAliasDeclaration",
  "EnumDeclaration",
  // Python
  "FunctionDefinition",
  "ClassDefinition",
  // Markdown headings
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
]);

/**
 * Hook : maintient le chemin de symboles ancêtres du cursor courant.
 * Polling 200 ms (cf. OutlinePanel pour la justification du polling
 * vs. subscription directe à l'updateListener CodeMirror).
 */
function useCurrentSymbolPath(
  handle: RefObject<CodeMirrorEditorHandle> | undefined,
): string[] {
  const [path, setPath] = useState<string[]>([]);
  useEffect(() => {
    if (!handle) {
      setPath([]);
      return;
    }
    const recompute = () => {
      const view = handle.current?.getView();
      if (!view) {
        setPath((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const state = view.state;
      const pos = state.selection.main.head;
      const tree = syntaxTree(state);
      let node = tree.resolveInner(pos, 1);
      const segs: string[] = [];
      while (node.parent) {
        if (SCOPE_NODE_NAMES.has(node.name)) {
          const name = extractName(
            node,
            state.doc.sliceString.bind(state.doc),
          );
          if (name) segs.unshift(name);
        }
        node = node.parent;
      }
      // Évite un setState inutile si le path n'a pas changé (compare shallow).
      setPath((prev) => {
        if (prev.length !== segs.length) return segs;
        for (let i = 0; i < prev.length; i++) {
          if (prev[i] !== segs[i]) return segs;
        }
        return prev;
      });
    };
    recompute();
    const id = setInterval(recompute, 200);
    return () => clearInterval(id);
  }, [handle]);
  return path;
}

function extractName(
  node: { from: number; to: number; name: string },
  slice: (from: number, to: number) => string,
): string | null {
  const text = slice(node.from, Math.min(node.from + 200, node.to)).trim();
  // Heading markdown
  if (/^#+\s/.test(text)) {
    return text.replace(/^#+\s*/, "").split("\n")[0].slice(0, 40);
  }
  const m = text.match(/\b(?:function|class|interface|type|enum|def)\s+(\w+)/);
  if (m) return m[1];
  const cm = text.match(/\b(?:const|let|var)\s+(\w+)/);
  if (cm) return cm[1];
  return null;
}

export function Breadcrumbs({ filePath, editorHandle }: BreadcrumbsProps) {
  const symbolPath = useCurrentSymbolPath(editorHandle);

  if (!filePath) return null;
  const segs = filePath.split("/").filter(Boolean);

  return (
    <div className="breadcrumbs" role="navigation" aria-label="Breadcrumbs">
      {segs.map((seg, i) => (
        <span key={`f-${i}`} className="breadcrumbs__seg">
          {i > 0 && <span className="breadcrumbs__sep">›</span>}
          <span className="breadcrumbs__text">{seg}</span>
        </span>
      ))}
      {symbolPath.length > 0 && (
        <>
          {symbolPath.map((s, i) => (
            <span key={`s-${i}`} className="breadcrumbs__seg breadcrumbs__seg--sym">
              <span className="breadcrumbs__sep">›</span>
              <span className="breadcrumbs__text">{s}</span>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
