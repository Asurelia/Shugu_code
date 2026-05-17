// Shugu Forge — TanStack Query hooks pour la feature fs.
//
// Remplace les useState + useEffect async qui live dans RootLayout pour
// charger le file tree. Le pattern :
//   - `useFileTree()` fetch via `fsReadDir` Rust command
//   - `useEvents.ts` listen `fs://changed` (debounced 200ms côté Rust) →
//     invalidateQueries(fsKeys.tree())
//   - Quand l'user ouvre un nouveau dossier via `fsOpenFolder`, on
//     invalide manuellement le cache (cf. `invalidateFileTree` export).
//
// Note : `useFileContent` est plumbed mais pas encore migré dans
// `RootLayout.openFile` (qui garde son setFileContents state pour les
// tabs avec contenu dirty). Phase ultérieure si besoin.

import { useQuery } from "@tanstack/react-query";
import { fsReadDir } from "@/lib/fs";
import { queryClient } from "@/lib/queryClient";
import type { FileNode } from "@/lib/types";
import { fsKeys } from "./keys";

/**
 * Arbre récursif du workspace ouvert. Refetch sur invalidation (cf.
 * `useFsEvents` qui hook le watcher Rust + command palette open-folder).
 *
 * Retourne `[]` si aucun workspace ouvert (Rust command rejette avec
 * "no workspace open" — on swallow l'erreur).
 */
export function useFileTree() {
  return useQuery<FileNode[]>({
    queryKey: fsKeys.tree(),
    queryFn: async () => {
      try {
        return await fsReadDir();
      } catch {
        // "no workspace open" — pas une vraie erreur, juste un état initial.
        return [];
      }
    },
    staleTime: 0,
  });
}

/**
 * Invalide le cache tree — à appeler après une mutation qui change le
 * workspace (e.g. `fsOpenFolder` depuis la command palette). Le watcher
 * Rust gère les changements internes automatiquement via `useFsEvents`.
 */
export function invalidateFileTree(): void {
  void queryClient.invalidateQueries({ queryKey: fsKeys.tree() });
}
