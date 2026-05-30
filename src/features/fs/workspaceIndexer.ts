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

import { fsListFiles, fsReadFile } from "@/lib/fs";
import { vecIndex, vecClear } from "@/lib/vector";
import { chunkSource, chunkId } from "./chunker";
import { db } from "@/lib/db";
import { pushToast } from "@/components/toast";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 200_000;
const INDEX_TTL_MS   = 24 * 60 * 60 * 1000; // 24 h

// Generous budget for the number of code files to index in one pass. Big ML
// repos (Comfyui ≈ 98k entries) blow past the file-tree's 5000 cap, but the
// indexer walks WITHOUT that cap (it's background work) — this budget instead
// bounds the embedding cost. When exceeded, the user is told (toast) rather
// than the index silently truncating or, as before, failing entirely (0 files).
const MAX_INDEX_FILES = 20_000;

// Extensions excluded from indexing — binaries, media, models/datasets, and
// huge lockfiles. Filtered RUST-SIDE (fs_list_files) BEFORE the budget so a
// project full of .safetensors/.png never starves the code budget. The dir
// pruning (node_modules, target, .git…) is the Rust `is_ignored` list, shared
// with the file watcher — no need to re-list dirs here.
const EXCLUDE_EXTS = [
  // images / media
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "tiff", "avif",
  "mp3", "mp4", "wav", "ogg", "flac", "webm", "mov", "avi", "mkv",
  // archives
  "pdf", "zip", "tar", "gz", "br", "7z", "rar", "xz", "zst",
  // compiled / native
  "wasm", "bin", "dll", "so", "dylib", "exe", "o", "a", "lib", "pdb",
  // fonts
  "ttf", "otf", "woff", "woff2", "eot",
  // ML models / weights / datasets (the Comfyui reality)
  "safetensors", "ckpt", "pt", "pth", "onnx", "gguf", "ggml", "bin",
  "npy", "npz", "h5", "hdf5", "pkl", "pickle", "parquet", "arrow",
  // huge / non-useful text. NB: the Rust side extracts the LAST dot-segment as
  // the extension (`foo.min.js` → "js"), so multi-part suffixes like "min.js"
  // would never match — don't list them here. Minified bundles are valid text
  // and get indexed; that's acceptable (rare in source trees we care about).
  "lock", "map",
];

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

// In-flight guard. Without this, the indexer can be invoked concurrently
// (e.g. multiple useEffect triggers at boot) and each invocation would
// walk the entire workspace before the TTL stamp lands → N parallel walks
// blocking the renderer on every IPC vec_index call.
let indexInFlight: Promise<void> | null = null;

/**
 * Index all text files in the current workspace into the "code" vector
 * collection. Gated by a 24-h TTL stored in db.settings — safe to call
 * on every file tree change.
 *
 * Never throws — any failure is logged as a warning.
 */
export async function indexWorkspace(opts?: { force?: boolean }): Promise<void> {
  if (indexInFlight) return indexInFlight;
  indexInFlight = (async () => {
    try {
      await runIndex(opts?.force ?? false);
    } finally {
      indexInFlight = null;
    }
  })();
  return indexInFlight;
}

/**
 * Force un rebuild COMPLET de l'index "code" : purge la collection (supprime les
 * ids whole-file stale d'avant le chunking) puis ré-indexe en chunks en
 * contournant le TTL 24h. Utilisé par l'action « Réindexer le code » pour rendre
 * l'auto-RAG vérifiable à la demande. Retourne le nombre de chunks indexés.
 */
export async function reindexWorkspace(): Promise<number> {
  // Laisse un éventuel index de boot se terminer pour ne pas courser dessus.
  if (indexInFlight) {
    try {
      await indexInFlight;
    } catch {
      /* ignore */
    }
  }
  try {
    await vecClear("code");
  } catch (err) {
    console.warn("[workspaceIndexer] vecClear failed:", err);
  }
  let count = 0;
  indexInFlight = (async () => {
    try {
      count = await runIndex(true);
    } finally {
      indexInFlight = null;
    }
  })();
  await indexInFlight;
  return count;
}

async function runIndex(force = false): Promise<number> {
  let count = 0;
  try {
    // 1. Flat list of code-eligible files (Rust walks WITHOUT the tree cap,
    //    filters binaries/models by extension, and bounds by MAX_INDEX_FILES).
    //    This replaces the old fsReadDir() whole-tree walk, which threw on
    //    >5000 entries → the catch below swallowed it → big projects got a
    //    ZERO-file index. Now they degrade to a (large) partial index instead.
    const { paths, truncated, totalSeen } = await fsListFiles(EXCLUDE_EXTS, MAX_INDEX_FILES);
    if (paths.length === 0) return 0; // no workspace open / nothing to index

    const rootHash = simpleHash(paths);
    const settingKey = `vec.workspace.indexed.${rootHash}`;

    // 2. Check the TTL gate (skipped on a forced rebuild).
    if (!force) {
      const lastIndexed = await db.settings.get(settingKey);
      if (lastIndexed) {
        const elapsed = Date.now() - Number(lastIndexed);
        if (!Number.isNaN(elapsed) && elapsed < INDEX_TTL_MS) {
          return 0; // already indexed within the TTL window
        }
      }
    }

    // 3. Tell the user what's happening — big projects take a while, and a
    //    truncated index must be visible (no silent cap). Forced rebuilds
    //    always announce; the gated boot path only announces on big projects.
    if (truncated) {
      pushToast(
        `Indexation du code : ${paths.length} fichiers (sur ${totalSeen} — au-delà de la limite de ${MAX_INDEX_FILES}, le reste est ignoré).`,
        "info",
        7000,
      );
    } else if (force || paths.length > 2000) {
      pushToast(`Indexation du code : ${paths.length} fichiers…`, "info", 4000);
    }

    // 4. Index each file (best-effort).
    // Yield to the event loop between files so the renderer thread can keep
    // up with chat streaming, fs watcher events, and Tauri IPC traffic. The
    // indexer is background work — slow + responsive UI > fast + frozen UI.
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      try {
        const content = await fsReadFile(path);
        if (content.text.length > MAX_FILE_BYTES) continue; // too large
        if (!content.text.trim()) continue; // empty file
        // Lot 4 — index per symbol-sized chunk instead of one embedding per
        // whole file (coarse). The chunk id encodes the line range so a future
        // retrieval can map a hit back to a location.
        for (const ch of chunkSource(content.text)) {
          await vecIndex("code", chunkId(path, ch), ch.text);
          count++;
        }
      } catch (err) {
        console.warn("[workspaceIndexer] skipping", path, err);
      }
      // Yield every 5 files to keep the UI responsive.
      if (i > 0 && i % 5 === 0) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    // 5. Stamp the settings key so we don't re-index until the TTL expires.
    await db.settings.set(settingKey, String(Date.now()));
  } catch (err) {
    console.warn("[workspaceIndexer] indexWorkspace failed:", err);
  }
  return count;
}
