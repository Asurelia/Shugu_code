// Tests for `statusToSt` — pure reduction of a GitFileStatus row to the
// MessageActionFile status used by the chat action card + Env context card.
// The hook itself is a thin `useMemo` that filters clean rows and maps each
// remaining row through this function, so covering the function (plus a
// fixture mirroring the filter+map) covers the hook's logic without mounting
// React / mocking the TanStack git queries. Follows the same style as
// useGitStatusMap.test.ts.

import { describe, it, expect } from "vitest";
import type { GitFileStatus, MessageActionFile } from "@/lib/types";
import { statusToSt } from "./useWorkspaceChanges";

function row(
  partial: Partial<GitFileStatus> & { path: string; indexStatus: string; worktreeStatus: string },
): GitFileStatus {
  return {
    isConflicted: false,
    isStaged: false,
    isUntracked: false,
    ...partial,
  };
}

describe("statusToSt", () => {
  it("untracked → 'add'", () => {
    expect(
      statusToSt(row({ path: "x", indexStatus: "?", worktreeStatus: "?", isUntracked: true })),
    ).toBe("add");
  });

  it("worktree add → 'add'", () => {
    expect(statusToSt(row({ path: "x", indexStatus: " ", worktreeStatus: "A" }))).toBe("add");
  });

  it("worktree delete → 'del'", () => {
    expect(statusToSt(row({ path: "x", indexStatus: " ", worktreeStatus: "D" }))).toBe("del");
  });

  it("worktree modify → 'mod'", () => {
    expect(statusToSt(row({ path: "x", indexStatus: " ", worktreeStatus: "M" }))).toBe("mod");
  });

  it("worktree status wins over index (edited on top of a staged add)", () => {
    expect(statusToSt(row({ path: "x", indexStatus: "A", worktreeStatus: "M" }))).toBe("mod");
  });

  it("staged-only add (worktree clean) → 'add'", () => {
    expect(
      statusToSt(row({ path: "x", indexStatus: "A", worktreeStatus: " ", isStaged: true })),
    ).toBe("add");
  });

  it("staged-only delete (worktree clean) → 'del'", () => {
    expect(
      statusToSt(row({ path: "x", indexStatus: "D", worktreeStatus: " ", isStaged: true })),
    ).toBe("del");
  });

  it("rename / copy / type-change collapse to 'mod'", () => {
    expect(statusToSt(row({ path: "x", indexStatus: "R", worktreeStatus: " ", isStaged: true }))).toBe("mod");
    expect(statusToSt(row({ path: "x", indexStatus: "C", worktreeStatus: " ", isStaged: true }))).toBe("mod");
    expect(statusToSt(row({ path: "x", indexStatus: " ", worktreeStatus: "T" }))).toBe("mod");
  });
});

describe("useWorkspaceChanges file mapping", () => {
  it("filters clean rows and maps the rest (mirrors the hook's useMemo)", () => {
    const fixture: GitFileStatus[] = [
      row({ path: "src/a.ts", indexStatus: "M", worktreeStatus: " ", isStaged: true }),
      row({ path: "src/b.ts", indexStatus: " ", worktreeStatus: "D" }),
      row({ path: "new.ts", indexStatus: "?", worktreeStatus: "?", isUntracked: true }),
      // Clean row must be dropped (no index and no worktree status).
      row({ path: "clean.ts", indexStatus: " ", worktreeStatus: " " }),
    ];

    // Mirror what useWorkspaceChanges does.
    const files: MessageActionFile[] = fixture
      .filter((s) => !(s.worktreeStatus === " " && s.indexStatus === " "))
      .map((s) => ({ name: s.path, st: statusToSt(s), add: 0, rem: 0 }));

    expect(files).toEqual([
      { name: "src/a.ts", st: "mod", add: 0, rem: 0 },
      { name: "src/b.ts", st: "del", add: 0, rem: 0 },
      { name: "new.ts", st: "add", add: 0, rem: 0 },
    ]);
  });
});
