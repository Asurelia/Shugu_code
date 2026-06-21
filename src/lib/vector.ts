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
