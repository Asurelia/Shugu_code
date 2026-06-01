// src/features/cockpit/surfaces.test.ts
import { describe, it, expect } from "vitest";
import { SURFACE_META, SURFACE_MENU, surfaceLabel } from "./surfaces";
import { SURFACES } from "./layout";

describe("surfaces registry", () => {
  it("has metadata for every SurfaceId", () => {
    for (const id of SURFACES) {
      expect(SURFACE_META[id]).toBeDefined();
      expect(SURFACE_META[id].id).toBe(id);
      expect(typeof SURFACE_META[id].label).toBe("string");
    }
  });

  it("menu lists editor and review as available (not comingSoon)", () => {
    const editor = SURFACE_MENU.find((s) => s.id === "editor");
    const review = SURFACE_MENU.find((s) => s.id === "review");
    expect(editor?.comingSoon).toBeFalsy();
    expect(review?.comingSoon).toBeFalsy();
  });

  it("menu marks terminal/files/browser as comingSoon (Lot C4)", () => {
    for (const id of ["terminal", "files", "browser"] as const) {
      expect(SURFACE_MENU.find((s) => s.id === id)?.comingSoon).toBe(true);
    }
  });

  it("surfaceLabel returns the label", () => {
    expect(surfaceLabel("editor")).toBe("Éditeur");
    expect(surfaceLabel("review")).toBe("Révision");
  });
});
