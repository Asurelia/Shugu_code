// Real filesystem wrapper for Shugu Forge.
//
// In Tauri mode: delegates to Rust commands (fs_open_folder, fs_read_dir,
// fs_read_file, fs_write_file) via IPC.
//
// In web mode (pnpm dev): falls back to seed mock data so the UI works without
// a Tauri runtime.  fs_write_file is a silent no-op.
//
// The Rust layer uses a workspace-relative path contract: all paths crossing
// the IPC boundary are forward-slash-normalised strings relative to the
// workspace root (e.g. "src/lib/fs.ts", never "/home/user/project/src/lib/fs.ts").

import { invoke, listen } from "@/lib/tauri";
import type { FileNode, FileContent } from "@/lib/types";
import { seedFileTree } from "@/mocks/seedFileTree";
import { seedFileContents } from "@/mocks/seedFileContents";

export const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// ---------------------------------------------------------------------------
// Language detection (frontend responsibility — Rust stays stateless)
// ---------------------------------------------------------------------------

const LANG_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
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
  c: "c",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  lua: "lua",
};

export function langFromPath(path: string): string {
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

// ---------------------------------------------------------------------------
// FsEntry → FileNode translation
// ---------------------------------------------------------------------------

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

/**
 * Open a native folder picker and set the workspace root.
 *
 * Returns the absolute path of the chosen folder, or null if the user
 * cancelled.  Always returns null in web mode (no file picker available).
 */
export async function fsOpenFolder(): Promise<string | null> {
  if (!inTauri) return null;
  return invoke<string | null>("fs_open_folder");
}

/**
 * Read the recursive directory tree rooted at the current workspace.
 *
 * In web mode returns seedFileTree (prototype data) so the UI renders without
 * a Tauri runtime.
 */
export async function fsReadDir(): Promise<FileNode[]> {
  if (!inTauri) return seedFileTree;
  const entries = await invoke<FsEntry[]>("fs_read_dir");
  return entries.map(fsEntryToFileNode);
}

/**
 * Read a workspace-relative file and return its content wrapped in FileContent.
 *
 * In web mode looks up seedFileContents, falling back to an empty FileContent
 * if the path is unknown.  Never throws.
 */
export async function fsReadFile(path: string): Promise<FileContent> {
  if (!inTauri) {
    return (
      (seedFileContents as Record<string, FileContent>)[path] ?? {
        lang: langFromPath(path),
        text: "",
      }
    );
  }
  const text = await invoke<string>("fs_read_file", { path });
  return { lang: langFromPath(path), text };
}

/**
 * Write content to a workspace-relative file path.
 *
 * Uses atomic write (temp-file + rename) on the Rust side.
 * Silent no-op in web mode — the caller's dirty-flag handling is unaffected.
 */
export async function fsWriteFile(path: string, content: string): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("fs_write_file", { path, content });
}

/**
 * Create a new file at a workspace-relative path with optional initial content.
 *
 * Errors (rejected promise with a string message) if the file already exists
 * or if `path` escapes the workspace root.  Parent directories are created
 * automatically if missing.  Silent no-op in web mode.
 */
export async function fsCreateFile(path: string, content?: string): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("fs_create_file", { path, content });
}

/**
 * Create a directory (and any missing parents) at a workspace-relative path.
 * Idempotent — succeeds if the directory already exists.  Silent no-op in web mode.
 */
export async function fsCreateDir(path: string): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("fs_create_dir", { path });
}

/**
 * Rename / move a workspace-relative path.
 *
 * `from` must exist; `to` must NOT exist (no silent overwrite).  Both must
 * remain inside the workspace.  Silent no-op in web mode.
 */
export async function fsRename(from: string, to: string): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("fs_rename", { from, to });
}

/**
 * Delete a workspace-relative path.  Files are removed directly; directories
 * are deleted recursively without following symlinks.  Silent no-op in web mode.
 */
export async function fsDelete(path: string): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("fs_delete", { path });
}

/**
 * Subscribe to filesystem-change events emitted by the Rust watcher.
 *
 * The handler is invoked once per debounced burst (≈200 ms quiet window)
 * whenever any file under the workspace changes.  The payload is empty —
 * callers should re-fetch the tree via `fsReadDir()` when notified.
 *
 * Returns an unlisten function.  Always returns a no-op unlisten in web mode.
 */
export async function onFsChanged(handler: () => void): Promise<() => void> {
  return listen<void>("fs://changed", () => handler());
}
