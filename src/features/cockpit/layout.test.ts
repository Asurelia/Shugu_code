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
      bottomDockOpen: true,
      bottomDockSize: 35,
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

  it("default has bottomDockOpen: false and bottomDockSize: 30", () => {
    expect(DEFAULT_LAYOUT.bottomDockOpen).toBe(false);
    expect(DEFAULT_LAYOUT.bottomDockSize).toBe(30);
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

  it("strips 'terminal' from openedSurfaces (moved to bottom dock)", () => {
    const out = normalizeLayout({
      openedSurfaces: ["editor", "terminal", "review"],
    });
    expect(out.openedSurfaces).toEqual(["editor", "review"]);
    // terminal should not appear in the result
    expect(out.openedSurfaces).not.toContain("terminal");
  });

  it("strips 'terminal' as activeSurface and falls back to first opened", () => {
    // Old persisted format with terminal as activeSurface.
    const out = normalizeLayout({
      activeSurface: "terminal",
      openedSurfaces: ["editor", "review"],
    });
    // terminal is not in SURFACES → isSurface returns false → falls to default "editor"
    // "editor" is in openedSurfaces, so it stays.
    expect(out.activeSurface).toBe("editor");
    expect(out.openedSurfaces).not.toContain("terminal");
  });

  it("strips 'terminal' from openedSurfaces when it is the only item", () => {
    // Old format where only terminal was opened — falls back to default.
    const out = normalizeLayout({
      openedSurfaces: ["terminal"],
    });
    expect(out.openedSurfaces).toEqual(DEFAULT_LAYOUT.openedSurfaces);
    expect(out.openedSurfaces).not.toContain("terminal");
  });

  it("coerces activeSurface into openedSurfaces when not present (valid surfaces)", () => {
    // activeSurface=files but it's not in openedSurfaces → reset to first opened
    const out = normalizeLayout({
      activeSurface: "files",
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
    // Old persisted format — no openedSurfaces, bottomDockOpen, or bottomDockSize keys.
    const old = { rightPanelOpen: false, activeSurface: "editor", sizes: [55, 45] };
    const out = normalizeLayout(old);
    expect(out.openedSurfaces).toEqual(DEFAULT_LAYOUT.openedSurfaces);
    expect(out.activeSurface).toBe("editor");
    expect(out.bottomDockOpen).toBe(false);
    expect(out.bottomDockSize).toBe(30);
  });

  // ── bottomDockOpen / bottomDockSize tests ─────────────────────

  it("normalizes bottomDockOpen from boolean", () => {
    expect(normalizeLayout({ bottomDockOpen: true }).bottomDockOpen).toBe(true);
    expect(normalizeLayout({ bottomDockOpen: false }).bottomDockOpen).toBe(false);
  });

  it("falls back to default bottomDockOpen for non-boolean values", () => {
    expect(normalizeLayout({ bottomDockOpen: "yes" }).bottomDockOpen).toBe(DEFAULT_LAYOUT.bottomDockOpen);
    expect(normalizeLayout({ bottomDockOpen: 1 }).bottomDockOpen).toBe(DEFAULT_LAYOUT.bottomDockOpen);
    expect(normalizeLayout({ bottomDockOpen: null }).bottomDockOpen).toBe(DEFAULT_LAYOUT.bottomDockOpen);
  });

  it("accepts valid bottomDockSize in range [12, 100)", () => {
    expect(normalizeLayout({ bottomDockSize: 12 }).bottomDockSize).toBe(12);
    expect(normalizeLayout({ bottomDockSize: 50 }).bottomDockSize).toBe(50);
    expect(normalizeLayout({ bottomDockSize: 99 }).bottomDockSize).toBe(99);
  });

  it("rejects out-of-range or invalid bottomDockSize", () => {
    expect(normalizeLayout({ bottomDockSize: 0 }).bottomDockSize).toBe(DEFAULT_LAYOUT.bottomDockSize);
    expect(normalizeLayout({ bottomDockSize: 11 }).bottomDockSize).toBe(DEFAULT_LAYOUT.bottomDockSize);
    expect(normalizeLayout({ bottomDockSize: 100 }).bottomDockSize).toBe(DEFAULT_LAYOUT.bottomDockSize);
    expect(normalizeLayout({ bottomDockSize: "30" }).bottomDockSize).toBe(DEFAULT_LAYOUT.bottomDockSize);
    expect(normalizeLayout({ bottomDockSize: null }).bottomDockSize).toBe(DEFAULT_LAYOUT.bottomDockSize);
  });
});
