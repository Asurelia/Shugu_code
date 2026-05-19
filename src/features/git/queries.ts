// Shugu Forge — TanStack Query hooks pour la feature git.
//
// Hooks de lecture (queries). Les mutations vivent dans `mutations.ts`.
//
// Hooks pré-existants (LOT 1 baseline) :
//   - `useIsGitRepo()` — vrai si le workspace courant est dans un repo git.
//     Résultat mis en cache sans expiration (un workspace root ne change
//     pas de statut repo/non-repo en cours d'usage).
//   - `useGitHead(path)` — contenu HEAD du fichier, ou null quand le
//     fichier est non-traqué / le repo n'a pas encore de commits.
//
// Hooks LOT 2 (new) — exposent le reste du surface git :
//   - `useGitStatus`, `useGitDiff`, `useGitLog`, `useGitBranches`,
//     `useGitBlame`, `useGitStashes`, `useGitRemotes`.
//
// Toutes les nouvelles queries sont gated par `useIsGitRepo()` via `enabled`
// pour ne pas spammer le backend hors d'un repo. La staleTime varie :
//   - 0 (live)  : status, diff, branches, stashes, remotes — invalidés par
//                 le watcher `git://changed` (cf. `useEvents.ts`).
//   - 5min      : log (un commit hors-bande est rare et over-invalidation
//                 par `fs://changed` couvre déjà la plupart des cas).
//   - Infinity  : blame (la baseline d'un fichier change rarement et
//                 chaque appel re-lance libgit2 sur le contenu complet).
//
// `invalidateGitHead(path)` et `invalidateAllGit()` sont exportés pour
// que `saveFile` et `useFsEvents` invalident le cache au bon grain.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";
import { gitKeys } from "./keys";
import {
  gitStatus,
  gitDiffFile,
  gitLog,
  gitBranches,
  gitBlame,
  gitStashList,
  gitRemotes,
} from "@/lib/git";
import type {
  DiffSource,
  GitBlameLine,
  GitBranchList,
  GitFileStatus,
  GitLogEntry,
  GitRemote,
  GitStash,
} from "@/lib/types";

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
    // 5 minutes — HEAD content only changes on explicit commit/push/reset.
    // `invalidateGitHead(path)` is called in saveFile, and `invalidateAllGit`
    // fires on fs://changed (catches external git ops). staleTime: 0 would
    // refetch on every tab switch (each spawning `git show` subprocess).
    // Triangulated by Reviewer A (90%) + Reviewer B (85%) LOT 3.
    staleTime: 5 * 60_000,
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

// ---------------------------------------------------------------------------
// LOT 2 — read hooks for the full git surface.
// All gated by `useIsGitRepo()` so a non-git workspace never hits the
// backend.
// ---------------------------------------------------------------------------

/**
 * Working-tree + index status. `staleTime: 0` because every save and every
 * external git op affects this; the `git://changed` watcher (and
 * over-invalidation from `fs://changed`) refresh it.
 */
export function useGitStatus() {
  const isRepo = useIsGitRepo();
  return useQuery<GitFileStatus[]>({
    queryKey: gitKeys.status(),
    queryFn: gitStatus,
    enabled: isRepo,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Unified-diff text for a single path against one of the three sources
 * ("head" | "index" | "worktree"). Empty `path` is allowed and returns the
 * full repo diff (the Rust `DiffOptions::pathspec("")` is treated as no
 * filter by libgit2). `staleTime: 0` because hunks are user-facing and
 * change as soon as the file is saved.
 */
export function useGitDiff(path: string | null, vs: DiffSource) {
  const isRepo = useIsGitRepo();
  return useQuery<string>({
    queryKey: gitKeys.diff(path ?? "", vs),
    queryFn: () => gitDiffFile(path ?? "", vs),
    enabled: isRepo && path !== null,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Commit log — `branch` is optional (HEAD when null/undefined). `staleTime:
 * 5min` because new commits are deliberate user actions; the watcher
 * invalidates on `git://changed` so a fresh commit shows up immediately.
 */
export function useGitLog(maxCount: number, branch?: string | null) {
  const isRepo = useIsGitRepo();
  const branchKey = branch ?? null;
  return useQuery<GitLogEntry[]>({
    queryKey: gitKeys.log(maxCount, branchKey),
    queryFn: () => gitLog(maxCount, branchKey),
    enabled: isRepo && maxCount > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Local + remote branches with ahead/behind counters. `staleTime: 0` so a
 * `git checkout` outside Shugu propagates fast.
 */
export function useGitBranches() {
  const isRepo = useIsGitRepo();
  return useQuery<GitBranchList>({
    queryKey: gitKeys.branches(),
    queryFn: gitBranches,
    enabled: isRepo,
    staleTime: 0,
    retry: false,
  });
}

/**
 * Per-line blame. `staleTime: Infinity` — the blame for a tracked file
 * really only changes on the next commit, and libgit2's blame is the
 * heaviest call in this module (O(history × file_size)). Refresh comes
 * via `invalidateAllGit()` on `git://changed` / `fs://changed`.
 */
export function useGitBlame(path: string | null) {
  const isRepo = useIsGitRepo();
  return useQuery<GitBlameLine[]>({
    queryKey: gitKeys.blame(path ?? ""),
    queryFn: () => gitBlame(path!),
    enabled: isRepo && Boolean(path),
    staleTime: Infinity,
    retry: false,
  });
}

/** Stash entries (chronological, index 0 = newest). */
export function useGitStashes() {
  const isRepo = useIsGitRepo();
  return useQuery<GitStash[]>({
    queryKey: gitKeys.stashes(),
    queryFn: gitStashList,
    enabled: isRepo,
    staleTime: 0,
    retry: false,
  });
}

/** Configured remotes (name + fetch URL + optional push URL). */
export function useGitRemotes() {
  const isRepo = useIsGitRepo();
  return useQuery<GitRemote[]>({
    queryKey: gitKeys.remotes(),
    queryFn: gitRemotes,
    enabled: isRepo,
    staleTime: 0,
    retry: false,
  });
}
