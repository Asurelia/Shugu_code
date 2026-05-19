// Tests for blame-decorations.ts — pure logic, no Tauri IPC.
//
// Covers:
//   - `blameCompartment` is a module-level Compartment singleton.
//   - `buildBlameGutter` early-returns `[]` for the off cases.
//   - `buildBlameGutter` returns a non-empty extension list when enabled.
//   - `formatRelativeTime` boundary cases (now, 5m, 2h, 3d, 5w, 2mo, 2y, future).
//   - `firstName` extraction.
//   - `indexBlameByLine` indexing.

import { describe, it, expect } from "vitest";
import { Compartment } from "@codemirror/state";
import {
  blameCompartment,
  buildBlameGutter,
  formatRelativeTime,
  firstName,
  indexBlameByLine,
} from "./blame-decorations";
import type { GitBlameLine } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkLine(overrides: Partial<GitBlameLine> = {}): GitBlameLine {
  return {
    lineNumber: 1,
    oid: "abc1234567890abcdef1234567890abcdef123456",
    shortOid: "abc1234",
    authorName: "Alice Wonderland",
    authorEmail: "alice@example.org",
    timestamp: 1_700_000_000,
    summary: "feat: initial commit",
    isUncommitted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

describe("blameCompartment", () => {
  it("is a Compartment instance", () => {
    expect(blameCompartment).toBeInstanceOf(Compartment);
  });

  it("is the same object on repeated imports (module-level singleton)", async () => {
    // Re-import the same module — ES module cache guarantees identity.
    const { blameCompartment: reimported } = await import("./blame-decorations");
    expect(reimported).toBe(blameCompartment);
  });
});

// ---------------------------------------------------------------------------
// buildBlameGutter
// ---------------------------------------------------------------------------

describe("buildBlameGutter", () => {
  it("returns empty array when blame is null (loading / untracked / no repo)", () => {
    const exts = buildBlameGutter(null, true);
    expect(exts).toEqual([]);
  });

  it("returns empty array when enabled is false (user toggled off)", () => {
    const exts = buildBlameGutter([mkLine()], false);
    expect(exts).toEqual([]);
  });

  it("returns a non-empty extension list when blame is provided and enabled", () => {
    const exts = buildBlameGutter([mkLine()], true);
    expect(exts.length).toBeGreaterThan(0);
  });

  it("returns empty array when both null and disabled (defensive)", () => {
    expect(buildBlameGutter(null, false)).toEqual([]);
  });

  it("handles empty blame array as enabled (zero lines is valid)", () => {
    // Empty file, no blame coverage — should still produce a valid (but
    // visually empty) gutter extension rather than crashing.
    const exts = buildBlameGutter([], true);
    expect(exts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime — boundary cases
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  // Pin "now" so every assertion is deterministic regardless of wall clock.
  const NOW = 1_800_000_000;

  it("returns 'now' for timestamps under a minute old", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("now");
    expect(formatRelativeTime(NOW - 30, NOW)).toBe("now");
    expect(formatRelativeTime(NOW - 59, NOW)).toBe("now");
  });

  it("returns 'Xm' for minute-range timestamps", () => {
    expect(formatRelativeTime(NOW - 60, NOW)).toBe("1m");
    expect(formatRelativeTime(NOW - 5 * 60, NOW)).toBe("5m");
    expect(formatRelativeTime(NOW - 59 * 60, NOW)).toBe("59m");
  });

  it("returns 'Xh' for hour-range timestamps", () => {
    expect(formatRelativeTime(NOW - 60 * 60, NOW)).toBe("1h");
    expect(formatRelativeTime(NOW - 2 * 60 * 60, NOW)).toBe("2h");
    expect(formatRelativeTime(NOW - 23 * 60 * 60, NOW)).toBe("23h");
  });

  it("returns 'Xd' for day-range timestamps", () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60, NOW)).toBe("1d");
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60, NOW)).toBe("3d");
    expect(formatRelativeTime(NOW - 6 * 24 * 60 * 60, NOW)).toBe("6d");
  });

  it("returns 'Xw' for week-range timestamps", () => {
    // Week range is [7d, 30d). At 35d (≥ MONTH=30d) the label rolls over to
    // "1mo", which matches the GitHub-style relative time convention used by
    // every major blame UI. Test the lower bound + a mid-range value.
    expect(formatRelativeTime(NOW - 7 * 24 * 60 * 60, NOW)).toBe("1w");
    expect(formatRelativeTime(NOW - 3 * 7 * 24 * 60 * 60, NOW)).toBe("3w");
    // 29 days = just under MONTH — still in the week bucket as "4w".
    expect(formatRelativeTime(NOW - 29 * 24 * 60 * 60, NOW)).toBe("4w");
  });

  it("returns 'Xmo' for month-range timestamps", () => {
    expect(formatRelativeTime(NOW - 30 * 24 * 60 * 60, NOW)).toBe("1mo");
    expect(formatRelativeTime(NOW - 6 * 30 * 24 * 60 * 60, NOW)).toBe("6mo");
  });

  it("returns 'Xy' for year-range timestamps", () => {
    expect(formatRelativeTime(NOW - 365 * 24 * 60 * 60, NOW)).toBe("1y");
    expect(formatRelativeTime(NOW - 2 * 365 * 24 * 60 * 60, NOW)).toBe("2y");
  });

  it("returns 'future' for timestamps in the future (clock skew safe)", () => {
    expect(formatRelativeTime(NOW + 60, NOW)).toBe("future");
    expect(formatRelativeTime(NOW + 10_000, NOW)).toBe("future");
  });

  it("uses wall-clock Date.now() when nowSecs is omitted", () => {
    // Spot check: a timestamp far in the past should produce some non-empty
    // label other than "future". We don't pin the value because it depends
    // on the test run wall-clock.
    const label = formatRelativeTime(0);
    expect(label).not.toBe("future");
    expect(label).not.toBe("now");
    expect(label.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// firstName
// ---------------------------------------------------------------------------

describe("firstName", () => {
  it("extracts the first whitespace-separated token", () => {
    expect(firstName("Alice Wonderland")).toBe("Alice");
    expect(firstName("Bob")).toBe("Bob");
    expect(firstName("Jean-Luc Picard")).toBe("Jean-Luc");
  });

  it("returns empty string for empty/whitespace input", () => {
    expect(firstName("")).toBe("");
    expect(firstName("   ")).toBe("");
  });

  it("handles multi-word names with extra spaces", () => {
    expect(firstName("  Alice  Wonderland  ")).toBe("Alice");
  });
});

// ---------------------------------------------------------------------------
// indexBlameByLine
// ---------------------------------------------------------------------------

describe("indexBlameByLine", () => {
  it("indexes blame entries by 1-based line number", () => {
    const lines: GitBlameLine[] = [
      { ...mkLine(), lineNumber: 1, oid: "a" },
      { ...mkLine(), lineNumber: 2, oid: "b" },
      { ...mkLine(), lineNumber: 3, oid: "c" },
    ];
    const map = indexBlameByLine(lines);
    expect(map.size).toBe(3);
    expect(map.get(1)?.oid).toBe("a");
    expect(map.get(2)?.oid).toBe("b");
    expect(map.get(3)?.oid).toBe("c");
    expect(map.get(4)).toBeUndefined();
  });

  it("returns an empty map for an empty blame array", () => {
    expect(indexBlameByLine([]).size).toBe(0);
  });
});
