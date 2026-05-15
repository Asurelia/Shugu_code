// Shugu Forge — entry point for the floating mascot window.
//
// This is a SECOND React root, mounted in mascot.html, which runs in a
// dedicated transparent/always-on-top Tauri window alongside the main IDE
// window. It is intentionally lean — it does NOT import RootLayout,
// ShellContext, TanStack Router, or any of the IDE shell. The mascot
// communicates with the main window via Tauri events (M4 — not yet wired),
// not via React context.
//
// M2 — port the chibi + chat panel into the mascot window:
//   Reuse the existing FloatChat component as-is. It has no React-context
//   dependencies (just local state + Tauri invoke for chat_send later), so
//   it works in this standalone root without modification. pinnedAnno/
//   clearPinned will arrive via Tauri events at M4 — for now we pass
//   inert defaults so the pinned-annotation UI stays hidden.

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";
import { FloatChat } from "@/features/panels/panels";
import { ThemeBootstrap } from "@/lib/ThemeBootstrap";

// Cross-hook flag: while the user is actively dragging the mascot window,
// the click-through hook MUST NOT toggle setIgnoreCursorEvents(true) — even
// if the cursor briefly exits the painted area during a fast drag. Ignoring
// cursor events mid-drag drops the mouseup, which kills snap detection.
// Module-level rather than a ref so both hooks share the same instance
// without a Context.
let mascotIsDragging = false;

// ─── Click-through hook (M5) ─────────────────────────────────
//
// Discord/Steam-overlay style: the mascot window is mostly transparent,
// but its bounding rectangle would normally swallow every click in that
// rectangle. We want the user's clicks in the EMPTY area to pass through
// to whatever app is underneath, and clicks ON the chibi / chat panel to
// reach our React tree.
//
// Tauri 2's `WebviewWindow.setIgnoreCursorEvents(boolean)` is the
// primitive: when true, the window receives ZERO cursor events from the
// OS (clicks fall through). When false, normal interaction. We toggle it
// per-frame based on what's under the cursor.
//
// The chicken-and-egg: when events are ignored, `mousemove` does not fire
// — so we cannot detect when the cursor returns to a painted area. The
// fix is to poll the OS-level cursor position via Tauri's
// `cursorPosition()` (returns physical pixels relative to the desktop)
// every 50 ms WHILE we're in the ignored state. Once we detect the
// cursor is over a painted element, we flip back to receiving events
// and mousemove takes over again.
function useMascotClickThrough() {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      // Lazy-import Tauri so plain `pnpm dev` (no Tauri runtime) is a no-op.
      let win: any = null;
      let cursorPos: (() => Promise<{ x: number; y: number }>) | null = null;
      try {
        const m1 = await import("@tauri-apps/api/webviewWindow");
        const m2 = await import("@tauri-apps/api/window");
        win = m1.getCurrentWebviewWindow();
        cursorPos = m2.cursorPosition as any;
      } catch {
        return; // not in Tauri webview, nothing to do
      }
      if (cancelled || !win || !cursorPos) return;

      // Idempotent toggle — only call setIgnoreCursorEvents when state
      // changes, to avoid spamming the Rust side on every mousemove.
      let lastIgnore: boolean | null = null;
      let ignoreErrLogged = false;
      const setIgnore = async (ignore: boolean) => {
        // While the user is dragging the window we MUST keep events on
        // so the mouseup reaches us — even if the cursor briefly slips
        // off the painted area during a fast drag. See useMascotWindowDrag.
        if (mascotIsDragging && ignore) return;
        if (lastIgnore === ignore) return;
        lastIgnore = ignore;
        try {
          await win.setIgnoreCursorEvents(ignore);
        } catch (e) {
          // Most common cause: missing
          // `core:window:allow-set-ignore-cursor-events` permission in
          // the mascot capability file. Log ONCE so it shows up in the
          // mascot window's devtools without spamming on every move.
          if (!ignoreErrLogged) {
            ignoreErrLogged = true;
            console.warn("[mascot] setIgnoreCursorEvents failed — click-through inactive:", e);
          }
        }
      };

      // Hit-test: is the painted UI under (cssX, cssY) in this document?
      // The painted UI tree is rooted at `.float-shell` (the FloatChat
      // outer container). Anything else (body, html) is transparent.
      const isOverPainted = (cssX: number, cssY: number): boolean => {
        const el = document.elementFromPoint(cssX, cssY);
        return !!(el && el.closest(".float-shell"));
      };

      // Path 1: cursor events ARE allowed — DOM mousemove handles us.
      const onMove = (e: MouseEvent) => {
        void setIgnore(!isOverPainted(e.clientX, e.clientY));
      };
      document.addEventListener("mousemove", onMove);

      // Path 2: cursor events are IGNORED — DOM is silent. Poll the OS
      // cursor position via Tauri and convert to local CSS coordinates.
      let pollErrLogged = false;
      const tick = async () => {
        if (lastIgnore !== true) return; // path 1 has us covered
        try {
          const [gpos, wpos] = await Promise.all([cursorPos!(), win.outerPosition()]);
          const scale = window.devicePixelRatio || 1;
          // gpos and wpos are PHYSICAL pixels; elementFromPoint wants CSS pixels.
          const localX = (gpos.x - wpos.x) / scale;
          const localY = (gpos.y - wpos.y) / scale;
          // Cursor outside our window bounds → user is on another app, stay ignored.
          if (localX < 0 || localY < 0 || localX > window.innerWidth || localY > window.innerHeight) {
            return;
          }
          if (isOverPainted(localX, localY)) {
            await setIgnore(false);
          }
        } catch (e) {
          // Same hint as setIgnore — missing permissions on
          // core:window:allow-cursor-position / allow-outer-position.
          // core:window:default *should* include both; log once if not.
          if (!pollErrLogged) {
            pollErrLogged = true;
            console.warn("[mascot] cursor poll failed — recovery from ignored state will stick:", e);
          }
        }
      };
      const pollHandle = window.setInterval(tick, 50);

      // Boot ignored, so the moment the mascot window appears it doesn't
      // swallow whatever the user was clicking on.
      await setIgnore(true);

      cleanup = () => {
        document.removeEventListener("mousemove", onMove);
        clearInterval(pollHandle);
        void setIgnore(false); // restore on unmount (dev HMR, app close)
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
}

// ─── Window-level drag + multi-monitor edge snap (M3) ───────
//
// The chibi LIVES in its own Tauri window now, so dragging it should move
// the WINDOW across the desktop, not reposition the chibi inside the
// window. We pass `disableInternalDrag={true}` to FloatChat to silence its
// intra-window drag and replace it here with a window-level drag that
// queries every connected monitor via Tauri's `availableMonitors()` to
// snap to the closest screen edge on release.
//
// Coordinate model: Tauri positions are PHYSICAL pixels (raw OS pixels,
// not CSS-scaled). The DOM gives us CSS pixels via `screenX/Y`. We bridge
// the two by multiplying CSS deltas by `devicePixelRatio`.
//
// Snap detection uses the CHIBI's VISIBLE bounds, not the 600×600
// transparent window. The window has a lot of click-through padding;
// snapping against its frame puts the chibi 100+ px inside the screen,
// which feels wrong. We compute the chibi's visible rectangle in screen
// physical pixels (cluster.getBoundingClientRect() + the constants below
// for the chibi-mascot's overflow + the PNG's transparent margins) and
// snap when ANY of those edges falls within SNAP_THRESHOLD of a monitor
// edge. On release we also pin pos (via setForcePos) so the chibi sits
// in the matching corner/edge of the window — that way window.x =
// monitor.left lands chibi visible at screen.x = monitor.left exactly.
//
// CHIBI VISIBLE GEOMETRY (constants, in CSS pixels relative to the
// .float-cluster's top-left):
//   - cluster is 156×156
//   - chibi-mascot div is 240×288, centered in cluster via grid place-content
//   - rendered <img> is 240×240 (object-fit:contain on the square PNG),
//     centered vertically with 24 px letterbox top + bottom
//   - PNG itself has ~25.2 % transparent above the head and ~17.4 %
//     transparent below the feet (measured by alpha-scan in M2)
//
// Resulting offsets from cluster top-left to chibi VISIBLE pixels:
const CHIBI_LEFT   = -42;   // visible left  = cluster.left + (-42)
const CHIBI_RIGHT  = 198;   // visible right = cluster.left + 198 (156 + 42)
const CHIBI_TOP    = 19;    // visible head  = cluster.top  + 19
const CHIBI_BOTTOM = 156;   // visible feet  = cluster.top  + 156
const CLUSTER_SIZE = 156;

type ForcePos = { x: number; y: number } | null;
type ForcedSide = "left" | "right" | null;

function useMascotWindowDrag(
  setForcedSide: (s: ForcedSide) => void,
  setForcePos: (p: ForcePos) => void,
) {
  useEffect(() => {
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      let win: any = null;
      let availableMonitorsFn: (() => Promise<any[]>) | null = null;
      let PhysicalPositionCtor: any = null;
      try {
        const m1 = await import("@tauri-apps/api/webviewWindow");
        const m2 = await import("@tauri-apps/api/window");
        win = m1.getCurrentWebviewWindow();
        availableMonitorsFn = m2.availableMonitors;
        PhysicalPositionCtor = m2.PhysicalPosition;
      } catch { return; }
      if (cancelled || !win || !availableMonitorsFn) return;

      // CSS pixels. Multiplied by devicePixelRatio at use-site so the snap
      // feels the same on a 100 % screen and a 200 % HiDPI screen.
      const SNAP_THRESHOLD_CSS = 80;
      // CSS pixels — below this drag-delta we treat the gesture as a click,
      // above it as a drag (matches FloatChat's own threshold).
      const DRAG_THRESHOLD_CSS = 4;

      // Anchor presets — where INSIDE the window the chibi cluster should
      // sit for each of the 9 conceptual positions. Used both for initial
      // state (center-left / center-right depending on monitor side) and
      // for post-snap positioning so the chibi visible edge lines up
      // flush with the snapped screen edge.
      const anchor = (preset:
        | "topLeft"   | "top"    | "topRight"
        | "centerLeft"| "center" | "centerRight"
        | "bottomLeft"| "bottom" | "bottomRight",
        winCssW: number, winCssH: number,
      ): { x: number; y: number } => {
        const cx = Math.round(winCssW / 2 - CLUSTER_SIZE / 2);
        const cy = Math.round(winCssH / 2 - CLUSTER_SIZE / 2);
        const xL = -CHIBI_LEFT;                // 42  — chibi visible left at 0 in window
        const xR = winCssW - CHIBI_RIGHT;      // visible right at winW
        const yT = -CHIBI_TOP;                 // -19 — visible head at 0 in window
        const yB = winCssH - CHIBI_BOTTOM;     // visible feet at winH
        switch (preset) {
          case "topLeft":     return { x: xL, y: yT };
          case "top":         return { x: cx, y: yT };
          case "topRight":    return { x: xR, y: yT };
          case "centerLeft":  return { x: xL, y: cy };
          case "center":      return { x: cx, y: cy };
          case "centerRight": return { x: xR, y: cy };
          case "bottomLeft":  return { x: xL, y: yB };
          case "bottom":      return { x: cx, y: yB };
          case "bottomRight": return { x: xR, y: yB };
        }
      };

      // Find the monitor under a given physical (cx, cy) point.
      const findMonitor = async (cx: number, cy: number) => {
        const monitors = await availableMonitorsFn!();
        return monitors.find((mn: any) =>
          cx >= mn.position.x && cx < mn.position.x + mn.size.width &&
          cy >= mn.position.y && cy < mn.position.y + mn.size.height
        ) || monitors[0];
      };

      // Refresh BOTH forcedSide and forcePos based on the window's current
      // position. Side is determined by horizontal position on the monitor;
      // forcePos snaps the chibi to the matching center-side anchor.
      const refreshIdle = async () => {
        try {
          const winPos = await win.outerPosition();
          const winSize = await win.outerSize();
          const cx = winPos.x + winSize.width / 2;
          const cy = winPos.y + winSize.height / 2;
          const m = await findMonitor(cx, cy);
          if (!m) return;
          const winCssW = winSize.width / (window.devicePixelRatio || 1);
          const winCssH = winSize.height / (window.devicePixelRatio || 1);
          const mCenterX = m.position.x + m.size.width / 2;
          const side: ForcedSide = cx > mCenterX ? "right" : "left";
          setForcedSide(side);
          setForcePos(anchor(side === "right" ? "centerRight" : "centerLeft", winCssW, winCssH));
        } catch (err) {
          console.warn("[mascot drag] refreshIdle failed:", err);
        }
      };

      // Initial state — chibi at center-side based on spawn position.
      await refreshIdle();

      const onMouseDown = async (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target) return;
        if (!target.closest(".float-cluster")) return;
        if (target.closest(".float-speech")) return;
        if (e.button !== 0) return;

        const startScreenX = e.screenX;
        const startScreenY = e.screenY;
        const scale = window.devicePixelRatio || 1;

        let startWinPos: { x: number; y: number };
        try {
          startWinPos = await win.outerPosition();
        } catch (err) {
          console.warn("[mascot drag] outerPosition failed at start:", err);
          return;
        }
        let didDrag = false;

        // Mark the drag window for the click-through hook — it'll keep
        // cursor events ON even if the cursor slips off the painted area
        // during a fast drag. Also force events ON right now, in case the
        // poll left them OFF.
        mascotIsDragging = true;
        try { await win.setIgnoreCursorEvents(false); } catch {}

        const onMove = (mv: MouseEvent) => {
          const dxCss = mv.screenX - startScreenX;
          const dyCss = mv.screenY - startScreenY;
          if (!didDrag && Math.abs(dxCss) + Math.abs(dyCss) < DRAG_THRESHOLD_CSS) return;
          didDrag = true;
          const nx = Math.round(startWinPos.x + dxCss * scale);
          const ny = Math.round(startWinPos.y + dyCss * scale);
          win.setPosition(new PhysicalPositionCtor(nx, ny)).catch(() => {});
        };

        const onUp = async () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          mascotIsDragging = false;
          if (!didDrag) return;

          try {
            const winPos = await win.outerPosition();
            const winSize = await win.outerSize();
            const dpr = window.devicePixelRatio || 1;
            const winCssW = winSize.width / dpr;
            const winCssH = winSize.height / dpr;

            // Find the monitor under the WINDOW center (still uses window
            // center to pick the monitor — that part is fine, we just
            // measure snap against the CHIBI's visible bounds, below).
            const m = await findMonitor(
              winPos.x + winSize.width / 2,
              winPos.y + winSize.height / 2,
            );
            if (!m) { await refreshIdle(); return; }

            // Chibi VISIBLE rect in screen physical pixels. The cluster's
            // current CSS-pixel position in the window is read from the
            // DOM (it reflects whatever forcePos last set), then offsets
            // for the chibi-mascot overflow + PNG transparent margins
            // give us the actual painted edges the user sees.
            const cluster = document.querySelector(".float-cluster") as HTMLElement | null;
            if (!cluster) { await refreshIdle(); return; }
            const cr = cluster.getBoundingClientRect();
            const chibiL = winPos.x + (cr.left + CHIBI_LEFT)   * dpr;
            const chibiR = winPos.x + (cr.left + CHIBI_RIGHT)  * dpr;
            const chibiT = winPos.y + (cr.top  + CHIBI_TOP)    * dpr;
            const chibiB = winPos.y + (cr.top  + CHIBI_BOTTOM) * dpr;

            // Signed distance from each chibi edge to the matching monitor
            // edge. Negative = chibi edge already past the monitor edge
            // (e.g. chibi feet are below the visible monitor) — still
            // counts as "within threshold" so off-screen drops snap back.
            const dLeft   = chibiL - m.position.x;
            const dRight  = (m.position.x + m.size.width)  - chibiR;
            const dTop    = chibiT - m.position.y;
            const dBottom = (m.position.y + m.size.height) - chibiB;
            const thresholdPhys = SNAP_THRESHOLD_CSS * dpr;

            const lHit = dLeft   <= thresholdPhys;
            const rHit = dRight  <= thresholdPhys;
            const tHit = dTop    <= thresholdPhys;
            const bHit = dBottom <= thresholdPhys;

            // Corner snaps take priority when two adjacent edges both hit,
            // so a release near a screen corner sticks to that corner
            // instead of just the closer of the two edges.
            type Preset = Parameters<typeof anchor>[0];
            let preset: Preset | null = null;
            if      (lHit && tHit) preset = "topLeft";
            else if (rHit && tHit) preset = "topRight";
            else if (lHit && bHit) preset = "bottomLeft";
            else if (rHit && bHit) preset = "bottomRight";
            else if (lHit) preset = "centerLeft";
            else if (rHit) preset = "centerRight";
            else if (tHit) preset = "top";
            else if (bHit) preset = "bottom";

            if (preset) {
              // Pin the chibi to the anchor preset inside the window so its
              // VISIBLE body will line up flush with the snapped edges.
              const pos = anchor(preset, winCssW, winCssH);
              setForcePos(pos);

              // Compute the window's snapped physical position so the chibi
              // visible edges land exactly on the monitor edges. With the
              // anchor presets above, this reduces to placing the window
              // flush against the matching monitor edges.
              let nx = winPos.x, ny = winPos.y;
              if (lHit) nx = m.position.x;
              if (rHit) nx = m.position.x + m.size.width  - winSize.width;
              if (tHit) ny = m.position.y;
              if (bHit) ny = m.position.y + m.size.height - winSize.height;
              await win.setPosition(new PhysicalPositionCtor(nx, ny));

              // forcedSide drives the chat-panel dock direction. Left/right
              // edges and their corners pin it directly; top/bottom-only
              // snaps fall back to monitor-center horizontal test so the
              // chat docks AWAY from the screen edge it's closest to.
              if (lHit) {
                setForcedSide("left");
              } else if (rHit) {
                setForcedSide("right");
              } else {
                const finalCx = nx + winSize.width / 2;
                const mCx = m.position.x + m.size.width / 2;
                setForcedSide(finalCx > mCx ? "right" : "left");
              }
              console.log(`[mascot drag] snapped ${preset} on monitor "${m.name}"`);
            } else {
              // No snap. Re-derive forcedSide + center-side forcePos from
              // the post-drag position so the chibi flips when crossing the
              // monitor midline even without an edge snap.
              await refreshIdle();
            }
          } catch (err) {
            console.warn("[mascot drag] snap failed:", err);
          }
        };

        // Suppress the click that would otherwise fire after a drag-mouseup
        // (FloatChat's onAvatarClick toggles the panel — surprising after a drag).
        const onClickCapture = (ev: MouseEvent) => {
          if (didDrag) {
            ev.stopPropagation();
            ev.preventDefault();
          }
          document.removeEventListener("click", onClickCapture, { capture: true } as any);
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        document.addEventListener("click", onClickCapture, { capture: true });
      };

      document.addEventListener("mousedown", onMouseDown);
      cleanup = () => {
        document.removeEventListener("mousedown", onMouseDown);
      };
    })();

    return () => { cancelled = true; cleanup?.(); };
  }, [setForcedSide, setForcePos]);
}

function MascotApp() {
  // ThemeBootstrap applies the persisted Celestial Veil palette to
  // document.documentElement so the chibi's halo, the chat panel, and the
  // model picker all theme identically across the two windows. Without it
  // the mascot would render with the raw CSS-variable defaults (cyan/teal
  // baseline) instead of whatever the user picked in Settings → Tweaks.
  const [forcedSide, setForcedSide] = useState<ForcedSide>(null);
  const [forcePos, setForcePos] = useState<ForcePos>(null);
  useMascotClickThrough();
  useMascotWindowDrag(setForcedSide, setForcePos);
  return (
    <>
      <ThemeBootstrap />
      <FloatChat
        pinnedAnno={null}
        clearPinned={() => {}}
        disableInternalDrag
        forceSide={forcedSide ?? undefined}
        forcePos={forcePos ?? undefined}
      />
    </>
  );
}

const root = document.getElementById("mascot-root");
if (!root) throw new Error("mascot-root not found");
createRoot(root).render(
  <React.StrictMode>
    <MascotApp />
  </React.StrictMode>
);
