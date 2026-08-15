// Shugu Forge — Studio canvas pins (Lot B) — pure doc mutations.
//
// A pin is a persistent comment anchored to an element of a frame (Claude
// Design / Figma style). Pins live ON the canvas node so they persist with the
// board (studioCanvasStore already persists the doc) and travel with
// "Sauvegarder une copie".
//
// `relX/relY` are the click position relative to the frame viewport (0..1) at
// placement time — good enough to render the badge; clicking a badge
// re-highlights the real element via the preview bridge.

import type { CanvasNode, StudioCanvasDoc } from "./studioCanvasDoc";
import type { SelectedElement } from "../studioChat";

export interface CanvasPin {
  id: string;
  /** Element descriptor captured at placement (drives targeted edits). */
  selector: string;
  tag: string;
  text: string;
  open: string;
  /** Click position relative to the frame's viewport (0..1). */
  relX: number;
  relY: number;
  /** User comment; empty until annotated. */
  comment: string;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(1, Math.max(0, v));
}

/** Lenient pins reader used by parseCanvasDoc (optional field, forward-compat). */
export function parsePins(raw: unknown): CanvasPin[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CanvasPin[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.selector !== "string") continue;
    out.push({
      id: o.id,
      selector: o.selector,
      tag: typeof o.tag === "string" ? o.tag : "",
      text: typeof o.text === "string" ? o.text : "",
      open: typeof o.open === "string" ? o.open : "",
      relX: clamp01(typeof o.relX === "number" ? o.relX : 0.5),
      relY: clamp01(typeof o.relY === "number" ? o.relY : 0.5),
      comment: typeof o.comment === "string" ? o.comment : "",
    });
  }
  return out.length ? out : undefined;
}

function mapNode(
  doc: StudioCanvasDoc,
  nodeId: string,
  fn: (n: CanvasNode) => CanvasNode,
): StudioCanvasDoc {
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? fn(n) : n)) };
}

export function addPinToNode(
  doc: StudioCanvasDoc,
  nodeId: string,
  el: SelectedElement,
  relX: number,
  relY: number,
): { doc: StudioCanvasDoc; pin: CanvasPin } {
  const pin: CanvasPin = {
    id: crypto.randomUUID(),
    selector: el.selector,
    tag: el.tag,
    text: el.text,
    open: el.open,
    relX: clamp01(relX),
    relY: clamp01(relY),
    comment: "",
  };
  return {
    doc: mapNode(doc, nodeId, (n) => ({ ...n, pins: [...(n.pins ?? []), pin] })),
    pin,
  };
}

export function removePinFromNode(
  doc: StudioCanvasDoc,
  nodeId: string,
  pinId: string,
): StudioCanvasDoc {
  return mapNode(doc, nodeId, (n) => {
    const pins = (n.pins ?? []).filter((p) => p.id !== pinId);
    return { ...n, pins: pins.length ? pins : undefined };
  });
}

export function setPinComment(
  doc: StudioCanvasDoc,
  nodeId: string,
  pinId: string,
  comment: string,
): StudioCanvasDoc {
  return mapNode(doc, nodeId, (n) => ({
    ...n,
    pins: (n.pins ?? []).map((p) => (p.id === pinId ? { ...p, comment } : p)),
  }));
}

/** All pins of a node, stable order. */
export function pinsOfNode(node: CanvasNode | null | undefined): CanvasPin[] {
  return node?.pins ?? [];
}

/** Pins with a non-empty comment = actionable annotations. */
export function commentedPins(node: CanvasNode | null | undefined): CanvasPin[] {
  return pinsOfNode(node).filter((p) => p.comment.trim());
}

/**
 * One agent task applying every commented pin of a frame — the batch "résoudre
 * les commentaires" flow (Claude Design parity). Pins without a comment are
 * excluded (they are markers, not requests).
 */
export function buildPinsTask(nodeName: string, pins: CanvasPin[]): string {
  const items = pins
    .map(
      (p, i) =>
        `${i + 1}. Élément \`${p.selector}\` (${p.tag}${p.text ? `, texte « ${p.text.slice(0, 60)} »` : ""})` +
        `\n   HTML : ${p.open}\n   Commentaire : ${p.comment.trim()}`,
    )
    .join("\n");
  return [
    `Applique les commentaires épinglés sur la frame « ${nodeName} » du projet existant`,
    "dans .shugu-forge/preview/. Lis d'abord les fichiers actuels, localise chaque élément,",
    "puis applique son commentaire. Traite les points dans l'ordre :",
    "",
    items,
    "",
    "Ne change rien d'autre.",
  ].join("\n");
}
