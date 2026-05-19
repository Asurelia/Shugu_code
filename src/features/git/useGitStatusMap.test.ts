// Tests for `computeStatusChar` — pure reduction of a GitFileStatus row
// to a single "headline" character. The hook itself is a thin `useMemo`
// around a loop that calls this function, so covering the function
// covers the Map population logic.

import { describe, it, expect } from "vitest";
import type { GitFileStatus } from "@/lib/types";
import { computeStatusChar } from "./useGitStatusMap";

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

describe("computeStatusChar", () => {
  it("conflicted wins over everything", () => {
    expect(
      computeStatusChar(
        row({ path: "x", indexStatus: "M", worktreeStatus: "M", isConflicted: true }),
      ),
    ).toBe("U");
  });

  it("untracked → '?'", () => {
    expect(
      computeStatusChar(
        row({ path: "x", indexStatus: "?", worktreeStatus: "?", isUntracked: true }),
      ),
    ).toBe("?");
  });

  it("worktree dirty takes precedence over index", () => {
    // Edited locally on top of a staged add.
    expect(
      computeStatusChar(row({ path: "x", indexStatus: "A", worktreeStatus: "M" })),
    ).toBe("M");
  });

  it("worktree delete bubbles up", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: " ", worktreeStatus: "D" })),
    ).toBe("D");
  });

  it("staged add (no worktree change) → 'A'", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: "A", worktreeStatus: " ", isStaged: true })),
    ).toBe("A");
  });

  it("staged modify (no worktree change) → 'M'", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: "M", worktreeStatus: " ", isStaged: true })),
    ).toBe("M");
  });

  it("staged delete (no worktree change) → 'D'", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: "D", worktreeStatus: " ", isStaged: true })),
    ).toBe("D");
  });

  it("rename (R) is normalized to 'M' (no dedicated tree glyph)", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: "R", worktreeStatus: " ", isStaged: true })),
    ).toBe("M");
  });

  it("copy (C) is normalized to 'M'", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: "C", worktreeStatus: " ", isStaged: true })),
    ).toBe("M");
  });

  it("type change (T) is normalized to 'M'", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: " ", worktreeStatus: "T" })),
    ).toBe("M");
  });

  it("nothing to display → null", () => {
    expect(
      computeStatusChar(row({ path: "x", indexStatus: " ", worktreeStatus: " " })),
    ).toBeNull();
  });

  it("Map-style fixture aggregates correctly", () => {
    const fixture: GitFileStatus[] = [
      row({ path: "src/a.ts", indexStatus: "M", worktreeStatus: " ", isStaged: true }),
      row({ path: "src/b.ts", indexStatus: "A", worktreeStatus: " ", isStaged: true }),
      row({ path: "old.ts", indexStatus: "D", worktreeStatus: " ", isStaged: true }),
      row({ path: "new.ts", indexStatus: "?", worktreeStatus: "?", isUntracked: true }),
      row({
        path: "conflict.ts",
        indexStatus: "U",
        worktreeStatus: "U",
        isConflicted: true,
      }),
      // Should NOT appear in the resulting Map (no status to display).
      row({ path: "clean.ts", indexStatus: " ", worktreeStatus: " " }),
    ];

    // Mirror what useGitStatusMap does.
    const m = new Map<string, string>();
    for (const r of fixture) {
      const c = computeStatusChar(r);
      if (c !== null) m.set(r.path, c);
    }

    expect(m.size).toBe(5);
    expect(m.get("src/a.ts")).toBe("M");
    expect(m.get("src/b.ts")).toBe("A");
    expect(m.get("old.ts")).toBe("D");
    expect(m.get("new.ts")).toBe("?");
    expect(m.get("conflict.ts")).toBe("U");
    expect(m.has("clean.ts")).toBe(false);
  });
});
