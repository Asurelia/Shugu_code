// Tests for git-decorations.ts — pure logic, no Tauri IPC.

import { describe, it, expect } from "vitest";
import { gitDiffCompartment, buildGitDecorations } from "./git-decorations";
import { Compartment } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

describe("gitDiffCompartment", () => {
  it("is a Compartment instance", () => {
    expect(gitDiffCompartment).toBeInstanceOf(Compartment);
  });

  it("is the same object on repeated imports (module-level singleton)", async () => {
    // Re-import the same module — ES module cache guarantees identity.
    const { gitDiffCompartment: reimported } = await import("./git-decorations");
    expect(reimported).toBe(gitDiffCompartment);
  });
});

// ---------------------------------------------------------------------------
// buildGitDecorations
// ---------------------------------------------------------------------------

describe("buildGitDecorations", () => {
  it("returns empty array when original is null (untracked / no commits)", () => {
    const exts = buildGitDecorations(null, true);
    expect(exts).toEqual([]);
  });

  it("returns empty array when enabled is false (user toggled off)", () => {
    const exts = buildGitDecorations("const x = 1;\n", false);
    expect(exts).toEqual([]);
  });

  it("returns a non-empty extension list when original is provided and enabled", () => {
    const exts = buildGitDecorations("const x = 1;\n", true);
    expect(exts.length).toBeGreaterThan(0);
  });
});
