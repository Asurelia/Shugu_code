// Shugu Forge — TanStack queryKey factory pour la feature git.
//
// LOT 2 ajoute le surface complet (status, diff, log, branches, blame,
// stashes, remotes) en plus des deux clés historiques (isRepo, head).
// Les clés restent stables sous `gitKeys.all` → un seul invalidate-all
// continue à toucher la totalité du cache git.

import type { DiffSource } from "@/lib/types";

export const gitKeys = {
  all: ["git"] as const,

  /** Is the current workspace inside a git repository? */
  isRepo: () => [...gitKeys.all, "is-repo"] as const,

  /** HEAD content for a workspace-relative path. */
  head: (path: string) => [...gitKeys.all, "head", path] as const,

  /** Working-tree + index status (vector of GitFileStatus). */
  status: () => [...gitKeys.all, "status"] as const,

  /** Unified-diff text for a single path against `vs` (head | index | worktree). */
  diff: (path: string, vs: DiffSource) =>
    [...gitKeys.all, "diff", path, vs] as const,

  /** Commit log — keyed by (maxCount, branch ?? null) so a branch switch refetches. */
  log: (maxCount: number, branch: string | null) =>
    [...gitKeys.all, "log", maxCount, branch] as const,

  /** Local + remote branch list with ahead/behind counters. */
  branches: () => [...gitKeys.all, "branches"] as const,

  /** Per-line blame for a workspace-relative path. */
  blame: (path: string) => [...gitKeys.all, "blame", path] as const,

  /** Stash entries (chronological, index 0 = newest). */
  stashes: () => [...gitKeys.all, "stashes"] as const,

  /** Configured remotes (name + url + push_url). */
  remotes: () => [...gitKeys.all, "remotes"] as const,
};
