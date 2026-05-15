// Shugu Forge — entry point for the floating mascot window.
//
// This is a SECOND React root, mounted in mascot.html, which runs in a
// dedicated transparent/always-on-top Tauri window alongside the main IDE
// window. It is intentionally lean — it does NOT import RootLayout,
// ShellContext, TanStack Router, or any of the IDE shell. The mascot
// communicates with the main window via Tauri events (M4), not via React
// context.
//
// M1 — scaffold only: render a placeholder that proves the second window
// loads, gets transparent background, and finds its React root.
// M2 will port the real FloatChat (chibi + chat panel) here.

import React from "react";
import { createRoot } from "react-dom/client";
import "./styles/styles.css";
import "./styles/panels.css";

function MascotApp() {
  return (
    <div
      style={{
        // Centered diagnostic block — small, dark, just enough to prove
        // the window is alive and the transparency works (everything around
        // this box should be desktop, not the app).
        position: "absolute",
        inset: 0,
        display: "grid",
        placeItems: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          padding: "12px 18px",
          background: "rgba(20, 16, 38, 0.92)",
          border: "1px solid rgba(224, 142, 254, 0.45)",
          borderRadius: 12,
          color: "var(--on-surface, #e8e3ff)",
          font: "500 13px/1.4 var(--font-mono, monospace)",
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          pointerEvents: "auto",
          boxShadow: "0 12px 32px rgba(0, 0, 0, 0.55)",
          backdropFilter: "blur(18px) saturate(180%)",
        }}
      >
        🪐 Mascot window scaffold — M1
      </div>
    </div>
  );
}

const root = document.getElementById("mascot-root");
if (!root) throw new Error("mascot-root not found");
createRoot(root).render(
  <React.StrictMode>
    <MascotApp />
  </React.StrictMode>
);
