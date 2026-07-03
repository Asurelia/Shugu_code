// Shugu Forge — workspace file indexer for semantic search.
//
// Reconciles the current workspace file tree with the "code" vector collection
// so that the command palette's "Search in files" command can run semantic
// queries.
//
// Design decisions:
//   - DIFF, NOT REBUILD: the Rust side tracks every indexed file in
//     `vec_code_files` (chunk ids + `indexed_at` stamp). At boot we ask
//     `vec_stale_paths` which files actually changed while the app was closed
//     (mtime vs stamp) and re-embed ONLY those — the unchanged majority of the
//     index is reused as-is. The old design re-embedded the whole workspace
//     whenever a 24-h TTL keyed by a hash of the file LIST expired — and since
//     any added/removed file changed that hash, in practice it re-indexed at
//     almost every start.
//   - RUST DOES THE FILE WORK: each stale file goes through `vec_index_file`
//     (read + chunk + embed + purge-prior-chunks + record, atomically) — the
//     same hardened path the live file watcher uses. This module only
//     orchestrates and reports progress.
//   - GC: after the reconcile pass, `vec_code_gc` purges chunks no tracking
//     row claims (accumulated by the pre-diff full-walk era, which upserted
//     without ever deleting a changed file's old chunks) — the index shrinks
//     back to exactly what the workspace contains.
//   - BEST-EFFORT: a single file failure never aborts the pass; failures are
//     accumulated and surfaced in ONE summary toast.
//   - SKIP LIST + BUDGET: binary/media/model extensions are filtered Rust-side
//     before the MAX_INDEX_FILES budget; truncation is always announced.

import { fsListFiles } from "@/lib/fs";
import { vecClear, vecIndexFile, vecRemoveFile, vecStalePaths, vecCodeGc } from "@/lib/vector";
import { pushToast } from "@/components/toast";
import { startIndexing, setIndexingProgress, finishIndexing } from "./indexingStore";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Generous budget for the number of files to index in one pass. Big ML repos
// (Comfyui ≈ 98k entries) blow past the file-tree's 5000 cap, but the indexer
// walks WITHOUT that cap (it's background work) — this budget instead bounds the
// LOCAL embedding cost (fastembed = CPU-bound). Phase 7 #10 (option A): the Rust
// side (fs_list_files) now PRIORITISES code/docs > config > data BEFORE applying
// this cap, so when a repo exceeds the budget it's the DATA dumps that drop, not
// the code. When truncated, the user is told (toast) — never a silent cap.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// In-flight guard. Without this, the indexer can be invoked concurrently
// (e.g. multiple useEffect triggers at boot) and each invocation would
// walk the entire workspace before the first pass lands → N parallel walks
// blocking the renderer on every IPC vec_index call.
let indexInFlight: Promise<void> | null = null;

/**
 * Reconcile the "code" vector collection with the current workspace: re-embed
 * only the files that changed since their last indexing, remove entries for
 * deleted files, then GC untracked chunks. Cheap when nothing changed (one
 * file listing + one stat sweep) — safe to call on every boot or workspace
 * switch.
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
 * contournant le diff incrémental. Utilisé par l'action « Réindexer le code »
 * pour rendre l'auto-RAG vérifiable à la demande. Retourne le nombre de chunks
 * indexés.
 */
export async function reindexWorkspace(): Promise<number> {
  // Le guard `indexInFlight` est posé de façon SYNCHRONE (aucun await avant
  // l'assignation) : un indexWorkspace() concurrent — le timer de boot, le
  // listener workspace://changed — rejoint CETTE passe au lieu de se glisser
  // entre le vecClear et le rebuild (où il verrait un index vidé et lancerait
  // une passe complète entrelacée). L'attente de la passe précédente et le
  // vecClear vivent DANS la promesse gardée pour la même raison.
  const prior = indexInFlight;
  let count = 0;
  indexInFlight = (async () => {
    try {
      // Laisse un éventuel index de boot se terminer pour ne pas courser dessus.
      if (prior) {
        try {
          await prior;
        } catch {
          /* ignore */
        }
      }
      try {
        await vecClear("code");
      } catch (err) {
        // SURFACE the failure (AM-2): a silent vecClear means the rebuild keeps
        // stale whole-file ids — the user must know the reindex couldn't start
        // clean.
        console.warn("[workspaceIndexer] vecClear failed:", err);
        pushToast(
          `Réindexation : impossible de purger l'index existant — ${errMsg(err)}. Le rebuild peut garder des entrées périmées.`,
          "error",
          8000,
        );
      }
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
    const { paths, truncated, totalSeen } = await fsListFiles(EXCLUDE_EXTS, MAX_INDEX_FILES);
    if (paths.length === 0) return 0; // no workspace open / nothing to index

    // 2. Diff against the tracked index: only files that are new or modified
    //    since their `indexed_at` stamp need re-embedding; tracked files gone
    //    from the listing need removal. A forced rebuild (post-vecClear) skips
    //    the round-trip — everything is untracked by construction.
    let stale = paths;
    let deleted: string[] = [];
    let fresh = 0;
    if (!force) {
      const report = await vecStalePaths(paths, truncated);
      stale = report.stale;
      deleted = report.deleted;
      fresh = report.fresh;
    }

    // 3. Tell the user what's happening — a big (re)index takes a while, and a
    //    truncated listing must be visible (no silent cap). The routine boot
    //    case (few or no changed files) stays silent: the statusbar progress
    //    is enough.
    if (truncated) {
      pushToast(
        `Indexation : ${paths.length} fichiers (code prioritaire) sur ${totalSeen}. ` +
          `Au-delà de ${MAX_INDEX_FILES}, le reste (données / fichiers divers) est ignoré.`,
        "info",
        7000,
      );
    } else if (force || stale.length > 2000) {
      pushToast(
        `Indexation du code : ${stale.length} fichier(s) à (ré)indexer` +
          (fresh > 0 ? `, ${fresh} inchangés réutilisés` : "") +
          `…`,
        "info",
        4000,
      );
    }

    // 4. Re-embed each stale file (best-effort). `vec_index_file` reads,
    //    chunks, embeds, purges the file's PRIOR chunks and records the new
    //    ones atomically — the same hardened path the live watcher uses.
    // Progression publiée vers la statusbar globale (indexingStore) — la
    // passe peut durer plusieurs minutes sur un gros repo, l'utilisateur
    // doit voir que le travail avance (pas seulement deux toasts éphémères).
    //
    // AM-2 — surface failures instead of swallowing them. We DON'T toast per
    // file (that would spam on a transient embed-model hiccup); we ACCUMULATE
    // the failure count + the first error message and surface ONE summary toast
    // after the walk. A few skipped files is normal (unreadable/binary edge
    // cases); a large fraction failing means the index is degraded and the user
    // must know (e.g. the fastembed model never loaded).
    let failures = 0;
    let firstError = "";
    if (stale.length > 0) {
      startIndexing(stale.length);
      // Yield to the event loop between files so the renderer thread can keep
      // up with chat streaming, fs watcher events, and Tauri IPC traffic. The
      // indexer is background work — slow + responsive UI > fast + frozen UI.
      for (let i = 0; i < stale.length; i++) {
        try {
          count += await vecIndexFile(stale[i]);
        } catch (err) {
          failures++;
          if (!firstError) firstError = errMsg(err);
          console.warn("[workspaceIndexer] skipping", stale[i], err);
        }
        // Yield every 5 files to keep the UI responsive.
        if (i > 0 && i % 5 === 0) {
          setIndexingProgress(i + 1);
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }

    // 5. Drop index entries for files that no longer exist. Rust already
    //    returns `deleted` empty on a truncated listing (absence from a capped
    //    list proves nothing), so this can never purge a live file.
    for (const path of deleted) {
      try {
        await vecRemoveFile(path);
      } catch (err) {
        failures++;
        if (!firstError) firstError = errMsg(err);
        console.warn("[workspaceIndexer] remove failed", path, err);
      }
    }

    // 6. GC chunks no tracking row claims — reclaims the space accumulated by
    //    the pre-diff era (full walks that upserted new chunk ids without ever
    //    deleting a changed file's old ones). One scan; cheap when clean.
    //    ONLY on a clean pass: with failures, the failed files never gained a
    //    tracking row, so their (still useful) legacy chunks look untracked —
    //    GC'ing now would wipe them with nothing to replace them. Worst case:
    //    the embedding model never loaded on the migration boot → 100 % of
    //    files fail → GC would empty the ENTIRE inherited index. The GC simply
    //    runs on the next clean pass instead.
    if (failures === 0) {
      try {
        const purged = await vecCodeGc();
        if (purged > 0) {
          console.info(`[workspaceIndexer] GC: ${purged} chunk(s) orphelins purgés`);
        }
      } catch (err) {
        console.warn("[workspaceIndexer] vec_code_gc failed:", err);
      }
    } else {
      console.warn(
        `[workspaceIndexer] GC sauté : ${failures} échec(s) d'indexation — les chunks hérités des fichiers en échec restent utilisables.`,
      );
    }

    // 6b. Surface accumulated per-file failures. A small number (< 5% AND ≤ 10)
    // is treated as benign noise (odd unreadable files) and only logged; a
    // larger share means the index is meaningfully degraded → an error toast so
    // the user knows semantic search will be incomplete.
    if (failures > 0) {
      const attempted = stale.length + deleted.length;
      const significant = failures > 10 && failures > attempted * 0.05;
      pushToast(
        `Indexation du code : ${failures} fichier(s) sur ${attempted} n'ont pas pu être indexés` +
          (firstError ? ` (ex : ${firstError})` : "") +
          `. La recherche sémantique peut être incomplète.`,
        significant ? "error" : "info",
        significant ? 9000 : 5000,
      );
    }
  } catch (err) {
    // SURFACE the top-level failure (AM-2). This catch fires when the file walk
    // itself throws (fsListFiles) or the stale diff fails — a TOTAL index
    // failure that previously left the user with a silently empty/stale index
    // and no signal. A toast makes "semantic search isn't working" visible.
    console.warn("[workspaceIndexer] indexWorkspace failed:", err);
    pushToast(
      `Indexation du code échouée : ${errMsg(err)}. La recherche sémantique du code est indisponible.`,
      "error",
      9000,
    );
  } finally {
    // Succès, échec ou passe vide : la statusbar redevient silencieuse.
    finishIndexing();
  }
  return count;
}

/** Normalise an unknown caught value into a short, human-readable message. */
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return String(err);
  } catch {
    return "erreur inconnue";
  }
}
