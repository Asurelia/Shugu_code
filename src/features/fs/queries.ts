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
import { fsReadDir, fsReadDirShallow, fsReadFile } from "@/lib/fs";
import { queryClient } from "@/lib/queryClient";
import type { FileNode, FileContent } from "@/lib/types";
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
 * Enfants directs d'UN dossier (lazy tree). `path` = "" pour la racine.
 * `enabled` permet de ne fetch un dossier qu'une fois déplié — l'explorateur
 * charge ainsi un niveau à la fois, sans jamais walk tout l'arbre (donc sans
 * le cap 5000 de `fs_read_dir` qui faisait échouer Comfyui/Shugu_stream).
 *
 * Retourne `[]` si aucun workspace ouvert (Rust rejette "no workspace open").
 */
export function useDirChildren(path: string, enabled = true) {
  return useQuery<FileNode[]>({
    queryKey: fsKeys.dir(path),
    queryFn: async () => {
      try {
        return await fsReadDirShallow(path);
      } catch {
        // "no workspace open" / dossier disparu — état vide, pas une erreur.
        return [];
      }
    },
    enabled,
    staleTime: 0,
  });
}

/**
 * « Le workspace a changé, rafraîchis tout l'arbre. » Invalide À LA FOIS le
 * tree complet (`fs_read_dir` — indexer + Studio) ET les niveaux lazy de
 * l'explorateur (`fsKeys.dir(*)`). Appelé par open-folder (command palette) :
 * sans le second, l'explorateur resterait sur l'ancien dossier (il ne lit plus
 * `fs_read_dir`). Les chemins d'expansion périmés (autre projet) sont inertes.
 */
export function invalidateFileTree(): void {
  void queryClient.invalidateQueries({ queryKey: fsKeys.tree() });
  void queryClient.invalidateQueries({ queryKey: [...fsKeys.all, "dir"] });
}

/**
 * Invalide TOUS les niveaux lazy de l'explorateur (`fsKeys.dir(*)`).
 * Appelé sur `fs://changed` : refetch des dossiers actuellement ouverts
 * (les queries `enabled`), en conservant l'état d'expansion (qui vit dans
 * le state React de SideFiles). Les queries des dossiers fermés sont
 * inactives → pas de refetch inutile.
 */
export function invalidateDirChildren(): void {
  void queryClient.invalidateQueries({ queryKey: [...fsKeys.all, "dir"] });
}

/**
 * Content of a single workspace-relative file, typed with the language
 * inferred from its extension.
 *
 * Used by DiffView to read both sides of a compare operation without
 * going through the RootLayout file-tab machinery (which is for editor
 * tabs, not compare-only reads).
 *
 * Returns `null` while loading or when `path` is falsy (disabled query).
 */
export function useFileContent(path: string | null): FileContent | null {
  const { data } = useQuery<FileContent>({
    queryKey: fsKeys.file(path ?? ""),
    queryFn: () => fsReadFile(path!),
    enabled: Boolean(path),
    // Infinity — DiffView shows a "frozen comparison" snapshot. Without this
    // cap, every fs://changed event (which fires for ANY workspace write,
    // including unrelated format-on-save or snippet creation) would mark
    // the compared content stale → MergeView destroy+recreate on each save.
    // Invalidation is still triggered explicitly via TanStack on saveFile
    // and via invalidateAllFsKeys on fs://changed for relevant paths.
    // Reviewer A LOT 3 MAJOR (75%).
    staleTime: Infinity,
  });
  return data ?? null;
}
