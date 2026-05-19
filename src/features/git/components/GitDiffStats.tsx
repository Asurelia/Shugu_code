// Shugu Forge — GitDiffStats (LOT 3 git-ui).
//
// File-count headline for the IDE statusbar. We deliberately do NOT count
// added/removed lines : doing so would require running `gitDiffFile` for
// every dirty file on every status refresh (= O(n) IPC + libgit2 walks on
// a hot path that ticks on every save). The far cheaper signal — number
// of modified files split staged / unstaged — gives the user the same
// "do I have local changes?" cue at a glance.
//
// Renders nothing when there are zero changes (avoid statusbar noise).

import { useGitStatus } from "@/features/git/queries";

export function GitDiffStats(): JSX.Element | null {
  const { data } = useGitStatus();
  const rows = data ?? [];
  if (rows.length === 0) return null;

  let staged = 0;
  let dirty = 0;
  for (const r of rows) {
    if (r.isStaged) staged++;
    // worktreeStatus is the local-tree side; isUntracked counts here too.
    if (r.worktreeStatus !== " " || r.isUntracked) dirty++;
  }

  if (staged === 0 && dirty === 0) return null;

  return (
    <span className="item git" title="Files with staged / unstaged changes">
      {staged > 0 && `+${staged}`}
      {staged > 0 && dirty > 0 && " "}
      {dirty > 0 && `~${dirty}`}
    </span>
  );
}
