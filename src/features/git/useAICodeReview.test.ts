// Tests des helpers purs de `useAICodeReview` (truncateReviewDiff,
// buildReviewPrompt). Le hook lui-même est React-bound (useGitStatus +
// useActiveModel + backend credentials) → couvert par le smoke-test runtime.

import { describe, it, expect } from "vitest";
import { truncateReviewDiff, buildReviewPrompt } from "./useAICodeReview";

const TRUNCATION_SUFFIX = "\n[... TRONQUÉ — diff original > 16000 chars ...]";
const SUFFIX_LEN = TRUNCATION_SUFFIX.length;

describe("truncateReviewDiff", () => {
  it("returns input unchanged when within limit", () => {
    const small = "diff --git a/file b/file\n+ hello\n";
    expect(truncateReviewDiff(small, 16000)).toBe(small);
  });

  it("returns input unchanged when exactly at limit", () => {
    const exact = "a".repeat(16000);
    expect(truncateReviewDiff(exact, 16000)).toBe(exact);
    expect(truncateReviewDiff(exact, 16000).length).toBe(16000);
  });

  it("truncates with suffix when over limit", () => {
    const huge = "a".repeat(40000);
    const out = truncateReviewDiff(huge, 16000);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(out.length).toBe(16000);
    expect(out.startsWith("a".repeat(16000 - SUFFIX_LEN))).toBe(true);
  });

  it("uses default maxLen of 16000 when omitted", () => {
    const huge = "z".repeat(20000);
    const out = truncateReviewDiff(huge);
    expect(out.length).toBe(16000);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });

  it("never appends suffix on input shorter than maxLen", () => {
    const small = "x".repeat(100);
    expect(truncateReviewDiff(small, 16000).includes("TRONQUÉ")).toBe(false);
  });

  it("handles edge case where maxLen is smaller than suffix", () => {
    const out = truncateReviewDiff("abcdefghij", 5);
    expect(out.endsWith(TRUNCATION_SUFFIX)).toBe(true);
  });
});

describe("buildReviewPrompt", () => {
  it("embeds the diff verbatim", () => {
    const diff = "diff --git a/x b/x\n+const y = 1;\n";
    expect(buildReviewPrompt(diff).includes(diff)).toBe(true);
  });

  it("instructs to only comment changed lines", () => {
    const out = buildReviewPrompt("diff").toLowerCase();
    expect(out.includes("changed lines")).toBe(true);
  });

  it("asks for severity tags and grouping by file", () => {
    const out = buildReviewPrompt("diff");
    expect(out.includes("[blocker]")).toBe(true);
    expect(out.toLowerCase().includes("group findings by file")).toBe(true);
  });

  it("defines the clean-diff sentinel", () => {
    expect(buildReviewPrompt("diff").includes("No issues found.")).toBe(true);
  });
});
