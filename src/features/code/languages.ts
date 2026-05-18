// Shugu Forge — Central CodeMirror language extension mapper.
//
// LOT 1 — replaces the ad-hoc `langExtForPath` that was local to
// CodeMirrorEditor.tsx (which only handled js/json/md/py). This module
// covers all languages listed in src/lib/fs.ts LANG_MAP and is the single
// source of truth for syntax highlighting configuration.
//
// Usage:
//   import { langExtensionFor } from "@/features/code/languages";
//   const ext = langExtensionFor(langId);  // e.g. langId = "rust"

import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { css } from "@codemirror/lang-css";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { cpp } from "@codemirror/lang-cpp";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { yaml } from "@codemirror/lang-yaml";
import { vue } from "@codemirror/lang-vue";
import { svelte } from "@replit/codemirror-lang-svelte";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";

/**
 * Returns the CodeMirror language extension for a given langId string.
 *
 * The langId is the value returned by `langFromPath` in src/lib/fs.ts
 * (e.g. "rust", "typescript", "python"). Falls back to `[]` (no highlighting)
 * for unknown or unsupported language ids — the editor remains functional.
 *
 * Note: TOML, Dockerfile, and Ruby use `@codemirror/legacy-modes` (stream
 * parsers). They are less precise than Lezer grammars but acceptable for V1.
 * If demand grows, upgrade to dedicated Lezer grammars later.
 */
export function langExtensionFor(langId: string): Extension {
  switch (langId) {
    // JSX is always enabled: a .ts file with JSX is unusual but not harmful,
    // while a .tsx file without JSX breaks syntax highlighting. Since LANG_MAP
    // maps both .ts/.tsx → "typescript" and .js/.jsx → "javascript", we cannot
    // distinguish them here — enabling JSX universally is the safe default.
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ typescript: false, jsx: true });
    case "python":
      return python();
    case "rust":
      return rust();
    case "go":
      return go();
    case "java":
      return java();
    case "c":
    case "cpp":
      return cpp();
    case "php":
      return php();
    case "sql":
      return sql();
    // LANG_MAP collapses .htm→"html" and .scss→"css" before reaching this
    // switch, so only the canonical langIds need cases here.
    case "html":
      return html();
    case "css":
      return css();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "yaml":
      return yaml();
    case "vue":
      return vue();
    case "svelte":
      return svelte();
    case "ruby":
      return StreamLanguage.define(ruby);
    case "toml":
      return StreamLanguage.define(toml);
    case "dockerfile":
      return StreamLanguage.define(dockerFile);
    default:
      // No syntax highlighting — editor is still fully functional.
      return [];
  }
}
