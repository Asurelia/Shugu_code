// Shugu Forge — état observable de l'indexation sémantique du workspace.
//
// L'indexeur (workspaceIndexer.ts) tourne en tâche de fond et pouvait durer
// plusieurs minutes sans AUCUN signal visuel entre le toast de départ et
// celui de fin. Ce store publie la progression pour la statusbar globale
// (« Indexation 234/2000… ») — l'utilisateur voit que Shugu travaille.
//
// Pattern TanStack-as-observable-slot (toast.ts / chatBusy.ts) : pas de
// fetch, setQueryData est l'unique writer.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export interface IndexingState {
  status: "idle" | "running";
  /** Fichiers traités jusqu'ici (≤ total). */
  done: number;
  /** Fichiers à traiter dans cette passe. */
  total: number;
}

const IDLE: IndexingState = { status: "idle", done: 0, total: 0 };
const INDEXING_KEY = ["fs", "indexing"] as const;

function get(): IndexingState {
  return queryClient.getQueryData<IndexingState>(INDEXING_KEY) ?? IDLE;
}

function set(next: IndexingState): void {
  queryClient.setQueryData<IndexingState>(INDEXING_KEY, next);
}

/** Démarre une passe d'indexation de `total` fichiers. */
export function startIndexing(total: number): void {
  set({ status: "running", done: 0, total });
}

/** Publie l'avancement (appelé périodiquement par la boucle d'indexation). */
export function setIndexingProgress(done: number): void {
  const cur = get();
  if (cur.status !== "running") return;
  set({ ...cur, done: Math.min(done, cur.total) });
}

/** Termine la passe (succès OU échec) — la statusbar redevient silencieuse. */
export function finishIndexing(): void {
  if (get().status === "idle") return;
  set(IDLE);
}

/** Lecture réactive pour la statusbar. */
export function useIndexingState(): IndexingState {
  const { data } = useQuery<IndexingState>({
    queryKey: INDEXING_KEY,
    queryFn: get,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? IDLE;
}
