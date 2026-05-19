// Shugu Forge — ShellContext + useShell, extracted from RootLayout.tsx.
//
// React Fast Refresh requires a module to export ONLY component-shaped
// values to be HMR-friendly. Mixing a hook (`useShell`) and a component
// (`RootLayout`) in the same file forced Vite to fall back to a full page
// reload on every edit, which in turn left the Tauri webview in a partial
// state where routes mounted before RootLayout had remounted its Provider —
// producing intermittent "useShell must be used inside RootLayout" errors.
//
// Keeping the hook + context in this dedicated module restores clean HMR
// for RootLayout.tsx.

import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type { CodeMirrorEditorHandle } from "@/features/code/CodeMirrorEditor";

// ─── Editor preferences ───────────────────────────────────────
//
// LOT 1 — lifted into ShellContext so in-window propagation works.
// localStorage does NOT fire `storage` events in the same window;
// putting prefs here is the only way to keep the live editor in sync
// when the user toggles a setting inside the same Tauri window.
//
// Derogation from `feedback_tanstack_mandatory`: these are pure UI-state
// values (no async fetch, no network). Pattern mirrors DEFAULT_INTERFACE in
// settings-extras.tsx. Justified in the TanStack usage map (plan section).

export interface EditorPrefs {
  wordWrap: boolean;
  stickyScroll: boolean;
  minimap: boolean;
  formatOnSave: boolean;
  gitDecorations: boolean;
}

export const DEFAULT_EDITOR_PREFS: EditorPrefs = {
  wordWrap: false,
  stickyScroll: true,
  minimap: true,
  formatOnSave: true,
  gitDecorations: true,
};

// ─── Shape ────────────────────────────────────────────────────

export interface ShellContextValue {
  openFiles: string[];
  setOpenFiles: Dispatch<SetStateAction<string[]>>;
  activeFile: string | null;
  setActiveFile: Dispatch<SetStateAction<string | null>>;
  fileContents: any;
  setFileContents: Dispatch<SetStateAction<any>>;
  generations: any[];
  setGenerations: Dispatch<SetStateAction<any[]>>;
  agents: any[];
  /**
   * Take a code snippet (e.g. from a chat AI reply's CodeBlock) and open it
   * as a real file in the editor. Writes to `.shugu-snippets/snippet-<ts>.<ext>`
   * under the current workspace, then opens that path as a tab and navigates
   * to /code. The file is real on disk so the user can edit + save normally.
   */
  openSnippetInEditor: (code: string, lang: string) => Promise<void>;
  /**
   * Ref to the active CodeMirror editor. Only populated while the /code route
   * is mounted. Used by find-in-file / replace-in-file commands to open the
   * search panel programmatically.
   */
  editorViewRef?: RefObject<CodeMirrorEditorHandle>;

  // ─── LOT 2 : Find-in-files panel state ─────────────────────────────
  // Piloté par la commande `search-in-files` (Cmd+Shift+F) — voir
  // src/lib/commands.ts:447 et src/features/code/FindPanel.tsx.
  findPanelOpen: boolean;
  setFindPanelOpen: Dispatch<SetStateAction<boolean>>;

  // ─── LOT 2 : Open file (read+open+focus) ───────────────────────────
  // Lifted depuis RootLayout pour que FindPanel puisse ouvrir un fichier
  // depuis un résultat grep même s'il n'est pas dans openFiles. Sans ça,
  // setActiveFile sur un path absent de fileContents montre "No file open".
  // Async : fait fsReadFile en interne avant d'ouvrir le tab.
  openFile: (path: string) => Promise<void>;

  // ─── LOT 1 : Editor preferences ─────────────────────────────────────
  // Source of truth for all editor toggle prefs. Persisted via saveJSON on
  // each mutation; hydrated from loadJSON at RootLayout mount. Passed as
  // props to CodeMirrorEditor to drive Compartment reconfigures.
  editorPrefs: EditorPrefs;
  setEditorPref: <K extends keyof EditorPrefs>(key: K, value: EditorPrefs[K]) => void;

  // ─── LOT 3 : Compare mode ────────────────────────────────────────────
  // When set, the code view renders a 2-pane MergeView instead of the
  // single CodeMirrorEditor. Both paths are workspace-relative. Cleared by
  // the `close-compare` command or when the user switches the active file.
  compareFile: { left: string; right: string } | null;
  setCompareFile: Dispatch<SetStateAction<{ left: string; right: string } | null>>;
}

// ─── Context ──────────────────────────────────────────────────

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside RootLayout");
  return ctx;
}
