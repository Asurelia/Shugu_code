// Shugu Forge — Workspace text search panel (LOT 2.1).
//
// Remplace le wiring palette Cmd+Shift+F qui appelait jusqu'ici vecSearch
// (semantic). Ce panel fait du grep textuel pur via le backend Rust
// fs_grep_workspace (ripgrep-as-library).
//
// UX :
//   - Overlay flottant, ouvert via shell-context.findPanelOpen.
//   - Input principal + toggles (Aa case, .* regex).
//   - Résultats groupés par fichier, click sur ligne = navigate + position.
//   - Esc ferme le panel.
//
// État local : query + opts (input fields). Justification de la dérogation
// TanStack : ce sont des inputs UI éphémères, non cross-component, non
// persistés. TanStack Query gère la donnée (résultats grep) ; le state UI
// reste useState idiomatic React.

import { useState, useEffect, useRef, useMemo } from "react";
import type { EditorView } from "@codemirror/view";
import { useShell } from "@/routes/shell-context";
import { useGrepWorkspace, type GrepMatch, type GrepOpts } from "./grep/queries";
import { Icon } from "@/components/components";
import type { CodeMirrorEditorHandle } from "./CodeMirrorEditor";

interface GroupedResult {
  path: string;
  matches: GrepMatch[];
}

/**
 * Attend que CodeMirror remount avec le BON fichier (matching expectedPath)
 * et expose sa view. Polling court (30 ms × max 33 tentatives = ~1 s).
 *
 * Smoke test fix : la version précédente (`waitForView` simple) acceptait
 * le PREMIER non-null view retourné par le handle — mais durant le ré-mount
 * async qui suit `setActiveFile(newPath)`, le handle peut référencer
 * brièvement l'ANCIEN view (file A) avant de pointer sur le NOUVEAU (file B).
 * Résultat : `view.state.doc.line(N)` sur le mauvais doc, cursor sautait à
 * la ligne 1 (Math.max clamp) au lieu de la ligne du match. On utilise
 * désormais `getPath()` du handle pour vérifier qu'on attache le bon view.
 */
async function waitForViewOf(
  handleRef: React.RefObject<CodeMirrorEditorHandle> | undefined,
  expectedPath: string,
  maxMs = 1000,
): Promise<EditorView | null> {
  if (!handleRef) return null;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const h = handleRef.current;
    if (h && h.getPath() === expectedPath) {
      const view = h.getView();
      if (view) return view;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return null;
}

export function FindPanel() {
  const {
    findPanelOpen,
    setFindPanelOpen,
    openFile,
    editorViewRef,
  } = useShell();

  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<GrepOpts>({
    caseSensitive: false,
    regex: false,
    maxResults: 1000,
  });
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus l'input à l'ouverture (UX : l'utilisateur peut taper immédiatement).
  useEffect(() => {
    if (findPanelOpen) {
      // Délai 0 pour laisser le DOM se monter avant le focus.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [findPanelOpen]);

  // Esc ferme le panel — listener global tant que le panel est ouvert.
  useEffect(() => {
    if (!findPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setFindPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findPanelOpen, setFindPanelOpen]);

  const { data: results, isLoading, error } = useGrepWorkspace(query, opts);

  // Groupement par fichier pour l'affichage. Mémoïsé pour éviter le
  // recalcul à chaque render — utile sur les grosses listes (1000 matches).
  const grouped = useMemo<GroupedResult[]>(() => {
    if (!results) return [];
    const map = new Map<string, GrepMatch[]>();
    for (const m of results) {
      if (!map.has(m.path)) map.set(m.path, []);
      map.get(m.path)!.push(m);
    }
    return Array.from(map.entries()).map(([path, matches]) => ({ path, matches }));
  }, [results]);

  if (!findPanelOpen) return null;

  const onClickMatch = async (m: GrepMatch) => {
    // Ouvre le fichier (read + tab open + setActive) — gère le cas où il
    // n'est pas encore dans openFiles. Crucial : sans ça, setActiveFile
    // seul laisserait CodeMirror démonté car fileContents[m.path] n'existe
    // pas (cf. views-code.tsx:82-85 le conditional render).
    await openFile(m.path);
    setFindPanelOpen(false);
    // Attendre le view du BON fichier (getPath()===m.path), pas juste le
    // premier view dispo (qui pouvait être l'ancien en pleine transition).
    const view = await waitForViewOf(editorViewRef, m.path);
    if (!view) return;
    const lineInfo = view.state.doc.line(Math.max(1, m.line));
    view.dispatch({
      selection: { anchor: lineInfo.from },
      scrollIntoView: true,
    });
    view.focus();
  };

  return (
    <div className="find-panel" role="dialog" aria-label="Find in workspace">
      <div className="find-panel__head">
        <div className="find-panel__input-row">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            className="find-panel__input"
            type="text"
            placeholder="Search in workspace…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className={"find-panel__toggle" + (opts.caseSensitive ? " on" : "")}
            onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
            title="Match case"
            type="button"
          >
            Aa
          </button>
          <button
            className={"find-panel__toggle" + (opts.regex ? " on" : "")}
            onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))}
            title="Use regular expression"
            type="button"
          >
            .*
          </button>
          <button
            className="find-panel__close"
            onClick={() => setFindPanelOpen(false)}
            title="Close (Esc)"
            type="button"
          >
            ×
          </button>
        </div>
        <div className="find-panel__status">
          {isLoading && <span>Searching…</span>}
          {error && <span className="find-panel__error">Error: {String(error)}</span>}
          {!isLoading && !error && results && (
            <span>
              {results.length} match{results.length === 1 ? "" : "es"} in {grouped.length}{" "}
              file{grouped.length === 1 ? "" : "s"}
              {results.length === (opts.maxResults ?? 1000) && " (truncated)"}
            </span>
          )}
          {!query.trim() && !isLoading && (
            <span className="find-panel__hint">Type at least 2 characters</span>
          )}
        </div>
      </div>

      <div className="find-panel__results scroll">
        {grouped.map((g) => (
          <div key={g.path} className="find-panel__group">
            <div className="find-panel__group-head">
              <span className="find-panel__group-path">{g.path}</span>
              <span className="find-panel__group-count">{g.matches.length}</span>
            </div>
            <div className="find-panel__group-matches">
              {g.matches.map((m, i) => (
                <button
                  // path + line + i suffit comme key stable — pas besoin
                  // d'inclure le preview qui peut contenir des chars dégueu.
                  key={`${m.path}:${m.line}:${i}`}
                  className="find-panel__match"
                  onClick={() => onClickMatch(m)}
                  type="button"
                >
                  <span className="find-panel__match-line">{m.line}</span>
                  <span className="find-panel__match-preview">{m.preview}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
