import { describe, expect, it } from "vitest";
import {
  BRAND_NODE_ID,
  LIVE_HOME_ID,
  addExplorationFrame,
  bringToFront,
  clampZoom,
  createDefaultDoc,
  ensureCoreNodes,
  getSelectedNode,
  moveNode,
  parseCanvasDoc,
  renameNode,
  resizeNode,
  selectNode,
  setCamera,
  zoomAt,
} from "./studioCanvasDoc";

describe("studioCanvasDoc", () => {
  it("createDefaultDoc places brand + live home with sensible geometry", () => {
    const doc = createDefaultDoc();
    expect(doc.version).toBe(1);
    expect(doc.nodes).toHaveLength(2);
    const brand = doc.nodes.find((n) => n.id === BRAND_NODE_ID);
    const live = doc.nodes.find((n) => n.id === LIVE_HOME_ID);
    expect(brand?.kind).toBe("brand");
    expect(live?.kind).toBe("live");
    // Live home mirrors the open workspace URL (no forge silo route).
    expect(live?.route).toBeUndefined();
    expect(live!.width).toBeGreaterThanOrEqual(320);
    expect(live!.height).toBeGreaterThanOrEqual(240);
    // Brand sits to the left of the product frame (board reading order).
    expect(brand!.x).toBeLessThan(live!.x);
  });

  it("parseCanvasDoc rejects garbage and accepts a minimal valid payload", () => {
    expect(parseCanvasDoc(null)).toBeNull();
    expect(parseCanvasDoc({ version: 2 })).toBeNull();
    expect(parseCanvasDoc({ version: 1, camera: { x: 0, y: 0, zoom: 1 }, nodes: [] })).toBeNull();

    const ok = parseCanvasDoc({
      version: 1,
      camera: { x: 10, y: 20, zoom: 9 }, // zoom must clamp
      selectedId: "a",
      nodes: [{ id: "a", kind: "live", name: "Home", x: 0, y: 0, width: 10, height: 10, zIndex: 1, route: "index.html" }],
    });
    expect(ok).not.toBeNull();
    expect(ok!.camera.zoom).toBeLessThanOrEqual(2.5);
    expect(ok!.nodes[0].width).toBeGreaterThanOrEqual(80); // min size enforced
  });

  it("move/resize/rename/select mutate only the targeted node", () => {
    let doc = createDefaultDoc();
    const otherX = doc.nodes.find((n) => n.id === BRAND_NODE_ID)!.x;
    doc = moveNode(doc, LIVE_HOME_ID, 100, 200);
    expect(doc.nodes.find((n) => n.id === LIVE_HOME_ID)).toMatchObject({ x: 100, y: 200 });
    expect(doc.nodes.find((n) => n.id === BRAND_NODE_ID)!.x).toBe(otherX);

    doc = resizeNode(doc, LIVE_HOME_ID, 40, 40); // below min → clamped
    const live = doc.nodes.find((n) => n.id === LIVE_HOME_ID)!;
    expect(live.width).toBe(80);
    expect(live.height).toBe(60);

    doc = renameNode(doc, LIVE_HOME_ID, "  Landing  ");
    expect(doc.nodes.find((n) => n.id === LIVE_HOME_ID)!.name).toBe("Landing");

    doc = selectNode(doc, BRAND_NODE_ID);
    expect(getSelectedNode(doc)?.kind).toBe("brand");
    doc = selectNode(doc, "missing");
    expect(doc.selectedId).toBeNull();
  });

  it("zoomAt keeps the world point under the cursor stable", () => {
    const doc = setCamera(createDefaultDoc(), { x: 0, y: 0, zoom: 1 });
    // Point at screen (100, 100) → world (100, 100) at zoom 1.
    const next = zoomAt(doc, 2, 100, 100);
    expect(next.camera.zoom).toBe(2);
    // world = (screen - cam) / zoom  → still 100
    const worldX = (100 - next.camera.x) / next.camera.zoom;
    const worldY = (100 - next.camera.y) / next.camera.zoom;
    expect(worldX).toBeCloseTo(100, 5);
    expect(worldY).toBeCloseTo(100, 5);
  });

  it("clampZoom bounds extreme values", () => {
    expect(clampZoom(0)).toBe(0.25);
    expect(clampZoom(99)).toBe(2.5);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("addExplorationFrame appends beside the live frame and selects it", () => {
    const doc = addExplorationFrame(createDefaultDoc(), {
      id: "exp-1",
      name: "Variante A",
      html: "<html><body>hi</body></html>",
    });
    const exp = doc.nodes.find((n) => n.id === "exp-1")!;
    const live = doc.nodes.find((n) => n.id === LIVE_HOME_ID)!;
    expect(exp.kind).toBe("exploration");
    expect(exp.html).toContain("hi");
    expect(exp.x).toBeGreaterThan(live.x + live.width);
    expect(doc.selectedId).toBe("exp-1");
  });

  it("ensureCoreNodes restores missing brand/live without wiping exploration", () => {
    const stripped = {
      version: 1 as const,
      camera: { x: 0, y: 0, zoom: 1 },
      selectedId: null,
      nodes: [
        {
          id: "exp-only",
          kind: "exploration" as const,
          name: "Solo",
          x: 0,
          y: 0,
          width: 200,
          height: 200,
          zIndex: 1,
          html: "<p>x</p>",
        },
      ],
    };
    const fixed = ensureCoreNodes(stripped);
    expect(fixed.nodes.some((n) => n.id === BRAND_NODE_ID)).toBe(true);
    expect(fixed.nodes.some((n) => n.kind === "live")).toBe(true);
    expect(fixed.nodes.some((n) => n.id === "exp-only")).toBe(true);
  });

  it("bringToFront raises zIndex above siblings", () => {
    let doc = createDefaultDoc();
    const before = doc.nodes.find((n) => n.id === BRAND_NODE_ID)!.zIndex;
    doc = bringToFront(doc, BRAND_NODE_ID);
    const after = doc.nodes.find((n) => n.id === BRAND_NODE_ID)!.zIndex;
    expect(after).toBeGreaterThan(before);
    const liveZ = doc.nodes.find((n) => n.id === LIVE_HOME_ID)!.zIndex;
    expect(after).toBeGreaterThan(liveZ);
  });
});
