// Shugu Forge — useWorkspaceChanges
//
// Live working-tree change list, derived from the existing TanStack git
// queries (useGitStatus). Used by:
//   - the chat "files modified" action card (Phase 1, latest agent message)
//   - the Env contextual card (Phase 3)
//
// Source of truth is `useGitStatus()` → GitFileStatus[] (authoritative file
// list + index/worktree status chars). We map each entry to the
// MessageActionFile shape the Codex action card renders. Per-line +/- counts
// are intentionally NOT computed here: GitFileStatus carries no numstat, and
// a precise per-file count would need a dedicated numstat command. The card
// shows the real file list + status; counts are surfaced as the file count.

import { useMemo } from "react";
import { useIsGitRepo, useGitStatus } from "./queries";
import type { GitFileStatus, MessageActionFile } from "@/lib/types";

export function statusToSt(s: GitFileStatus): MessageActionFile["st"] {
  if (s.isUntracked) return "add";
  // Prefer the worktree status char; fall back to the index char when the
  // change is staged-only (worktree clean).
  const c = s.worktreeStatus !== " " ? s.worktreeStatus : s.indexStatus;
  if (c === "A") return "add";
  if (c === "D") return "del";
  return "mod";
}

export interface WorkspaceChanges {
  /** Real changed files (forward-slash workspace-relative). */
  files: MessageActionFile[];
  /** Whether the open workspace is a git repo (false → empty list). */
  isRepo: boolean;
  /** Convenience: number of changed files. */
  count: number;
}

export function useWorkspaceChanges(): WorkspaceChanges {
  const isRepo = useIsGitRepo();
  const { data: status = [] } = useGitStatus();

  return useMemo(() => {
    const files: MessageActionFile[] = status
      .filter((s) => !(s.worktreeStatus === " " && s.indexStatus === " "))
      .map((s) => ({ name: s.path, st: statusToSt(s), add: 0, rem: 0 }));
    return { files, isRepo, count: files.length };
  }, [status, isRepo]);
}
