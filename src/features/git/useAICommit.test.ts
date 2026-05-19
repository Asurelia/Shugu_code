// Tests for the pure helpers in `useAICommit.ts` (truncateDiff,
// sanitizeCommitMessage). The hook itself is React-bound and depends on
// the chat-sync `useActiveModel` + the credentials backend; it's covered
// by manual smoke-test in LOT 3 rather than vitest.

import { describe, it, expect } from "vitest";
import { truncateDiff, sanitizeCommitMessage } from "./useAICommit";

const TRUNCATION_SUFFIX = "\n[... TRUNCATED — original diff exceeded 8000 chars ...]";
const SUFFIX_LEN = TRUNCATION_SUFFIX.length;

describe("truncateDiff", () => {
  it("returns input unchanged when within limit", () => {
    const small = "diff --git a/file b/file\n+ hello\n";
    expect(truncateDiff(small, 8000)).toBe(small);
  });

  it("returns input unchanged when exactly at limit", () => {
    const exact = "a".repeat(8000);
    expect(truncateDiff(exact, 8000)).toBe(exact);
    expect(truncateDiff(exact, 8000).length).toBe(8000);
  });

  it("truncates with suffix when over limit", () => {
    const huge = "a".repeat(20000);
    const out = truncateDiff(huge, 8000);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    // Total length capped at 8000.
    expect(out.length).toBe(8000);
    // The content kept = 8000 - suffix_length characters of 'a'.
    expect(out.startsWith("a".repeat(8000 - SUFFIX_LEN))).toBe(true);
  });

  it("uses default maxLen of 8000 when omitted", () => {
    const huge = "z".repeat(8500);
    const out = truncateDiff(huge);
    expect(out.length).toBe(8000);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("never appends suffix on input shorter than maxLen", () => {
    const small = "x".repeat(100);
    expect(truncateDiff(small, 8000).includes("TRUNCATED")).toBe(false);
  });

  it("handles edge case where maxLen is smaller than suffix", () => {
    // Pathological but defensive — should not throw.
    const out = truncateDiff("abcdefghij", 5);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe("sanitizeCommitMessage", () => {
  it("strips surrounding whitespace", () => {
    expect(sanitizeCommitMessage("  feat: add x  ")).toBe("feat: add x");
  });

  it("keeps only the first non-empty line", () => {
    expect(sanitizeCommitMessage("feat: add x\n\nLonger description here")).toBe(
      "feat: add x",
    );
  });

  it("strips triple-backtick code fence with lang prefix", () => {
    const out = sanitizeCommitMessage("```bash\nfeat(scope): add x\n```");
    expect(out).toBe("feat(scope): add x");
  });

  it("strips triple-backtick code fence without lang", () => {
    const out = sanitizeCommitMessage("```\nfix: bug\n```");
    expect(out).toBe("fix: bug");
  });

  it("strips surrounding double quotes", () => {
    expect(sanitizeCommitMessage('"docs: update README"')).toBe("docs: update README");
  });

  it("strips surrounding single quotes", () => {
    expect(sanitizeCommitMessage("'chore: bump deps'")).toBe("chore: bump deps");
  });

  it("returns empty string when input is empty", () => {
    expect(sanitizeCommitMessage("")).toBe("");
  });

  it("returns empty string when input is whitespace only", () => {
    expect(sanitizeCommitMessage("   \n\n   ")).toBe("");
  });
});
