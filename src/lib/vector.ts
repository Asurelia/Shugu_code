// Local semantic-search wrapper over Tauri vec_index / vec_search / vec_delete.

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

// `memory` (AM-2) is the agent's orchestrated memory collection — remembered
// facts + episodic compaction summaries. It mirrors the Rust `ALLOWED_COLLECTIONS`
// allowlist; keep the two in sync.
export type VecCollection =
  | "messages"
  | "docs"
  | "errors"
  | "patterns"
  | "code"
  | "memory";

export interface VecHit {
  id: string;
  distance: number;
}

/**
 * One recalled memory — the payload mapped back from a kNN hit by the Rust
 * `memory_search` command. `kind` is "fact" (remembered after a turn) or
 * "episode" (a compaction summary of older turns).
 */
export interface MemoryHit {
  id: string;
  kind: "fact" | "episode";
  text: string;
  distance: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Embed `text` and upsert it under `id` in the given collection. */
export async function vecIndex(
  collection: VecCollection,
  id: string,
  text: string,
): Promise<void> {
  await invoke<void>("vec_index", { collection, id, text });
}

/** Return the `k` nearest indexed entries to `query` (default k = 8). */
export async function vecSearch(
  collection: VecCollection,
  query: string,
  k = 8,
): Promise<VecHit[]> {
  return invoke<VecHit[]>("vec_search", { collection, query, k });
}

/** Remove the entry identified by `id` from the given collection. */
export async function vecDelete(
  collection: VecCollection,
  id: string,
): Promise<void> {
  await invoke<void>("vec_delete", { collection, id });
}

/** Remove ALL entries from the given collection (used by "réindexer le code"). */
export async function vecClear(collection: VecCollection): Promise<void> {
  await invoke<void>("vec_clear", { collection });
}

/**
 * AM-2 — search the agent's orchestrated memory for the `k` entries most
 * relevant to `query`, mapped back to their human-readable payload. Used by the
 * memory inspector / Diagnostics to browse what the agent has remembered.
 * Returns `[]` when the memory index is empty. Defaults to k = 8.
 */
export async function memorySearch(query: string, k = 8): Promise<MemoryHit[]> {
  return invoke<MemoryHit[]>("memory_search", { query, k });
}

// ---------------------------------------------------------------------------
// Phase 5 — incremental single-file (re)index + standalone semantic search.
//
// These complement the full-walk indexer (workspaceIndexer.ts): the Rust side
// chunks the file with a chunker that is byte-for-byte parity with chunker.ts,
// deletes the file's PRIOR chunk ids precisely (via the vec_code_files side
// table), and inserts the fresh chunks — all atomically. The file watcher calls
// these on save (debounced, off the renderer); these wrappers expose the same
// operations to the UI (e.g. an explicit "reindex this file" action).
// ---------------------------------------------------------------------------

/**
 * (Re)index a single workspace-relative file into the `code` collection.
 * Returns the number of chunks indexed (0 for a no-op: missing / binary /
 * too-large / empty / ineligible file). Throws only on a genuine failure
 * (embedding model not ready, DB error).
 */
export async function vecIndexFile(path: string): Promise<number> {
  return invoke<number>("vec_index_file", { path });
}

/**
 * Remove a single workspace-relative file's chunks from the `code` collection
 * (and its `vec_code_files` tracking row). A file that was never indexed is a
 * clean no-op.
 */
export async function vecRemoveFile(path: string): Promise<void> {
  await invoke<void>("vec_remove_file", { path });
}

/**
 * Standalone semantic search over the indexed `code` collection (k clamped
 * 1..=50 on the Rust side, default 8). Returns `[]` when the index is empty or
 * the embedding model isn't ready — degrades to "no results" rather than
 * throwing.
 */
export async function semanticSearch(query: string, k = 8): Promise<VecHit[]> {
  return invoke<VecHit[]>("semantic_search", { query, k });
}

// ---------------------------------------------------------------------------
// Boot-time diff — reuse the existing index instead of re-embedding everything.
// ---------------------------------------------------------------------------

/** Verdict of {@link vecStalePaths} over a workspace file listing. */
export interface StaleReport {
  /** Files needing (re)indexing: never tracked, or modified since indexed. */
  stale: string[];
  /** Tracked files gone from the listing (empty when it was truncated). */
  deleted: string[];
  /** Files whose existing index is reused as-is. */
  fresh: number;
}

/**
 * Compare the workspace file listing against the `vec_code_files` tracking
 * table (file mtime vs `indexed_at`) and return only what actually needs work.
 * Pass the `truncated` flag from {@link fsListFiles} verbatim — a capped
 * listing disables deletion detection Rust-side (absence proves nothing).
 */
export async function vecStalePaths(
  paths: string[],
  truncated: boolean,
): Promise<StaleReport> {
  return invoke<StaleReport>("vec_stale_paths", { paths, truncated });
}

/**
 * Purge every `code` chunk not tracked by any `vec_code_files` row (orphans
 * from the pre-diff full-walk era, or from deleted files). Returns the number
 * of chunks removed. Cheap when there is nothing to purge.
 */
export async function vecCodeGc(): Promise<number> {
  return invoke<number>("vec_code_gc");
}
