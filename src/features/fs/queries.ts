// Shugu Forge — TanStack Query hooks pour la feature fs.
//
// L'explorateur charge l'arbre en LAZY, un niveau à l'expansion :
//   - `useDirChildren(path)` fetch via `fs_read_dir_shallow` (sans cap)
//   - `useScopedTree(path)` fetch un sous-arbre récursif (Studio → preview)
//   - `useEvents.ts` listen `fs://changed` → invalidate dir + scoped
//   - open-folder (command palette) → `invalidateFileTree`
//
// L'ancien `useFileTree()` (walk récursif COMPLET via `fs_read_dir`, plafonné
// à 5000 entrées) a été retiré : il faisait échouer silencieusement les gros
// projets (Comfyui 98k). L'indexeur vectoriel utilise désormais `fs_list_files`
// (liste plate, sans cap), Studio `fs_read_dir_scoped` (sous-arbre preview).
//
// Note : `useFileContent` est plumbed mais pas encore migré dans
// `RootLayout.openFile` (qui garde son setFileContents state pour les
// tabs avec contenu dirty). Phase ultérieure si besoin.

import { useQuery } from "@tanstack/react-query";
import { fsReadDirShallow, fsReadDirScoped, fsReadFile } from "@/lib/fs";
import { queryClient } from "@/lib/queryClient";
import type { FileNode, FileContent } from "@/lib/types";
import { fsKeys } from "./keys";

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
 * Sous-arbre récursif d'un sous-chemin du workspace (Studio → `.shugu-forge/
 * preview/`). Lit SEULEMENT ce sous-dossier via `fs_read_dir_scoped` (pas de
 * cap 5000 — découplé de la taille du projet, donc Studio marche même sur
 * Comfyui). Retourne `[]` si le sous-chemin n'existe pas encore (preview pas
 * générée). Rafraîchi par le watcher (`fs://changed` invalide `fsKeys.scoped`).
 */
export function useScopedTree(path: string) {
  return useQuery<FileNode[]>({
    queryKey: fsKeys.scoped(path),
    queryFn: async () => {
      try {
        return await fsReadDirScoped(path);
      } catch {
        return [];
      }
    },
    staleTime: 0,
  });
}

/**
 * « Le workspace a changé, rafraîchis l'arbre. » Invalide le tree complet
 * (`fs_read_dir`, encore lu par d'éventuels consommateurs legacy), les niveaux
 * lazy de l'explorateur (`fsKeys.dir(*)`) ET les sous-arbres scoped Studio
 * (`fsKeys.scoped(*)`). Appelé par open-folder (command palette).
 */
export function invalidateFileTree(): void {
  void queryClient.invalidateQueries({ queryKey: fsKeys.tree() });
  void queryClient.invalidateQueries({ queryKey: [...fsKeys.all, "dir"] });
  void queryClient.invalidateQueries({ queryKey: [...fsKeys.all, "scoped"] });
}

/**
 * Invalide les niveaux lazy de l'explorateur (`fsKeys.dir(*)`) ET les
 * sous-arbres scoped Studio (`fsKeys.scoped(*)`). Appelé sur `fs://changed` :
 * refetch des dossiers ouverts + de la preview Studio, en conservant l'état
 * d'expansion (qui vit dans le state React de SideFiles). Les queries des
 * dossiers fermés sont inactives → pas de refetch inutile.
 */
export function invalidateDirChildren(): void {
  void queryClient.invalidateQueries({ queryKey: [...fsKeys.all, "dir"] });
  void queryClient.invalidateQueries({ queryKey: [...fsKeys.all, "scoped"] });
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
