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

import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";
import { FloatChat } from "@/features/panels/panels";
import { ThemeBootstrap } from "@/lib/ThemeBootstrap";

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

function MascotApp() {
  // ThemeBootstrap applies the persisted Celestial Veil palette to
  // document.documentElement so the chibi's halo, the chat panel, and the
  // model picker all theme identically across the two windows. Without it
  // the mascot would render with the raw CSS-variable defaults (cyan/teal
  // baseline) instead of whatever the user picked in Settings → Tweaks.
  useMascotClickThrough();
  return (
    <>
      <ThemeBootstrap />
      <FloatChat pinnedAnno={null} clearPinned={() => {}} />
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
