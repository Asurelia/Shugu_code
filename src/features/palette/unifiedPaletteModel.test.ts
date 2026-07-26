import { describe, expect, it } from "vitest";
import { paletteMatchScore, parsePaletteQuery } from "./unifiedPaletteModel";

describe("parsePaletteQuery", () => {
  it("keeps an ordinary query global", () => {
    expect(parsePaletteQuery("  open file ")).toEqual({
      scope: "all",
      query: "open file",
    });
  });

  it.each([
    ["> git", "commands", "git"],
    ["#src/main", "files", "src/main"],
    ["@  release plan", "conversations", "release plan"],
  ] as const)("routes %s to %s", (raw, scope, query) => {
    expect(parsePaletteQuery(raw)).toEqual({ scope, query });
  });
});

describe("paletteMatchScore", () => {
  it("prefers an exact title over a description-only match", () => {
    expect(paletteMatchScore("Open file", "", "open file")).toBeGreaterThan(
      paletteMatchScore("Workbench", "Open file from disk", "open file"),
    );
  });

  it("supports subsequence matching and rejects unrelated text", () => {
    expect(
      paletteMatchScore("src/features/chat/views-chat.tsx", "", "vchat"),
    ).toBeGreaterThanOrEqual(0);
    expect(paletteMatchScore("README.md", "", "xyz")).toBe(-1);
    expect(
      paletteMatchScore(
        "AI: Review changes",
        "Workbench · relit le diff et signale bugs, sécurité et style",
        "settings",
      ),
    ).toBe(-1);
  });

  it("matches a contiguous workspace path", () => {
    expect(paletteMatchScore("main.tsx", "src", "src/main")).toBeGreaterThanOrEqual(
      0,
    );
  });
});
