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
// The hook also derives `forcedSide` ("left" | "right") from the window's
// position on its monitor and pushes it back via `setForcedSide`. That way
// the chibi flips to face the screen interior and the chat panel docks
// AWAY from the screen edge after every drag — when the window sits on
// the right half, side="right" so the panel grows leftward into the
// visible screen, not off-screen.
function useMascotWindowDrag(setForcedSide: (s: "left" | "right" | null) => void) {
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

      // Refresh side based on where the window center sits on its monitor.
      // Right half → side="right" (chibi faces left, chat docks left into
      // visible screen). Left half → side="left" (mirror).
      const refreshSide = async () => {
        try {
          const winPos = await win.outerPosition();
          const winSize = await win.outerSize();
          const monitors = await availableMonitorsFn!();
          const cx = winPos.x + winSize.width / 2;
          const cy = winPos.y + winSize.height / 2;
          const m =
            monitors.find((mn: any) =>
              cx >= mn.position.x && cx < mn.position.x + mn.size.width &&
              cy >= mn.position.y && cy < mn.position.y + mn.size.height
            ) || monitors[0];
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

          // Snap to the closest edge of the monitor under the window's center.
          try {
            const winPos = await win.outerPosition();
            const winSize = await win.outerSize();
            const monitors = await availableMonitorsFn!();
            const cx = winPos.x + winSize.width / 2;
            const cy = winPos.y + winSize.height / 2;
            const m =
              monitors.find((mn: any) =>
                cx >= mn.position.x && cx < mn.position.x + mn.size.width &&
                cy >= mn.position.y && cy < mn.position.y + mn.size.height
              ) || monitors[0];
            if (!m) {
              await refreshSide();
              return;
            }
            const dLeft   = winPos.x - m.position.x;
            const dRight  = (m.position.x + m.size.width)  - (winPos.x + winSize.width);
            const dTop    = winPos.y - m.position.y;
            const dBottom = (m.position.y + m.size.height) - (winPos.y + winSize.height);
            const minD = Math.min(dLeft, dRight, dTop, dBottom);
            const thresholdPhys = SNAP_THRESHOLD_CSS * scale;
            if (minD <= thresholdPhys) {
              let nx = winPos.x, ny = winPos.y;
              if (minD === dLeft)        nx = m.position.x;
              else if (minD === dRight)  nx = m.position.x + m.size.width  - winSize.width;
              else if (minD === dTop)    ny = m.position.y;
              else if (minD === dBottom) ny = m.position.y + m.size.height - winSize.height;
              await win.setPosition(new PhysicalPositionCtor(nx, ny));
              console.log(`[mascot drag] snapped to ${
                minD === dLeft ? "left" : minD === dRight ? "right" : minD === dTop ? "top" : "bottom"
              } edge of monitor "${m.name}"`);
            }
            // Always refresh side after a drag — even if no snap fired,
            // the chibi may have moved across the monitor center.
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
  }, [setForcedSide]);
}

function MascotApp() {
  // ThemeBootstrap applies the persisted Celestial Veil palette to
  // document.documentElement so the chibi's halo, the chat panel, and the
  // model picker all theme identically across the two windows. Without it
  // the mascot would render with the raw CSS-variable defaults (cyan/teal
  // baseline) instead of whatever the user picked in Settings → Tweaks.
  const [forcedSide, setForcedSide] = useState<"left" | "right" | null>(null);
  useMascotClickThrough();
  useMascotWindowDrag(setForcedSide);
  return (
    <>
      <ThemeBootstrap />
      <FloatChat
        pinnedAnno={null}
        clearPinned={() => {}}
        disableInternalDrag
        forceSide={forcedSide ?? undefined}
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
