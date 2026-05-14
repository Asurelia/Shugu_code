// Local semantic-search wrapper over Tauri vec_index / vec_search / vec_delete.
// In web mode (pnpm dev without Tauri), all calls no-op gracefully.

import { invoke } from "@/lib/tauri";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  if (!inTauri) return;
  await invoke<void>("vec_index", { collection, id, text });
}

/**
 * Return the `k` nearest indexed entries to `query` (default k = 8).
 * Returns an empty array in web mode.
 */
export async function vecSearch(
  collection: VecCollection,
  query: string,
  k = 8,
): Promise<VecHit[]> {
  if (!inTauri) return [];
  return invoke<VecHit[]>("vec_search", { collection, query, k });
}

/** Remove the entry identified by `id` from the given collection. */
export async function vecDelete(
  collection: VecCollection,
  id: string,
): Promise<void> {
  if (!inTauri) return;
  await invoke<void>("vec_delete", { collection, id });
}
