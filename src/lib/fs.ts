// Real filesystem wrapper for Shugu Forge.
//
// Delegates to Rust commands (fs_open_folder, fs_read_dir, fs_read_file,
// fs_write_file, fs_create_file, fs_create_dir, fs_rename, fs_delete) via
// IPC. The Rust layer uses a workspace-relative path contract: all paths
// crossing the IPC boundary are forward-slash-normalised strings relative
// to the workspace root (e.g. "src/lib/fs.ts", never the absolute path).
//
// Shugu is Tauri-only — the previous `pnpm dev` web fallback (seedFileTree
// for read, no-op for write) was removed so each function maps 1:1 to a
// Rust command without a degraded-mode branch.

import { invoke } from "@/lib/tauri";
import type { FileNode, FileContent } from "@/lib/types";

// ---------------------------------------------------------------------------
// Language detection (frontend responsibility — Rust stays stateless)
// ---------------------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript", // JSX is enabled in langExtensionFor for all .tsx; LSP uses "typescript"
  js: "javascript",
  jsx: "javascript", // JSX is enabled in langExtensionFor for all .jsx; LSP uses "javascript"
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  htm: "html",      // LOT 1: .htm alias
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  xml: "xml",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  cpp: "cpp",
  cc: "cpp",        // LOT 1: .cc alias for C++
  cxx: "cpp",       // LOT 1: .cxx alias for C++
  c: "c",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  lua: "lua",
  vue: "vue",       // LOT 1: Vue SFC
  svelte: "svelte", // LOT 1: Svelte SFC
  dockerfile: "dockerfile", // LOT 1: Dockerfile (extension-less handled by langFromPath)
};

export function langFromPath(path: string): string {
  // Special case: Dockerfile has no extension — match on basename.
  const basename = path.split("/").pop() ?? path;
  if (basename === "Dockerfile" || basename.endsWith(".dockerfile")) {
    return "dockerfile";
  }
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANG_MAP[ext] ?? "text";
}

// Reverse of LANG_MAP — given a markdown fence lang id (e.g. "rust",
// "typescript", "csharp"), return the canonical file extension to use
// when materializing the snippet on disk. Defaults to "txt" for unknown
// or "text" lang values.
const EXT_FROM_LANG: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  rust:       "rs",
  python:     "py",
  json:       "json",
  markdown:   "md",
  css:        "css",
  scss:       "scss",
  html:       "html",
  toml:       "toml",
  yaml:       "yaml",
  shell:      "sh",
  bash:       "sh",
  sql:        "sql",
  xml:        "xml",
  go:         "go",
  java:       "java",
  kotlin:     "kt",
  swift:      "swift",
  cpp:        "cpp",
  c:          "c",
  csharp:     "cs",
  ruby:       "rb",
  php:        "php",
  lua:        "lua",
};

export function langToExt(lang: string): string {
  return EXT_FROM_LANG[lang.toLowerCase()] ?? "txt";
}

// ---------------------------------------------------------------------------
// FsEntry — shape returned by the Rust fs_read_dir command
// ---------------------------------------------------------------------------

interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FsEntry[];
}

function fsEntryToFileNode(entry: FsEntry): FileNode {
  const node: FileNode = {
    name: entry.name,
    path: entry.path,
  };
  if (entry.is_dir) {
    node.children = entry.children.map(fsEntryToFileNode);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Open a native folder picker; returns the absolute path or null on cancel. */
export async function fsOpenFolder(): Promise<string | null> {
  return invoke<string | null>("fs_open_folder");
}

/**
 * Returns the current workspace root as an absolute, forward-slash path,
 * or null when no workspace is open.
 * Used by `compare-files` to relativize dialog-picked absolute paths.
 */
export async function fsGetWorkspaceRoot(): Promise<string | null> {
  return invoke<string | null>("fs_get_workspace_root");
}

/** Read the recursive directory tree rooted at the current workspace. */
export async function fsReadDir(): Promise<FileNode[]> {
  const entries = await invoke<FsEntry[]>("fs_read_dir");
  return entries.map(fsEntryToFileNode);
}

/** Read a workspace-relative file and return its content wrapped in FileContent. */
export async function fsReadFile(path: string): Promise<FileContent> {
  const text = await invoke<string>("fs_read_file", { path });
  return { lang: langFromPath(path), text };
}

/** Atomic write (temp-file + rename on the Rust side) of a workspace-relative path. */
export async function fsWriteFile(path: string, content: string): Promise<void> {
  await invoke<void>("fs_write_file", { path, content });
}

/**
 * Create a new file at a workspace-relative path with optional initial content.
 * Rejects if the file already exists or if `path` escapes the workspace root.
 * Parent directories are created automatically if missing.
 */
export async function fsCreateFile(path: string, content?: string): Promise<void> {
  await invoke<void>("fs_create_file", { path, content });
}

/** Create a directory (and any missing parents). Idempotent. */
export async function fsCreateDir(path: string): Promise<void> {
  await invoke<void>("fs_create_dir", { path });
}

/** Rename / move a workspace-relative path. `to` must NOT exist (no silent overwrite). */
export async function fsRename(from: string, to: string): Promise<void> {
  await invoke<void>("fs_rename", { from, to });
}

/** Delete a workspace-relative path. Files removed directly; directories recursively (no symlink follow). */
export async function fsDelete(path: string): Promise<void> {
  await invoke<void>("fs_delete", { path });
}

// Note : l'ancien `onFsChanged(handler)` helper a été retiré dans la
// Phase G de la migration TanStack. Le listener `fs://changed` est
// maintenant centralisé dans `src/features/fs/useEvents.ts::useFsEvents`
// qui invalide le cache `fsKeys.tree()` automatiquement. Les consumers
// se branchent via `useFileTree()` au lieu d'attacher un listener.
