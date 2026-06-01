// src/features/cockpit/CockpitShell.tsx
// The cockpit: chat (left) + a resizable, collapsible right panel (kept mounted
// for keep-warm). Mirrors the Dock's react-resizable-panels usage. The right
// Panel is `collapsible` and never unmounted, so the editor surface (and thus
// editorViewRef) stays alive while the panel is "closed".
import { useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { Icon } from "@/components/components";
import { ChatView } from "@/features/chat/views-chat";
import { useShell } from "@/routes/shell-context";
import { RightPanel } from "./RightPanel";
import { useCockpitLayout, hydrateLayout, setRightPanelOpen, openSurface, setSizes } from "./layoutStore";
import { loadLayout } from "./layoutPersistence";

export function CockpitShell({ activeConv }: { activeConv: string }) {
  const shell = useShell();
  const layout = useCockpitLayout();
  const panelRef = useRef<ImperativePanelHandle>(null);
  const hydrated = useRef(false);

  // Hydrate the store from SQLite once at mount (LOCAL-FIRST restore).
  useEffect(() => {
    let alive = true;
    void loadLayout().then((l) => {
      if (alive && !hydrated.current) {
        hydrated.current = true;
        hydrateLayout(l);
      }
    });
    return () => { alive = false; };
  }, []);

  // Drive the imperative collapse/expand from the store's rightPanelOpen.
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (layout.rightPanelOpen && p.isCollapsed()) p.expand();
    if (!layout.rightPanelOpen && !p.isCollapsed()) p.collapse();
  }, [layout.rightPanelOpen]);

  return (
    <div className="cockpit" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <PanelGroup
        direction="horizontal"
        style={{ flex: 1, minHeight: 0 }}
        onLayout={(sizes) => {
          // Persist only when the panel is expanded (two real sizes).
          if (sizes.length === 2 && sizes[1] > 1) setSizes([sizes[0], sizes[1]]);
        }}
      >
        <Panel id="cockpit-chat" order={1} minSize={30} defaultSize={layout.sizes[0]}>
          <div style={{ position: "relative", height: "100%" }}>
            <ChatView activeConv={activeConv} onOpenSnippet={shell.openSnippetInEditor} />
            {/* Floating "open panel" button when the right panel is collapsed. */}
            {!layout.rightPanelOpen && (
              <button
                className="lgb lgb-sm lgb-primary"
                title="Ouvrir le panneau (Éditeur / Révision)"
                style={{ position: "absolute", top: 10, right: 10, zIndex: 20 }}
                onClick={() => openSurface(layout.activeSurface)}
              >
                <Icon name="code" size={11} /> Panneau
              </button>
            )}
          </div>
        </Panel>

        <PanelResizeHandle className="dock-rrp-handle v" />

        <Panel
          id="cockpit-right"
          order={2}
          ref={panelRef}
          collapsible
          collapsedSize={0}
          minSize={20}
          defaultSize={layout.rightPanelOpen ? layout.sizes[1] : 0}
          onCollapse={() => setRightPanelOpen(false)}
          onExpand={() => setRightPanelOpen(true)}
        >
          <RightPanel active={layout.activeSurface} />
        </Panel>
      </PanelGroup>
    </div>
  );
}
