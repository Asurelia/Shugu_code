// src/features/cockpit/layout.test.ts
import { describe, it, expect } from "vitest";
import { normalizeLayout, DEFAULT_LAYOUT } from "./layout";

describe("normalizeLayout", () => {
  it("returns defaults for non-object input", () => {
    expect(normalizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout("nope")).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout(42)).toEqual(DEFAULT_LAYOUT);
  });

  it("keeps a fully valid layout", () => {
    const valid = {
      rightPanelOpen: true,
      activeSurface: "review",
      sizes: [60, 40],
      openedSurfaces: ["editor", "review"],
    };
    expect(normalizeLayout(valid)).toEqual(valid);
  });

  it("coerces an unknown surface to the default", () => {
    const out = normalizeLayout({
      rightPanelOpen: true,
      activeSurface: "wat",
      sizes: [50, 50],
      openedSurfaces: ["editor", "review"],
    });
    expect(out.activeSurface).toBe("editor");
  });

  it("rejects out-of-range or malformed sizes", () => {
    expect(normalizeLayout({ sizes: [0, 100] }).sizes).toEqual(DEFAULT_LAYOUT.sizes);
    expect(normalizeLayout({ sizes: [50] }).sizes).toEqual(DEFAULT_LAYOUT.sizes);
    expect(normalizeLayout({ sizes: "x" }).sizes).toEqual(DEFAULT_LAYOUT.sizes);
  });

  it("fills missing fields from defaults", () => {
    expect(normalizeLayout({ rightPanelOpen: true })).toEqual({
      ...DEFAULT_LAYOUT,
      rightPanelOpen: true,
    });
  });

  // ── openedSurfaces tests ──────────────────────────────────────

  it("default includes openedSurfaces: [editor, review]", () => {
    expect(DEFAULT_LAYOUT.openedSurfaces).toEqual(["editor", "review"]);
  });

  it("deduplicates openedSurfaces", () => {
    const out = normalizeLayout({
      openedSurfaces: ["editor", "editor", "review", "review"],
    });
    expect(out.openedSurfaces).toEqual(["editor", "review"]);
  });

  it("filters invalid surface ids from openedSurfaces", () => {
    const out = normalizeLayout({
      openedSurfaces: ["editor", "bogus", "review", 123],
    });
    expect(out.openedSurfaces).toEqual(["editor", "review"]);
  });

  it("falls back to default when openedSurfaces becomes empty after filtering", () => {
    const out = normalizeLayout({ openedSurfaces: ["bogus", "invalid"] });
    expect(out.openedSurfaces).toEqual(DEFAULT_LAYOUT.openedSurfaces);
  });

  it("falls back to default when openedSurfaces is not an array", () => {
    const out = normalizeLayout({ openedSurfaces: "editor" });
    expect(out.openedSurfaces).toEqual(DEFAULT_LAYOUT.openedSurfaces);
  });

  it("coerces activeSurface into openedSurfaces when not present", () => {
    // activeSurface=terminal but it's not in openedSurfaces → reset to first opened
    const out = normalizeLayout({
      activeSurface: "terminal",
      openedSurfaces: ["editor", "review"],
    });
    expect(out.activeSurface).toBe("editor");
  });

  it("keeps activeSurface when it is within openedSurfaces", () => {
    const out = normalizeLayout({
      activeSurface: "review",
      openedSurfaces: ["editor", "review"],
    });
    expect(out.activeSurface).toBe("review");
  });

  it("migrates old layout (no openedSurfaces field) gracefully", () => {
    // Old persisted format — no openedSurfaces key.
    const old = { rightPanelOpen: false, activeSurface: "editor", sizes: [55, 45] };
    const out = normalizeLayout(old);
    expect(out.openedSurfaces).toEqual(DEFAULT_LAYOUT.openedSurfaces);
    expect(out.activeSurface).toBe("editor");
  });
});
