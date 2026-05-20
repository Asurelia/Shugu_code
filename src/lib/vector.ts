// Local semantic-search wrapper over Tauri vec_index / vec_search / vec_delete.

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VecCollection = "messages" | "docs" | "errors" | "patterns" | "code";

export interface VecHit {
  id: string;
  distance: number;
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
