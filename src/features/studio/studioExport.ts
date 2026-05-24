// Shugu Forge — Design Studio export (Phase H).
//
// Turns the disposable, gitignored .shugu-forge/preview/ project into a REAL,
// reusable project: copies it to a named folder in the workspace, where git
// tracks it and the editor/build can use it. Pure fs reads/writes — no new
// dependency, no Rust. fsWriteFile creates parent dirs (write_file_inner →
// create_dir_all), so copying each leaf to `${dest}/${rel}` is enough.
//
// Text projects only: the generator emits HTML/CSS/JS (written via the agent's
// fs_write_file, which is text). Binary assets would need a Rust byte-copy —
// noted for a later increment.

import { fsReadFile, fsWriteFile } from "@/lib/fs";
import type { FileNode } from "@/lib/types";

const PREVIEW_DIR = ".shugu-forge/preview";

export interface ExportLeaf {
  /** Path relative to the preview root, e.g. "styles.css" or "assets/app.js". */
  rel: string;
  /** Full workspace-relative path, e.g. ".shugu-forge/preview/styles.css". */
  path: string;
}

/** Flatten the preview subtree to leaf files (recursive into subfolders). */
export function flattenLeaves(nodes: FileNode[]): ExportLeaf[] {
  const out: ExportLeaf[] = [];
  const walk = (ns: FileNode[]) => {
    for (const n of ns) {
      if (n.children) {
        walk(n.children);
      } else {
        const rel = n.path.startsWith(`${PREVIEW_DIR}/`)
          ? n.path.slice(PREVIEW_DIR.length + 1)
          : n.name;
        out.push({ rel, path: n.path });
      }
    }
  };
  walk(nodes);
  return out;
}

/** A filesystem-safe folder name derived from a brief (fallback provided). */
export function slugifyName(s: string): string {
  const base = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "design-export";
}

/**
 * Copy every leaf to `${destDir}/${rel}` (workspace-relative). Returns the
 * number of files written. Throws on the first failed read/write so the caller
 * can surface a real error rather than a partial silent copy.
 */
export async function exportToWorkspace(leaves: ExportLeaf[], destDir: string): Promise<number> {
  let n = 0;
  for (const leaf of leaves) {
    const content = await fsReadFile(leaf.path);
    await fsWriteFile(`${destDir}/${leaf.rel}`, content.text);
    n++;
  }
  return n;
}
