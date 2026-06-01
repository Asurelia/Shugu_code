// src/features/cockpit/CockpitShell.tsx
// The cockpit: chat (left) + a resizable, collapsible right panel (kept mounted
// for keep-warm). Mirrors the Dock's react-resizable-panels usage. The right
// Panel is `collapsible` and never unmounted, so the editor surface (and thus
// editorViewRef) stays alive while the panel is "closed".
import { useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { Icon } from "@/components/components";
import { ChatView } from "@/features/chat/views-chat";
import { useShell } from "@/routes/shell-context";
import { RightPanel } from "./RightPanel";
import { useCockpitLayout, hydrateLayout, isLayoutHydrated, setRightPanelOpen, openSurface, setSizes } from "./layoutStore";
import { loadLayout } from "./layoutPersistence";

export function CockpitShell({ activeConv }: { activeConv: string }) {
  const shell = useShell();
  const layout = useCockpitLayout();
  const panelRef = useRef<ImperativePanelHandle>(null);
  const didHydrate = useRef(false);
  // Render-gate: the PanelGroup must NOT mount before the persisted layout is
  // in the store. Otherwise it registers panels with DEFAULT_LAYOUT sizes
  // (right panel collapsed → defaultSize 0), and the later imperative expand()
  // both shows a minSize sliver instead of the saved width AND fires onLayout
  // with [80,20], overwriting the persisted [55,45]. Gating on hydration makes
  // `defaultSize` carry the real sizes at first registration.
  //
  // Seed from the session query cache: after the first mount the layout stays
  // cached, so re-navigating into the cockpit skips the loader flash (the
  // spinner only ever shows on the very first mount of the session).
  const [hydrated, setHydrated] = useState(() => isLayoutHydrated());

  // Hydrate the store from SQLite once at mount (LOCAL-FIRST restore).
  useEffect(() => {
    let alive = true;
    void loadLayout().then((l) => {
      if (alive && !didHydrate.current) {
        didHydrate.current = true;
        hydrateLayout(l);
        setHydrated(true);
      }
    });
    return () => { alive = false; };
  }, []);

  // Drive the imperative collapse/expand from the store's rightPanelOpen.
  // expand() takes the persisted width so opening-from-closed restores the
  // saved size rather than snapping to minSize (the panel's prev-size map is
  // empty until it has collapsed at least once).
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (layout.rightPanelOpen && p.isCollapsed()) p.expand(layout.sizes[1]);
    if (!layout.rightPanelOpen && !p.isCollapsed()) p.collapse();
  }, [layout.rightPanelOpen]);

  // Wait for the persisted layout before mounting the PanelGroup so defaultSize
  // is correct at first registration. `.loading .ring` is the app's standard
  // loader (same as RootLayout's Suspense fallback).
  if (!hydrated) {
    return <div className="loading"><div className="ring"></div></div>;
  }

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
