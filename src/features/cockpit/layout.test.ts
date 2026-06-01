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
    const valid = { rightPanelOpen: true, activeSurface: "review", sizes: [60, 40] };
    expect(normalizeLayout(valid)).toEqual(valid);
  });

  it("coerces an unknown surface to the default", () => {
    const out = normalizeLayout({ rightPanelOpen: true, activeSurface: "wat", sizes: [50, 50] });
    expect(out.activeSurface).toBe(DEFAULT_LAYOUT.activeSurface);
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
});
