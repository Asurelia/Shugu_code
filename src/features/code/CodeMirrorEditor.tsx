// Shugu Forge — CodeMirror 6 React host (ESM imports, no CDN, no window globals).
// Replaces the proto's window.mountCodeMirror bootstrap.

import { useEffect, useRef } from "react";
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
import { javascript } from "@codemirror/lang-javascript";
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

export function CodeMirrorEditor({
  value,
  onChange,
  language = "typescript",
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
        javascript({ typescript: language === "typescript", jsx: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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
    // Re-mount only when value identity changes (open a different file).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

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
}
