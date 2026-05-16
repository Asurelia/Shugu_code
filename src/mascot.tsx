// Shugu Forge — entry point for the floating mascot window.
//
// This is a SECOND React root, mounted in mascot.html, which runs in a
// dedicated transparent/always-on-top Tauri window alongside the main IDE
// window. It is intentionally lean — it does NOT import RootLayout,
// ShellContext, TanStack Router, or any of the IDE shell. The mascot
// communicates with the main window via Tauri events (M4 — not yet wired),
// not via React context.
//
// Phase 5 — compose the mascot window content from the FloatShell compound
// pattern. The shell is content-agnostic; the anchor + panel are pluggable.
// Today: <ChibiWithMood/> + <ChatPanel/>. Tomorrow: swap the panel for any
// other surface (TaskPanel, AgentLog, NotifPanel) without touching the
// drag/snap/edge machinery in FloatShell. The "swap <ChatPanel/> for a
// <div>Hello</div>" smoke test in this file is the proof of decoupling.

import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";
import { FloatShell } from "@/features/floating/FloatShell";
import { ChibiWithMood } from "@/features/mascot/ChibiWithMood";
import { ChatPanel } from "@/features/chat/ChatPanel";
import { ThemeBootstrap } from "@/lib/ThemeBootstrap";
import {
  loadCalibration,
  subscribeCalibration,
  type ChibiCalibration,
} from "@/features/mascot/calibration";

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
// CHIBI VISIBLE GEOMETRY — the 4 offsets that say where the visible chibi
// body sits inside its 240×288 wrapper, relative to .float-cluster's
// top-left (CSS pixels). Defaults derived in M3-v6 from a canvas alpha
// scan of every open-mood PNG; the user can tune them live from
// Settings → Mascot, persisted in localStorage. See features/mascot/
// calibration.ts for the storage + cross-window broadcast plumbing.
const CLUSTER_SIZE = 156;

type ForcedSide = "left" | "right" | null;
type ForcedEdge = "left" | "right" | "top" | "bottom" | null;

function useMascotWindowDrag(
  setForcedSide: (s: ForcedSide) => void,
  setForceEdge: (e: ForcedEdge) => void,
  calibrationRef: React.MutableRefObject<ChibiCalibration>,
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

      // CSS pixels — below this drag-delta we treat the gesture as a click,
      // above it as a drag (matches FloatChat's own threshold).
      const DRAG_THRESHOLD_CSS = 4;

      // Find the monitor under a given physical (cx, cy) point.
      // Used to identify which monitor the chibi lives on, so the snap
      // measures distances against THAT monitor's edges (not whichever
      // monitor the window's center happens to overlap).
      const findMonitor = async (cx: number, cy: number) => {
        const monitors = await availableMonitorsFn!();
        return monitors.find((mn: any) =>
          cx >= mn.position.x && cx < mn.position.x + mn.size.width &&
          cy >= mn.position.y && cy < mn.position.y + mn.size.height
        ) || monitors[0];
      };

      // Update forcedSide (just the CSS class — chat dock direction) based
      // on the chibi's VISIBLE center vs the monitor's horizontal center.
      // The chibi's intra-window position is never touched here, so the
      // chibi can't visually teleport — it stays where the user dropped it.
      const refreshSide = async () => {
        try {
          const cluster = document.querySelector(".float-cluster") as HTMLElement | null;
          if (!cluster) return;
          const cr = cluster.getBoundingClientRect();
          const winPos = await win.outerPosition();
          const dpr = window.devicePixelRatio || 1;
          const cal = calibrationRef.current;
          // Chibi visible center in screen physical pixels.
          const cx = winPos.x + (cr.left + (cal.left + cal.right) / 2) * dpr;
          const cy = winPos.y + (cr.top  + (cal.top  + cal.bottom) / 2) * dpr;
          const m = await findMonitor(cx, cy);
          if (!m) return;
          const mCenterX = m.position.x + m.size.width / 2;
          setForcedSide(cx > mCenterX ? "right" : "left");
        } catch (err) {
          console.warn("[mascot drag] refreshSide failed:", err);
        }
      };

      // Initial side — for the very first paint, before any drag happens.
      await refreshSide();

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

        // Un-tuck the chibi at drag start so the peek-pose sprite doesn't
        // travel with the cursor mid-drag — it should only appear once a
        // snap actually fires on release.
        setForceEdge(null);

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
            const dpr = window.devicePixelRatio || 1;

            // Chibi VISIBLE rect in screen physical pixels. cluster's
            // CSS-pixel position in the window is read from the DOM
            // (reflects FloatChat's current `pos` state); offsets for the
            // chibi-mascot overflow + PNG transparent margins give us the
            // actual painted edges the user sees.
            const cluster = document.querySelector(".float-cluster") as HTMLElement | null;
            if (!cluster) { await refreshSide(); return; }
            const cr = cluster.getBoundingClientRect();
            const cal = calibrationRef.current;
            const chibiL = winPos.x + (cr.left + cal.left)   * dpr;
            const chibiR = winPos.x + (cr.left + cal.right)  * dpr;
            const chibiT = winPos.y + (cr.top  + cal.top)    * dpr;
            const chibiB = winPos.y + (cr.top  + cal.bottom) * dpr;
            const chibiCx = (chibiL + chibiR) / 2;
            const chibiCy = (chibiT + chibiB) / 2;

            // Identify the monitor by the chibi's VISIBLE center, not the
            // window center. With Option B the window may extend far off-
            // screen on the side opposite the snap; the chibi's location
            // is what the user actually cares about.
            const m = await findMonitor(chibiCx, chibiCy);
            if (!m) { await refreshSide(); return; }

            // Signed distance from each chibi edge to the matching monitor
            // edge. Negative = chibi edge already past the monitor edge —
            // still counts as "within threshold" so off-screen drops snap
            // back into view.
            const dLeft   = chibiL - m.position.x;
            const dRight  = (m.position.x + m.size.width)  - chibiR;
            const dTop    = chibiT - m.position.y;
            const dBottom = (m.position.y + m.size.height) - chibiB;
            const thresholdPhys = cal.snapThreshold * dpr;

            const lHit = dLeft   <= thresholdPhys;
            const rHit = dRight  <= thresholdPhys;
            const tHit = dTop    <= thresholdPhys;
            const bHit = dBottom <= thresholdPhys;

            const anyHit = lHit || rHit || tHit || bHit;
            if (anyHit) {
              // Option B: slide ONLY the window so the chibi's CURRENT
              // intra-window position lands flush against the snapped edges.
              // The chibi stays put inside the frame — no visual jump.
              // Window may extend off-screen on the opposite side; that's
              // fine because that area is transparent + click-through.
              let nx = winPos.x, ny = winPos.y;
              if (lHit) nx = m.position.x        - (cr.left + cal.left)   * dpr;
              if (rHit) nx = m.position.x + m.size.width  - (cr.left + cal.right)  * dpr;
              if (tHit) ny = m.position.y        - (cr.top  + cal.top)    * dpr;
              if (bHit) ny = m.position.y + m.size.height - (cr.top  + cal.bottom) * dpr;
              await win.setPosition(new PhysicalPositionCtor(Math.round(nx), Math.round(ny)));
              const edges = [lHit && "left", rHit && "right", tHit && "top", bHit && "bottom"]
                .filter(Boolean).join("+");
              console.log(`[mascot drag] snapped ${edges} on monitor "${m.name}"`);

              // Visual confirmation: pick the dominant edge (smallest
              // signed distance — the one the chibi is "most against") and
              // tell FloatChat to switch to the matching peek-pose sprite.
              // The CSS bundles peek-pose with chat-hide, so the chibi
              // appears tucked at the screen edge until the user clicks it
              // to wake up.
              const hits: Array<[ForcedEdge, number]> = [
                [lHit ? "left"   : null, dLeft  ],
                [rHit ? "right"  : null, dRight ],
                [tHit ? "top"    : null, dTop   ],
                [bHit ? "bottom" : null, dBottom],
              ];
              const winner = hits
                .filter(([dir]) => dir !== null)
                .sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
              setForceEdge(winner);
            } else {
              // No snap — make sure any previous peek pose is cleared so
              // the chibi doesn't stay tucked after being dragged away.
              setForceEdge(null);
            }

            // Always re-derive forcedSide from the chibi's final visible
            // center — even when no snap fired, the drag may have crossed
            // the monitor midline.
            await refreshSide();
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
  }, [setForcedSide, setForceEdge]);
}

function MascotApp() {
  // ThemeBootstrap applies the persisted Celestial Veil palette to
  // document.documentElement so the chibi's halo, the chat panel, and the
  // model picker all theme identically across the two windows. Without it
  // the mascot would render with the raw CSS-variable defaults (cyan/teal
  // baseline) instead of whatever the user picked in Settings → Tweaks.
  //
  // freezePos: keep the chibi's intra-window position frozen so the snap
  // logic in useMascotWindowDrag is free to slide the OS window without
  // any visual jump of the chibi inside its frame.
  // forceEdge: the host pushes "left"|"right"|"top"|"bottom" on snap so
  // FloatChat shows the peek-pose sprite (visual confirmation of snap),
  // and clears it on drag start so the peek pose doesn't follow the
  // cursor mid-drag.
  const [forcedSide, setForcedSide] = useState<ForcedSide>(null);
  const [forceEdge, setForceEdge] = useState<ForcedEdge>(null);

  // Calibration: load once, then subscribe to cross-window changes from
  // the main IDE's Settings → Mascot panel. The ref pattern keeps the
  // drag hook reading the LATEST values without re-registering listeners
  // on every render.
  const [calibration, setCalibration] = useState<ChibiCalibration>(() => loadCalibration());
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  useEffect(() => subscribeCalibration(setCalibration), []);

  useMascotClickThrough();
  useMascotWindowDrag(setForcedSide, setForceEdge, calibrationRef);
  return (
    <>
      <ThemeBootstrap />
      <FloatShell
        anchor={<ChibiWithMood />}
        disableInternalDrag
        freezePos
        forceSide={forcedSide ?? undefined}
        forceEdge={forceEdge}
      >
        <ChatPanel />
      </FloatShell>
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
