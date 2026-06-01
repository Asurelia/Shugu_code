// src/features/cockpit/RightPanel.tsx
// Right-panel chrome: tab bar of OPENED surfaces (Codex model) + "+"-menu to
// add more + close button. Hosts SurfaceHost. The tab bar shows only surfaces
// the user has opened; "+" lists the ones not yet open.
import { useState } from "react";
import { Icon } from "@/components/components";
import { SurfaceHost } from "./SurfaceHost";
import { SURFACE_MENU } from "./surfaces";
import { closeSurface, openSurface, setActiveSurface, setRightPanelOpen, useCockpitLayout } from "./layoutStore";

export function RightPanel() {
  const layout = useCockpitLayout();
  const { openedSurfaces, activeSurface } = layout;
  const [menuOpen, setMenuOpen] = useState(false);

  // Surfaces available to add via "+" = those not yet in openedSurfaces.
  const addableSurfaces = SURFACE_MENU.filter((s) => !openedSurfaces.includes(s.id));
  const allOpen = addableSurfaces.length === 0;

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
        {/* Tabs — only opened surfaces. Each has a × to close (hidden when
            it's the last one). */}
        {openedSurfaces.map((id) => {
          const meta = SURFACE_MENU.find((s) => s.id === id);
          if (!meta) return null;
          const isActive = activeSurface === id;
          const isLast = openedSurfaces.length === 1;
          return (
            <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <button
                className={"lgb lgb-sm" + (isActive ? " lgb-primary" : "")}
                onClick={() => setActiveSurface(id)}
              >
                {meta.label}
              </button>
              {!isLast && (
                <button
                  className="lgb lgb-sm"
                  aria-label={`Fermer ${meta.label}`}
                  title={`Fermer ${meta.label}`}
                  style={{ padding: "0 3px", opacity: 0.55 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSurface(id);
                  }}
                >
                  <Icon name="x" size={10} />
                </button>
              )}
            </span>
          );
        })}

        {/* "+"-menu — lists surfaces not yet opened. */}
        <span style={{ position: "relative" }}>
          <button
            className="lgb lgb-sm"
            title={allOpen ? "Toutes les surfaces sont ouvertes" : "Ajouter une surface"}
            disabled={allOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Icon name="sparkle" size={11} /> +
          </button>
          {menuOpen && !allOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 9997 }} onClick={() => setMenuOpen(false)} />
              <div
                className="chat-ctx"
                style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 200, zIndex: 9998 }}
              >
                <div className="chat-ctx-target">Ouvrir une surface</div>
                {addableSurfaces.map((s) => (
                  <button
                    key={s.id}
                    className="chat-ctx-item"
                    onClick={() => {
                      openSurface(s.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="label">{s.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </span>

        <span style={{ flex: 1 }} />

        {/* Close (collapse) the right panel. */}
        <button className="lgb lgb-sm" aria-label="Fermer le panneau" title="Fermer le panneau" onClick={() => setRightPanelOpen(false)}>
          <Icon name="x" size={13} />
        </button>
      </div>

      <SurfaceHost active={activeSurface} />
    </div>
  );
}
