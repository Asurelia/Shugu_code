// src/features/context-cards/tilesStore.ts
// Store des TUILES ouvertes dans le panneau de droite (façon Claude Code) :
// le menu « Contexte » (chat view) y ajoute des tuiles, le RightPanel (cockpit)
// les lit et les tuile en grille redimensionnable. React Query comme conteneur
// réactif — même idiome que layoutStore.ts (cockpit).
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { CtxTabId } from "./cards";
import { setRightPanelOpen } from "@/features/cockpit/layoutStore";

/** Tuiles possibles = les cartes Contexte + l'explorateur de fichiers + le
 *  terminal (instance dédiée au panneau). */
export type TileId = CtxTabId | "files" | "terminal";

const KEY = ["context", "tiles"] as const;

function read(): TileId[] {
  return queryClient.getQueryData<TileId[]>([...KEY]) ?? [];
}
function write(next: TileId[]): void {
  queryClient.setQueryData<TileId[]>([...KEY], next);
}

/** Ouvre une tuile (ou la laisse si déjà ouverte) ET déplie le panneau droit. */
export function openTile(id: TileId): void {
  const cur = read();
  if (!cur.includes(id)) write([...cur, id]);
  setRightPanelOpen(true);
}

export function closeTile(id: TileId): void {
  write(read().filter((t) => t !== id));
}

export function isTileOpen(id: TileId): boolean {
  return read().includes(id);
}

/** Hook réactif pour le RightPanel + le menu (badges « ouvert »). */
export function useOpenTiles(): TileId[] {
  const { data = [] } = useQuery<TileId[]>({
    queryKey: [...KEY],
    queryFn: () => read(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
