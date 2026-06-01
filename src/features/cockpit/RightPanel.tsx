// src/features/cockpit/RightPanel.tsx
// Right-panel chrome: tab bar of opened surfaces + "+"-menu to pick a surface +
// close button. Hosts SurfaceHost. The chosen-surface menu mirrors Codex's
// "Ouvrir l'onglet du panneau latéral".
import { useState } from "react";
import { Icon } from "@/components/components";
import { SurfaceHost } from "./SurfaceHost";
import { SURFACE_MENU, surfaceLabel } from "./surfaces";
import { setActiveSurface, openSurface, setRightPanelOpen } from "./layoutStore";
import type { SurfaceId } from "./layout";

export function RightPanel({ active }: { active: SurfaceId }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="cockpit-right" style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0 }}>
      <div
        className="cockpit-right-tabs"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 8px",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        {/* Tabs for the two C1 surfaces (editor/review). */}
        {(["editor", "review"] as SurfaceId[]).map((id) => (
          <button
            key={id}
            className={"lgb lgb-sm" + (active === id ? " lgb-primary" : "")}
            onClick={() => setActiveSurface(id)}
          >
            {surfaceLabel(id)}
          </button>
        ))}

        {/* "+"-menu */}
        <span style={{ position: "relative" }}>
          <button className="lgb lgb-sm" title="Ajouter une surface" onClick={() => setMenuOpen((o) => !o)}>
            <Icon name="sparkle" size={11} /> +
          </button>
          {menuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 9997 }} onClick={() => setMenuOpen(false)} />
              <div
                className="chat-ctx"
                style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 200, zIndex: 9998 }}
              >
                <div className="chat-ctx-target">Ouvrir une surface</div>
                {SURFACE_MENU.map((s) => (
                  <button
                    key={s.id}
                    className="chat-ctx-item"
                    disabled={s.comingSoon}
                    onClick={() => {
                      if (s.comingSoon) return;
                      openSurface(s.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="label">{s.label}</span>
                    {s.comingSoon && <span className="kbd">bientôt</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </span>

        <span style={{ flex: 1 }} />

        {/* Close (collapse) the right panel. */}
        <button className="lgb lgb-sm" title="Fermer le panneau" onClick={() => setRightPanelOpen(false)}>
          <Icon name="x" size={11} />
        </button>
      </div>

      <SurfaceHost active={active} />
    </div>
  );
}
