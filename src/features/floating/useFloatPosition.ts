// Shugu Forge — useFloatPosition hook
//
// Encapsulates the intra-window position state of the floating chibi shell
// (FloatChat today, future swappable shells tomorrow): drag, snap-to-edge,
// window-resize clamping, and the bridges with the mascot-window host.
//
// Host coupling (mascot.tsx pushes these props down):
//   - disableInternalDrag: when true, the chibi's mousedown is a no-op for
//     intra-window drag. The host installs its own window-level drag handler
//     that moves the OS window instead. Click-to-toggle still works.
//   - forceSide: when "left" | "right", overrides the default left/right
//     detection (chibi's intra-window pos.x vs viewport center). The mascot
//     window flips this based on where the WINDOW sits on the monitor.
//   - freezePos: when true, NO effect touches pos. The mascot window slides
//     the OS window into place on a screen-edge snap without ever
//     repositioning the chibi inside the frame — keeps the chibi visually
//     anchored to wherever the user dropped it.
//   - forceEdge: when "left"|"right"|"top"|"bottom", the chibi switches to
//     the matching peek pose (gripping the screen edge) and the chat panel
//     hides — the shimeji-style "tucked at the edge" state. Pass null to
//     un-tuck. The host (mascot.tsx) sets this on screen-edge snap.
//
// Behavior preserved 1:1 from the previous in-FloatChat implementation
// (panels.tsx pre-Phase-4.6). All magic numbers stay (156 px avatar,
// 14 px snap, 6 px edge buffer). The only structural change is extraction.

import { useState, useEffect, useRef, useCallback } from "react";

export type FloatEdge = "left" | "right" | "top" | "bottom" | null;
export type FloatSide = "left" | "right";

export interface UseFloatPositionInput {
  disableInternalDrag?: boolean;
  forceSide?: "left" | "right";
  freezePos?: boolean;
  forceEdge?: FloatEdge | undefined;
}

export interface UseFloatPositionResult {
  pos: { x: number; y: number };
  side: FloatSide;
  edge: FloatEdge;
  dragging: boolean;
  /** Ref set to true once a drag actually moved (>= 4px). Caller checks this to suppress click-after-drag. */
  movedRef: React.MutableRefObject<boolean>;
  onAvatarMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  /** Clear the current edge tuck. Repositions pos to a sensible spot unless freezePos is set. */
  clearEdge: () => void;
}

const AVATAR_SIZE = 156;
const SNAP_THRESHOLD = 14;
const EDGE_BUFFER = 6;
const DRAG_CLICK_THRESHOLD_PX = 4;

export function useFloatPosition({
  disableInternalDrag,
  forceSide,
  freezePos,
  forceEdge,
}: UseFloatPositionInput): UseFloatPositionResult {
  const [pos, setPos] = useState(() => {
    // Default: CENTER of viewport, both axes. With FloatChat now only used
    // in the mascot window, the wide-enough mascot frame (>= 844 px) ensures
    // the chat panel fits flush on EITHER side of the chibi — critical when
    // the host flips forceSide based on which half of the monitor the chibi
    // visible body sits on.
    return {
      x: Math.round(window.innerWidth / 2 - AVATAR_SIZE / 2),
      y: Math.round(window.innerHeight / 2 - AVATAR_SIZE / 2),
    };
  });
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<FloatEdge>(null);
  const movedRef = useRef(false);

  // freezePos=true  → never touch pos (mascot mode: window slides on snap)
  // freezePos=false + forceSide set → slide pos.x to the matching side so the
  // chat panel sits on the correct half. Trade-off: when frozen and the
  // chibi is rendered far from the host-determined side, the chat panel may
  // extend past the window edge. Soft bug vs the hard bug of teleport-feel.
  useEffect(() => {
    if (freezePos) return;
    if (forceSide === "left" || forceSide === "right") {
      setPos(p => ({
        x: forceSide === "left" ? 12 : window.innerWidth - AVATAR_SIZE - 12,
        y: p.y,
      }));
    }
  }, [forceSide, freezePos]);

  // Bridge: the host pushes forceEdge to mirror its window-level snap state
  // into our internal edge. Contract: undefined = don't touch, null = clear,
  // "left"/"right"/"top"/"bottom" = tuck. Internal clearEdge() also writes
  // to setEdge so both paths converge.
  useEffect(() => {
    if (forceEdge !== undefined) setEdge(forceEdge ?? null);
  }, [forceEdge]);

  // Re-clamp pos on window resize so the chibi never floats off-screen.
  useEffect(() => {
    const onResize = () => {
      setPos(p => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - AVATAR_SIZE)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - AVATAR_SIZE)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const side: FloatSide =
    forceSide === "left" || forceSide === "right"
      ? forceSide
      : pos.x + 39 > window.innerWidth / 2 ? "right" : "left";

  const onAvatarMouseDown = useCallback((e: React.MouseEvent) => {
    // When the host (mascot window) drives drag at the OS level, bail out
    // — but still preventDefault so the browser doesn't initiate text
    // selection on the SVG/img inside the avatar.
    if (disableInternalDrag) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    movedRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const startPos = { ...pos };
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > DRAG_CLICK_THRESHOLD_PX) movedRef.current = true;
      const nx = Math.max(-30, Math.min(window.innerWidth - 48, startPos.x + dx));
      const ny = Math.max(-30, Math.min(window.innerHeight - 48, startPos.y + dy));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPos(p => {
        const distLeft = p.x;
        const distRight = window.innerWidth - (p.x + AVATAR_SIZE);
        const distTop = p.y;
        const distBottom = window.innerHeight - (p.y + AVATAR_SIZE);
        const minDist = Math.min(distLeft, distRight, distTop, distBottom);
        if (minDist > SNAP_THRESHOLD) {
          setEdge(null);
          return p;
        }
        if (minDist === distLeft) {
          setEdge("left");
          return { x: -AVATAR_SIZE / 2 + EDGE_BUFFER, y: p.y };
        }
        if (minDist === distRight) {
          setEdge("right");
          return { x: window.innerWidth - AVATAR_SIZE / 2 - EDGE_BUFFER, y: p.y };
        }
        if (minDist === distTop) {
          setEdge("top");
          return { x: p.x, y: -AVATAR_SIZE / 2 + EDGE_BUFFER };
        }
        if (minDist === distBottom) {
          setEdge("bottom");
          return { x: p.x, y: window.innerHeight - AVATAR_SIZE / 2 - EDGE_BUFFER };
        }
        return p;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [disableInternalDrag, pos]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setPos(p => ({ x: window.innerWidth - p.x - AVATAR_SIZE, y: p.y }));
  }, []);

  const clearEdge = useCallback(() => {
    const wasEdge = edge;
    setEdge(null);
    // In mascot-mode (freezePos), don't auto-reposition the chibi inside
    // the window on un-tuck — the host is responsible for window
    // positioning. Without this guard, clicking the chibi after a
    // screen-edge snap would teleport it 360 px to the side-buffer position.
    if (!freezePos && wasEdge) {
      setPos(p => {
        let nx = p.x, ny = p.y;
        if (wasEdge === "left") nx = 24;
        if (wasEdge === "right") nx = window.innerWidth - AVATAR_SIZE - 24;
        if (wasEdge === "top") ny = 24;
        if (wasEdge === "bottom") ny = window.innerHeight - AVATAR_SIZE - 24;
        return { x: nx, y: ny };
      });
    }
  }, [edge, freezePos]);

  return {
    pos,
    side,
    edge,
    dragging,
    movedRef,
    onAvatarMouseDown,
    onContextMenu,
    clearEdge,
  };
}
