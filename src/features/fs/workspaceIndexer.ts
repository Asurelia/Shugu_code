// Shugu Forge — workspace file indexer for semantic search.
//
// Walks the current workspace file tree and feeds each text file into the
// "code" vector collection so that the command palette's "Search in files"
// command can run semantic queries.
//
// Design decisions:
//   - GATING: uses db.settings to store a per-workspace indexed timestamp
//     (key = "vec.workspace.indexed.<rootHash>"). Only re-indexes if the
//     workspace has not been indexed in the last 24 h — prevents redundant
//     re-indexing on every app restart.
//   - BEST-EFFORT: every vecIndex call is wrapped in try/catch; a single
//     file failure never aborts the entire walk.
//   - SKIP LIST: binary extensions, node_modules, target, .git are skipped.
//   - SIZE LIMIT: files > 200 KB are skipped (fastembed would time out).

import { fsReadDir, fsReadFile } from "@/lib/fs";
import { vecIndex } from "@/lib/vector";
import { db } from "@/lib/db";
import type { FileNode } from "@/lib/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 200_000;
const INDEX_TTL_MS   = 24 * 60 * 60 * 1000; // 24 h

const SKIP_DIRS = new Set(["node_modules", "target", ".git", ".svn", "dist", "build", ".next", "out"]);

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp",
  "pdf", "zip", "tar", "gz", "br", "7z", "rar",
  "wasm", "bin", "dll", "so", "dylib", "exe",
  "mp3", "mp4", "wav", "ogg", "flac", "webm",
  "ttf", "otf", "woff", "woff2",
  "lock",  // package-lock.json / pnpm-lock.yaml are huge and not useful
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isBinaryPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return BINARY_EXTS.has(ext);
}

/** Flatten a FileNode tree into a list of leaf file paths, skipping known junk dirs. */
function collectLeafPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];

  function walk(node: FileNode) {
    if (node.children !== undefined) {
      // It's a directory node.
      const dirName = node.name;
      if (SKIP_DIRS.has(dirName)) return;
      for (const child of node.children) walk(child);
    } else {
      // It's a file node.
      if (!isBinaryPath(node.path)) {
        paths.push(node.path);
      }
    }
  }

  for (const n of nodes) walk(n);
  return paths;
}

/** Simple stable hash of a list of strings — used to detect workspace changes. */
function simpleHash(paths: string[]): string {
  let h = 0;
  for (const p of paths) {
    for (let i = 0; i < p.length; i++) {
      h = (h * 31 + p.charCodeAt(i)) >>> 0;
    }
  }
  return h.toString(16);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Index all text files in the current workspace into the "code" vector
 * collection. Gated by a 24-h TTL stored in db.settings — safe to call
 * on every file tree change.
 *
 * Never throws — any failure is logged as a warning.
 */
export async function indexWorkspace(): Promise<void> {
  try {
    // 1. Read the file tree.
    const tree = await fsReadDir();
    if (tree.length === 0) return; // no workspace open

    // 2. Collect leaf paths and compute a lightweight hash.
    const paths = collectLeafPaths(tree);
    if (paths.length === 0) return;

    const rootHash = simpleHash(paths);
    const settingKey = `vec.workspace.indexed.${rootHash}`;

    // 3. Check the TTL gate.
    const lastIndexed = await db.settings.get(settingKey);
    if (lastIndexed) {
      const elapsed = Date.now() - Number(lastIndexed);
      if (!Number.isNaN(elapsed) && elapsed < INDEX_TTL_MS) {
        return; // already indexed within the TTL window
      }
    }

    // 4. Index each file (best-effort).
    for (const path of paths) {
      try {
        const content = await fsReadFile(path);
        if (content.text.length > MAX_FILE_BYTES) continue; // too large
        if (!content.text.trim()) continue; // empty file
        await vecIndex("code", path, content.text);
      } catch (err) {
        console.warn("[workspaceIndexer] skipping", path, err);
      }
    }

    // 5. Stamp the settings key so we don't re-index until the TTL expires.
    await db.settings.set(settingKey, String(Date.now()));
  } catch (err) {
    console.warn("[workspaceIndexer] indexWorkspace failed:", err);
  }
}
