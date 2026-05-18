// Shugu Forge — TanStack Query hooks pour grep workspace (LOT 2).
//
// Backend Rust : src-tauri/src/commands/grep.rs::fs_grep_workspace.
// Pattern : useQuery + invalidation sur fs://changed (réutilise useFsEvents).
// Le cache permet de re-faire défiler les résultats sans relancer ripgrep si
// la query+opts sont identiques (cache 30s par défaut TanStack).

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";
import { grepKeys } from "./keys";

/** Options envoyées au backend. camelCase aligné sur le serde du Rust. */
export interface GrepOpts {
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
}

/** Un match individuel retourné par fs_grep_workspace. */
export interface GrepMatch {
  path: string;
  line: number;
  preview: string;
}

/**
 * Hook React : exécute le grep dès que `query` a au moins 2 caractères.
 * Plus court → désactivé pour éviter les recherches massives à chaque
 * keystroke initial.
 *
 * staleTime: 30s — si l'utilisateur change un toggle puis revient, on
 * réutilise le résultat précédent. L'invalidation explicite (cf.
 * `invalidateGrep`) se déclenche sur fs://changed.
 */
export function useGrepWorkspace(
  query: string,
  opts: GrepOpts,
): UseQueryResult<GrepMatch[]> {
  return useQuery({
    queryKey: grepKeys.search(query, opts),
    queryFn: () =>
      invoke<GrepMatch[]>("fs_grep_workspace", {
        query,
        opts: {
          caseSensitive: opts.caseSensitive ?? false,
          regex: opts.regex ?? false,
          maxResults: opts.maxResults ?? 0,
        },
      }),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}

/**
 * Invalide TOUS les caches grep — appelé depuis useFsEvents quand le
 * watcher Rust émet fs://changed (debounced 200 ms). Les résultats grep
 * peuvent être obsolètes après une edit (path ajouté, ligne déplacée).
 */
export function invalidateGrep(): void {
  void queryClient.invalidateQueries({ queryKey: grepKeys.all });
}
