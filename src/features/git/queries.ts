// Shugu Forge — TanStack Query hooks pour la feature git.
//
// Deux hooks exposés :
//   - `useIsGitRepo()` — vrai si le workspace courant est dans un repo git.
//     Résultat mis en cache sans expiration (un workspace root ne change
//     pas de statut repo/non-repo en cours d'usage).
//   - `useGitHead(path)` — contenu HEAD du fichier, ou null quand le
//     fichier est non-traqué / le repo n'a pas encore de commits.
//
// `invalidateGitHead(path)` est exporté pour que `saveFile` dans
// RootLayout.tsx invalide le cache après chaque écriture, afin que les
// décorations inline reflètent immédiatement la nouvelle baseline.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";
import { gitKeys } from "./keys";

// ---------------------------------------------------------------------------
// Is-repo hook
// ---------------------------------------------------------------------------

/**
 * Returns true when the currently open workspace is inside a git repository.
 * Cached indefinitely (repo status doesn't change while the app is running).
 */
export function useIsGitRepo(): boolean {
  const { data } = useQuery<boolean>({
    queryKey: gitKeys.isRepo(),
    queryFn: () => invoke<boolean>("git_is_repo"),
    staleTime: Infinity,
    retry: false,
  });
  return data ?? false;
}

// ---------------------------------------------------------------------------
// HEAD content hook
// ---------------------------------------------------------------------------

/**
 * Returns the HEAD content of a workspace-relative `path`, or `null` when:
 *   - The workspace is not a git repo.
 *   - The file is untracked (new file, not yet committed).
 *   - The repo has no commits yet.
 *
 * The Rust side normalizes CRLF → LF before returning, so the value is
 * always in LF form and safe to compare against editor buffer content.
 *
 * Enabled only when `path` is non-empty.
 */
export function useGitHead(path: string | null): string | null {
  const { data } = useQuery<string | null>({
    queryKey: gitKeys.head(path ?? ""),
    queryFn: () => invoke<string | null>("git_show_head", { path: path! }),
    enabled: Boolean(path),
    staleTime: 0,
    retry: false,
  });
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Imperative invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate HEAD cache for a specific workspace-relative path.
 * Call after writing a file so that the git decorations are refreshed.
 */
export function invalidateGitHead(path: string): void {
  void queryClient.invalidateQueries({ queryKey: gitKeys.head(path) });
}

/**
 * Broad invalidation — invalidates ALL git query cache entries.
 * Used by `useFsEvents` on `fs://changed` to catch external git operations
 * (checkout, reset, commit) that would change HEAD content.
 */
export function invalidateAllGit(): void {
  void queryClient.invalidateQueries({ queryKey: gitKeys.all });
}
