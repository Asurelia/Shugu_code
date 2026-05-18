// Shugu Forge — CodeMirror 6 React host (ESM imports, no CDN, no window globals).
// Replaces the proto's window.mountCodeMirror bootstrap.

import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  hoverTooltip,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
  syntaxTree,
} from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import {
  autocompletion,
  completionKeymap,
  completeFromList,
  completeAnyWord,
} from "@codemirror/autocomplete";
import { lintGutter } from "@codemirror/lint";
import { tags } from "@lezer/highlight";
import { langFromPath } from "@/lib/fs";
import { langExtensionFor } from "./languages";
import { wordWrapCompartment, wordWrapInitial, setWordWrap } from "./extensions/wordWrap";
import { regionFoldingService } from "./extensions/regionFolding";
import { diag } from "@/lib/diag";
import { bracketPairColors } from "./extensions/bracketPairColors";
import { snippetCompletionSource } from "./snippets/loader";
import { getLspClient, isLspSupported, fileUriForPath, fmtErr } from "./lsp/client";

const veilHighlight = HighlightStyle.define([
  { tag: tags.keyword,        color: "#d180ef" },
  { tag: tags.controlKeyword, color: "#e08efe", fontWeight: "600" },
  { tag: tags.string,         color: "#8aefc7" },
  { tag: tags.number,         color: "#ffcf6b" },
  { tag: tags.comment,        color: "#6e6a89", fontStyle: "italic" },
  { tag: tags.function(tags.variableName), color: "#81ecff" },
  { tag: tags.typeName,       color: "#fd6c9c" },
  { tag: tags.propertyName,   color: "#c9b9ff" },
  { tag: tags.operator,       color: "#a5a0bf" },
  { tag: tags.variableName,   color: "#ece8f5" },
  { tag: tags.bracket,        color: "#a5a0bf" },
  { tag: tags.bool,           color: "#ffcf6b" },
  { tag: tags.atom,           color: "#ffcf6b" },
  { tag: tags.meta,           color: "#81ecff" },
]);

const veilTheme = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "#ece8f5", height: "100%" },
  ".cm-content": {
    caretColor: "#e08efe",
    padding: "16px 0",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: "13px",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "#6e6a89",
    border: "none",
    fontFamily: "JetBrains Mono, monospace",
    fontSize: "12px",
  },
  ".cm-activeLineGutter": { backgroundColor: "rgba(224,142,254,0.06)", color: "#e08efe" },
  ".cm-activeLine": { backgroundColor: "rgba(224,142,254,0.04)" },
  ".cm-selectionBackground, ::selection": { backgroundColor: "rgba(224,142,254,0.22)" },
  ".cm-cursor": { borderLeft: "2px solid #e08efe" },
}, { dark: true });

/**
 * Keyword completion seed per language — minimal word list used by the
 * autocomplete `completeFromList` source. Sémantique LSP arrivera en LOT 3 ;
 * en LOT 1 on couvre les keywords les plus tapés pour éviter qu'autocomplete
 * paraisse vide tant qu'il n'y a pas de LSP.
 */
const KEYWORDS_FOR_LANG: Record<string, string[]> = {
  typescript: [
    "const", "let", "var", "function", "async", "await", "return", "if", "else",
    "for", "while", "do", "switch", "case", "break", "continue", "class",
    "extends", "implements", "interface", "type", "enum", "import", "export",
    "from", "default", "new", "this", "super", "try", "catch", "finally",
    "throw", "typeof", "instanceof", "true", "false", "null", "undefined",
    "void", "never", "unknown", "any", "string", "number", "boolean", "object",
    "Promise", "Array", "Record", "Partial", "Readonly", "Pick", "Omit",
  ],
  javascript: [
    "const", "let", "var", "function", "async", "await", "return", "if", "else",
    "for", "while", "do", "switch", "case", "break", "continue", "class",
    "extends", "import", "export", "from", "default", "new", "this", "super",
    "try", "catch", "finally", "throw", "typeof", "instanceof", "true", "false",
    "null", "undefined",
  ],
  python: [
    "def", "class", "return", "if", "elif", "else", "for", "while", "break",
    "continue", "pass", "import", "from", "as", "with", "try", "except", "finally",
    "raise", "lambda", "yield", "async", "await", "True", "False", "None", "and",
    "or", "not", "in", "is", "global", "nonlocal", "self", "print", "len", "range",
  ],
  rust: [
    "fn", "let", "mut", "const", "static", "if", "else", "for", "while", "loop",
    "match", "return", "struct", "enum", "trait", "impl", "pub", "use", "mod",
    "crate", "self", "Self", "super", "as", "where", "async", "await", "move",
    "ref", "true", "false", "Some", "None", "Ok", "Err", "Vec", "String", "Box",
    "Option", "Result", "i32", "u32", "i64", "u64", "f32", "f64", "usize", "bool", "str",
  ],
  markdown: [],
};

/**
 * Hover tooltip basique — affiche le nom du noeud Lezer sous le curseur.
 * En LOT 1 c'est utile pour les long identifiers (lecture rapide), et c'est
 * remplacé en LOT 3 par les vraies hovers LSP (markdown enrichi).
 */
const basicHoverTooltip = hoverTooltip((view, pos) => {
  const tree = syntaxTree(view.state);
  const node = tree.resolveInner(pos, 1);
  const text = view.state.doc.sliceString(node.from, node.to);
  // Skip empty/whitespace/punct/very long content — let LSP handle the rich
  // case in LOT 3. Le check text.length === 0 couvre déjà node.from === node.to.
  if (text.length === 0 || text.length > 80 || /^\s+$/.test(text)) return null;
  return {
    pos: node.from,
    end: node.to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "cm-hover-basic";
      dom.textContent = `${node.name} · ${text}`;
      return { dom };
    },
  };
});

/** Handle type exposed to parents via forwardRef / useImperativeHandle. */
export interface CodeMirrorEditorHandle {
  getView(): EditorView | null;
  openSearch(): void;
  /**
   * LOT 2 — Monotonic counter incrémenté à chaque docChanged. Sert de cache
   * key pour les consommateurs externes (OutlinePanel, Breadcrumbs) qui
   * doivent re-parser le syntaxTree quand le document change, sans avoir à
   * écouter eux-mêmes les updateListener de CodeMirror (qui nécessiterait
   * de modifier la config de l'éditeur de l'extérieur).
   *
   * Le caller poll ce compteur à interval (e.g. 200 ms) et compare avec sa
   * dernière valeur ; si elle a changé, il déclenche son re-fetch. Coût d'un
   * appel : O(1) (lecture d'une ref).
   */
  getDocVersion(): number;
  /**
   * Smoke test fix — Path du fichier actuellement monté dans l'éditeur.
   * Permet à FindPanel de waitForView du BON éditeur après navigation
   * (sinon le polling peut retourner l'ancien view brièvement, et le
   * cursor saute à la mauvaise ligne du mauvais fichier).
   */
  getPath(): string | null;
}

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, {
  value: string;
  onChange?: (v: string) => void;
  /** Full file path (used to pick the language extension). Fallback: typescript. */
  path?: string;
  /** @deprecated Pass `path` instead — kept for callers not yet sending a path. */
  language?: string;
  /** LOT 1 — enable line wrapping. Default: false. Reconfigured via Compartment
   *  on change — does NOT re-mount the editor (cursor/scroll preserved). */
  wordWrap?: boolean;
}>(function CodeMirrorEditor({ value, onChange, path, language = "typescript", wordWrap = false }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // LOT 2 — Doc version counter, incrémenté à chaque docChanged via le
  // updateListener. Lu par OutlinePanel/Breadcrumbs via getDocVersion().
  const docVersionRef = useRef(0);
  // LOT 3 — Compartment pour le plugin LSP. Permet le reconfigure async :
  // l'EditorState est créé synchrone (avec lspCompartment.of([])), puis
  // un useEffect attend que getLspClient() résolve et dispatch un effect
  // de reconfigure avec le vrai client.plugin(uri, langId).
  //
  // useMemo([]) — Compartment STABLE sur la vie du composant (fix M5
  // reviewer #1 LOT 3) :
  //   * Un Compartment est un identifier d'extension slot, pas un objet
  //     stateful — il peut être réutilisé sur plusieurs EditorState.
  //   * Avec deps `[path]`, un nouveau Compartment était créé à chaque
  //     changement de fichier ; risque silent si jamais le langExt
  //     n'était PAS recalculé en même temps (ex. `.ts → .tsx` qui
  //     produisent le même langExt) : le useEffect créateur du state ne
  //     re-déclenchait pas, mais le useEffect LSP dispatchait sur le
  //     NOUVEAU compartment absent du state → no-op silencieux.
  //   * Avec deps `[]`, le même Compartment est dans tous les states
  //     successifs et le reconfigure dispatch toujours sur le bon slot.
  const lspCompartment = useMemo(() => new Compartment(), []);

  // Re-compute language extension only when path (or legacy language) changes.
  // LOT 1: delegates to the central langExtensionFor mapper (languages.ts).
  // Deps [path, language] unchanged — wordWrap must NOT be a dep here, as that
  // would trigger a full editor re-mount on toggle (destroying cursor/scroll).
  const langExt = useMemo(
    () => langExtensionFor(path ? langFromPath(path) : (language ?? "")),
    [path, language],
  );

  // Expose getView(), openSearch(), getDocVersion(), getPath() to parent refs.
  // Dépendance [path] : le handle DOIT être recréé quand path change pour
  // que getPath() retourne la valeur courante (sinon il capturerait le path
  // initial dans sa closure et FindPanel.waitForViewOf échouerait).
  useImperativeHandle(ref, () => ({
    getView() { return viewRef.current; },
    openSearch() {
      if (viewRef.current) openSearchPanel(viewRef.current);
    },
    getDocVersion() { return docVersionRef.current; },
    getPath() { return path ?? null; },
  }), [path]);

  useEffect(() => {
    if (!hostRef.current) return;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        // LOT 2 — bump version pour les consommateurs externes (Outline,
        // Breadcrumbs) avant le callback onChange. Hot path : ne pas
        // allouer (juste un increment).
        docVersionRef.current++;
        if (onChangeRef.current) {
          onChangeRef.current(u.state.doc.toString());
        }
      }
    });

    // Compute le langId (string) pour snippets + keywords seed.
    // Priorité : path → langFromPath (16 mappings) ; sinon prop language
    // (legacy, dépréciée mais toujours acceptée) ; sinon "typescript" par
    // défaut. NE PAS hardcoder "typescript" quand le caller a passé un
    // language explicite, sinon snippets/keywords ne matchent pas la
    // syntaxe (bug repéré par reviewer LOT 1).
    const langId = path ? langFromPath(path) : language;
    const keywordSeed = KEYWORDS_FOR_LANG[langId] ?? [];

    const state = EditorState.create({
      doc: value ?? "",
      extensions: [
        // ─── Existant (préservé) ─────────────────────────────────
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        indentOnInput(),
        syntaxHighlighting(veilHighlight),
        search(),
        langExt,

        // ─── LOT 1.1 : Multi-cursor + Rectangular Selection ────
        // allowMultipleSelections active le support sous-jacent ; drawSelection
        // rend visuellement chaque curseur secondaire ; rectangularSelection
        // + crosshairCursor active Alt+drag pour sélection rectangulaire.
        EditorState.allowMultipleSelections.of(true),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),

        // ─── LOT 1.3 : Bracket pair colorization (custom) ──────
        bracketPairColors,

        // ─── LOT 1.4 : Autocompletion enrichie ─────────────────
        // Sources : snippets (loader TanStack-backed) + keywords du langage
        // + completeAnyWord (mots déjà présents dans le buffer — fallback
        // crucial avant LSP, sinon override:[…] supprime la complétion par
        // défaut et l'éditeur paraît vide).
        // En LOT 3, LSP completion s'ajoutera devant le reste.
        autocompletion({
          override: [
            snippetCompletionSource(langId),
            completeFromList(keywordSeed),
            completeAnyWord,
          ],
          activateOnTyping: true,
          maxRenderedOptions: 30,
        }),

        // ─── LOT 1.5 : Hover tooltip basique (Lezer node) ──────
        // Smoke test feedback : on désactive ce hover basique pour les
        // langues qui ont un LSP — sinon DEUX bulles s'affichent au survol
        // (la basique "VariableName · useState" + la riche LSP avec types
        // et JSDoc), ce qui parasite visuellement la doc LSP.
        // Pour les langues SANS LSP (markdown, json, css, etc.), on garde
        // le basicHoverTooltip qui reste utile (nom du node Lezer pour les
        // long identifiers et heading texts tronqués).
        ...(isLspSupported(langId) ? [] : [basicHoverTooltip]),

        // ─── LOT 1 (this LOT) : Word wrap Compartment ──────────
        // Singleton module-level — see extensions/wordWrap.ts.
        // Reconfigured via setWordWrap() in the useEffect below, not here;
        // the initial value seeds the Compartment slot so reconfigure works.
        wordWrapCompartment.of(wordWrapInitial(wordWrap)),

        // ─── LOT 1 (this LOT) : Region folding ─────────────────
        // foldService.of(...) is registered here; the actual fold logic
        // lives in extensions/regionFolding.ts.
        regionFoldingService(langId),

        // ─── LOT 3 : LSP plugin compartment (vide initialement) ───
        // Reconfiguré dynamiquement après getLspClient() async ; voir le
        // useEffect ci-dessous. Si le LSP n'est pas dispo (binaire absent,
        // langue non supportée), le compartment reste vide et l'éditeur
        // fonctionne en mode LOT 1+2 (snippets + outline + breadcrumbs).
        lspCompartment.of([] as Extension[]),
        lintGutter(),

        // ─── Keymap (étendu LOT 1.4) ────────────────────────────
        // Note : snippetKeymap est un Facet (extension point pour l'utilisateur),
        // pas un array — les bindings par défaut de snippet (Tab/Esc pour
        // naviguer les tab-stops) sont fournis automatiquement par
        // snippetCompletion() côté autocompletion. Pas besoin de spread.
        //
        // Mod-d → selectNextOccurrence est DÉJÀ dans searchKeymap (CodeMirror
        // 6.7+) ; pas besoin de le re-binder explicitement.
        keymap.of([
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        veilTheme,
        updateListener,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Re-mount only when language extension changes (new file type or new file).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langExt]);

  // Sync external value updates without re-mounting (e.g. setFileContents).
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value ?? "" } });
    }
  }, [value]);

  // LOT 1 — Reconfigure word wrap without re-mounting the editor.
  // Runs whenever the wordWrap prop changes (e.g. Settings toggle or Alt+Z).
  // Cursor position, scroll offset, and undo history are all preserved.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    setWordWrap(view, wordWrap);
  }, [wordWrap]);

  // ── LOT 3 : Attach LSP plugin once the client is ready ──────────────
  //
  // getLspClient() est async (spawn du LSP server côté Rust + handshake
  // initialize). On dispatch un reconfigure du Compartment quand le client
  // est prêt. Si la langue n'est pas supportée OU si le binaire n'est pas
  // installé, getLspClient retourne null et le compartment reste vide
  // (degradation gracieuse — aucune erreur affichée à l'utilisateur).
  //
  // Cancellation : le boolean cancelled évite de dispatcher si le composant
  // a unmount entre le await et le dispatch (e.g. l'utilisateur a changé
  // de fichier pendant la connexion LSP).
  useEffect(() => {
    if (!path) return;
    const langId = path ? langFromPath(path) : language;
    if (!isLspSupported(langId)) return;
    let cancelled = false;
    void (async () => {
      const result = await getLspClient(langId);
      if (cancelled || !result) return;
      const view = viewRef.current;
      if (!view) return;
      const fileUri = fileUriForPath(result.workspaceUri, path);
      try {
        view.dispatch({
          effects: lspCompartment.reconfigure(result.client.plugin(fileUri, langId)),
        });
        diag("lsp", `attached plugin for ${fileUri}`);
      } catch (err) {
        // fmtErr (vs. String(err)) gère les JSON-RPC error objects qui
        // donneraient sinon "[object Object]" — symptôme du smoke test.
        diag("lsp", `dispatch reconfigure failed: ${fmtErr(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, language, lspCompartment]);

  return <div ref={hostRef} className="cm-host" />;
});
