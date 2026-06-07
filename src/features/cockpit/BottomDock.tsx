// src/features/cockpit/BottomDock.tsx
// Bottom terminal dock for the cockpit (Codex-style). Opaque container with a
// slim header (title + close button) and a DockTerminal filling the body.
// Opened/closed via layout.bottomDockOpen (store) + Ctrl+` shortcut +
// the "+"-menu "Terminal (bas)" entry in RightPanel.
import { Icon } from "@/components/components";
import { DockTerminal } from "@/features/dock/Dock";
import { setBottomDockOpen } from "./layoutStore";

export function BottomDock() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "var(--surface-container-low, #12121e)",
        overflow: "hidden",
      }}
    >
      {/* Slim header: title + keyboard hint + close button. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "4px 10px",
          borderTop: "1px solid rgba(255,255,255,0.07)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", color: "var(--on-surface-muted, #a5a0bf)" }}>
          Terminal
        </span>
        <span style={{ fontSize: 10, opacity: 0.4, fontFamily: "var(--font-mono)", color: "var(--on-surface-muted, #a5a0bf)" }}>
          Ctrl+`
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="lgb lgb-sm"
          aria-label="Fermer le terminal"
          title="Fermer le terminal (Ctrl+`)"
          onClick={() => setBottomDockOpen(false)}
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      {/* Terminal body: DockTerminal fills remaining height.
          tabId "cockpit-bottom-terminal" is distinct from the right-panel's
          old "cockpit-terminal-1" — idempotent PTY attach on re-mount. */}
      <div style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        <DockTerminal tabId="cockpit-bottom-terminal" name="Terminal" />
      </div>
    </div>
  );
}
