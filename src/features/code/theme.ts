// Shugu Forge — Celestial Veil CodeMirror theme + highlight style.
//
// Extracted from CodeMirrorEditor.tsx so the same theme can be shared
// across multiple CodeMirror surfaces (main editor + DiffView 2-pane).
// React Fast Refresh requires component files to export ONLY React-shaped
// values, so theme/highlight definitions (non-component) live in this
// dedicated module rather than as inline consts in CodeMirrorEditor.

import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// ─── Syntax highlight (Lezer tags → Celestial Veil colors) ────

export const veilHighlight = HighlightStyle.define([
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

// ─── Editor theme (Celestial Veil chrome + selection + cursor) ─

export const veilTheme = EditorView.theme({
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
