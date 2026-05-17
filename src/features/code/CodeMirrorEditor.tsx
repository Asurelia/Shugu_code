// Shugu Forge — CodeMirror 6 React host (ESM imports, no CDN, no window globals).
// Replaces the proto's window.mountCodeMirror bootstrap.

import { useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  foldGutter,
} from "@codemirror/language";
import { search, searchKeymap, openSearchPanel } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { tags } from "@lezer/highlight";

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

/** Derive the CodeMirror language extension from the file path extension. */
function langExtForPath(path?: string): ReturnType<typeof javascript> | ReturnType<typeof json> | ReturnType<typeof markdown> | ReturnType<typeof python> {
  const ext = path ? path.split(".").pop()?.toLowerCase() : undefined;
  switch (ext) {
    case "json":  return json();
    case "md":    return markdown();
    case "py":    return python();
    default:      return javascript({ typescript: true, jsx: true });
  }
}

/** Handle type exposed to parents via forwardRef / useImperativeHandle. */
export interface CodeMirrorEditorHandle {
  getView(): EditorView | null;
  openSearch(): void;
}

export const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, {
  value: string;
  onChange?: (v: string) => void;
  /** Full file path (used to pick the language extension). Fallback: typescript. */
  path?: string;
  /** @deprecated Pass `path` instead — kept for callers not yet sending a path. */
  language?: string;
}>(function CodeMirrorEditor({ value, onChange, path, language = "typescript" }, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Re-compute language extension only when path (or legacy language) changes.
  const langExt = useMemo(() => {
    // If a full path is available, prefer path-based dispatch.
    if (path) return langExtForPath(path);
    // Fallback: honour the legacy `language` prop.
    switch (language) {
      case "json":     return json();
      case "markdown": return markdown();
      case "python":   return python();
      default:         return javascript({ typescript: language === "typescript", jsx: true });
    }
  }, [path, language]);

  // Expose getView() and openSearch() to parent refs.
  useImperativeHandle(ref, () => ({
    getView() { return viewRef.current; },
    openSearch() {
      if (viewRef.current) openSearchPanel(viewRef.current);
    },
  }), []);

  useEffect(() => {
    if (!hostRef.current) return;
    const updateListener = EditorView.updateListener.of((u) => {
      if (u.docChanged && onChangeRef.current) {
        onChangeRef.current(u.state.doc.toString());
      }
    });
    const state = EditorState.create({
      doc: value ?? "",
      extensions: [
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
        keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
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

  return <div ref={hostRef} className="cm-host" />;
});
