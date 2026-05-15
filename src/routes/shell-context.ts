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
import type { Dispatch, SetStateAction } from "react";

// ─── Shape ────────────────────────────────────────────────────

export interface ShellContextValue {
  messages: any[];
  setMessages: Dispatch<SetStateAction<any[]>>;
  openFiles: string[];
  setOpenFiles: Dispatch<SetStateAction<string[]>>;
  activeFile: string | null;
  setActiveFile: Dispatch<SetStateAction<string | null>>;
  fileContents: any;
  setFileContents: Dispatch<SetStateAction<any>>;
  generations: any[];
  setGenerations: Dispatch<SetStateAction<any[]>>;
  agents: any[];
}

// ─── Context ──────────────────────────────────────────────────

export const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside RootLayout");
  return ctx;
}
