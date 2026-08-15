// Shugu Forge — Studio infinite-canvas document model (pure, unit-tested).
//
// The canvas is the Studio surface: live preview frames (product twin),
// exploration frames (variants), and a brand node. No React / Tauri here —
// mutations are pure so camera/node logic stays honest under vitest.

import { parsePins } from "./canvasPins";

export type CanvasNodeKind = "live" | "component" | "exploration" | "brand";

export interface CanvasCamera {
  x: number;
  y: number;
  /** 0.25 … 2.5 */
  zoom: number;
}

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  /** live: path under preview/ (e.g. "index.html"). exploration: inline HTML. */
  route?: string;
  html?: string;
  /** Persistent element-anchored comments (Lot B). See canvasPins.ts. */
  pins?: import("./canvasPins").CanvasPin[];
}

export interface StudioCanvasDoc {
  version: 1;
  camera: CanvasCamera;
  nodes: CanvasNode[];
  selectedId: string | null;
}

export const CANVAS_ZOOM_MIN = 0.25;
export const CANVAS_ZOOM_MAX = 2.5;

export const LIVE_HOME_ID = "live-home";
export const BRAND_NODE_ID = "brand";

const DEFAULT_LIVE = { width: 1280, height: 800 };
const DEFAULT_BRAND = { width: 320, height: 220 };

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, z));
}

/** Fresh board: brand node (left) + live product frame (center). */
export function createDefaultDoc(): StudioCanvasDoc {
  return {
    version: 1,
    camera: { x: 0, y: 0, zoom: 0.65 },
    selectedId: LIVE_HOME_ID,
    nodes: [
      {
        id: BRAND_NODE_ID,
        kind: "brand",
        name: "Marque",
        x: -420,
        y: 40,
        width: DEFAULT_BRAND.width,
        height: DEFAULT_BRAND.height,
        zIndex: 1,
      },
      {
        id: LIVE_HOME_ID,
        kind: "live",
        name: "Produit live",
        x: 40,
        y: 40,
        width: DEFAULT_LIVE.width,
        height: DEFAULT_LIVE.height,
        zIndex: 2,
      },
    ],
  };
}

export function parseCanvasDoc(raw: unknown): StudioCanvasDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<StudioCanvasDoc>;
  if (o.version !== 1 || !Array.isArray(o.nodes) || !o.camera) return null;
  const cam = o.camera;
  if (typeof cam.x !== "number" || typeof cam.y !== "number" || typeof cam.zoom !== "number") {
    return null;
  }
  const nodes: CanvasNode[] = [];
  for (const n of o.nodes) {
    if (!n || typeof n !== "object") continue;
    if (typeof n.id !== "string" || !n.id) continue;
    if (n.kind !== "live" && n.kind !== "component" && n.kind !== "exploration" && n.kind !== "brand") {
      continue;
    }
    if (typeof n.name !== "string") continue;
    if (typeof n.x !== "number" || typeof n.y !== "number") continue;
    if (typeof n.width !== "number" || typeof n.height !== "number") continue;
    nodes.push({
      id: n.id,
      kind: n.kind,
      name: n.name,
      x: n.x,
      y: n.y,
      width: Math.max(80, n.width),
      height: Math.max(60, n.height),
      zIndex: typeof n.zIndex === "number" ? n.zIndex : 0,
      route: typeof n.route === "string" ? n.route : undefined,
      html: typeof n.html === "string" ? n.html : undefined,
      pins: parsePins(n.pins),
    });
  }
  if (nodes.length === 0) return null;
  return {
    version: 1,
    camera: { x: cam.x, y: cam.y, zoom: clampZoom(cam.zoom) },
    nodes,
    selectedId: typeof o.selectedId === "string" ? o.selectedId : null,
  };
}

export function selectNode(doc: StudioCanvasDoc, id: string | null): StudioCanvasDoc {
  if (id !== null && !doc.nodes.some((n) => n.id === id)) {
    return { ...doc, selectedId: null };
  }
  return { ...doc, selectedId: id };
}

export function moveNode(
  doc: StudioCanvasDoc,
  id: string,
  x: number,
  y: number,
): StudioCanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
  };
}

export function resizeNode(
  doc: StudioCanvasDoc,
  id: string,
  width: number,
  height: number,
): StudioCanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.id === id
        ? { ...n, width: Math.max(80, width), height: Math.max(60, height) }
        : n,
    ),
  };
}

export function renameNode(doc: StudioCanvasDoc, id: string, name: string): StudioCanvasDoc {
  const trimmed = name.trim() || "Sans titre";
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, name: trimmed } : n)),
  };
}

export function setCamera(doc: StudioCanvasDoc, camera: Partial<CanvasCamera>): StudioCanvasDoc {
  return {
    ...doc,
    camera: {
      x: camera.x ?? doc.camera.x,
      y: camera.y ?? doc.camera.y,
      zoom: clampZoom(camera.zoom ?? doc.camera.zoom),
    },
  };
}

/** Pan in screen pixels (already divided by zoom by the caller if needed). */
export function panCamera(doc: StudioCanvasDoc, dx: number, dy: number): StudioCanvasDoc {
  return setCamera(doc, { x: doc.camera.x + dx, y: doc.camera.y + dy });
}

/**
 * Zoom toward a point in screen space relative to the canvas viewport origin.
 * `sx`/`sy` are pointer coords in the viewport; we keep that world point stable.
 */
export function zoomAt(
  doc: StudioCanvasDoc,
  nextZoom: number,
  sx: number,
  sy: number,
): StudioCanvasDoc {
  const z0 = doc.camera.zoom;
  const z1 = clampZoom(nextZoom);
  if (z0 === z1) return doc;
  // world = (screen - camera) / zoom  →  camera' = screen - world * zoom'
  const worldX = (sx - doc.camera.x) / z0;
  const worldY = (sy - doc.camera.y) / z0;
  return setCamera(doc, {
    zoom: z1,
    x: sx - worldX * z1,
    y: sy - worldY * z1,
  });
}

export function addExplorationFrame(
  doc: StudioCanvasDoc,
  input: { id: string; name: string; html: string; route?: string; x?: number; y?: number },
): StudioCanvasDoc {
  const maxZ = doc.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0);
  const live = doc.nodes.find((n) => n.kind === "live");
  const node: CanvasNode = {
    id: input.id,
    kind: "exploration",
    name: input.name,
    x: input.x ?? (live ? live.x + live.width + 80 : 1400),
    y: input.y ?? (live ? live.y : 40),
    width: 960,
    height: 640,
    zIndex: maxZ + 1,
    html: input.html,
    route: input.route,
  };
  return { ...doc, nodes: [...doc.nodes, node], selectedId: node.id };
}

/** Ensure brand + live-home exist (migrates older/partial docs). */
export function ensureCoreNodes(doc: StudioCanvasDoc): StudioCanvasDoc {
  let nodes = doc.nodes;
  if (!nodes.some((n) => n.id === BRAND_NODE_ID)) {
    nodes = [
      {
        id: BRAND_NODE_ID,
        kind: "brand",
        name: "Marque",
        x: -420,
        y: 40,
        width: DEFAULT_BRAND.width,
        height: DEFAULT_BRAND.height,
        zIndex: 1,
      },
      ...nodes,
    ];
  }
  if (!nodes.some((n) => n.kind === "live")) {
    nodes = [
      ...nodes,
      {
        id: LIVE_HOME_ID,
        kind: "live",
        name: "Produit · Accueil",
        x: 40,
        y: 40,
        width: DEFAULT_LIVE.width,
        height: DEFAULT_LIVE.height,
        zIndex: 2,
        route: "index.html",
      },
    ];
  }
  return nodes === doc.nodes ? doc : { ...doc, nodes };
}

/**
 * Studio mirrors the OPEN workspace — drop forge-silo atlas frames
 * (extra live pages + component scrapes from `.shugu-forge/preview/`).
 * Keeps brand, one live home frame, and explorations.
 */
export function stripForgeProductFrames(doc: StudioCanvasDoc): StudioCanvasDoc {
  const liveHome =
    doc.nodes.find((n) => n.id === LIVE_HOME_ID) ??
    doc.nodes.find((n) => n.kind === "live") ??
    null;
  const kept = doc.nodes.filter(
    (n) => n.kind === "brand" || n.kind === "exploration" || n.id === LIVE_HOME_ID,
  );
  let nodes = kept;
  if (!nodes.some((n) => n.kind === "live")) {
    nodes = [
      ...nodes,
      liveHome && liveHome.kind === "live"
        ? { ...liveHome, id: LIVE_HOME_ID, name: liveHome.name || "Produit live" }
        : {
            id: LIVE_HOME_ID,
            kind: "live" as const,
            name: "Produit live",
            x: 40,
            y: 40,
            width: DEFAULT_LIVE.width,
            height: DEFAULT_LIVE.height,
            zIndex: 2,
          },
    ];
  }
  const selectedId =
    doc.selectedId && nodes.some((n) => n.id === doc.selectedId) ? doc.selectedId : LIVE_HOME_ID;
  const same =
    nodes.length === doc.nodes.length &&
    nodes.every((n, i) => n.id === doc.nodes[i]?.id) &&
    selectedId === doc.selectedId;
  return same ? doc : { ...doc, nodes, selectedId };
}

export function getSelectedNode(doc: StudioCanvasDoc): CanvasNode | null {
  if (!doc.selectedId) return null;
  return doc.nodes.find((n) => n.id === doc.selectedId) ?? null;
}

export function bringToFront(doc: StudioCanvasDoc, id: string): StudioCanvasDoc {
  const maxZ = doc.nodes.reduce((m, n) => Math.max(m, n.zIndex), 0);
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (n.id === id ? { ...n, zIndex: maxZ + 1 } : n)),
  };
}
