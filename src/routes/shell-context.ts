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
}

// ─── Context ──────────────────────────────────────────────────

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside RootLayout");
  return ctx;
}
