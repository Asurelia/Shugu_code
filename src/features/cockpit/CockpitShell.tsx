// src/features/cockpit/CockpitShell.tsx
// The cockpit: chat (left) + a resizable, collapsible right panel (kept mounted
// for keep-warm). Mirrors the Dock's react-resizable-panels usage. The right
// Panel is `collapsible` and never unmounted, so the editor surface (and thus
// editorViewRef) stays alive while the panel is "closed".
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
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

  // Portal the right-panel toggle into the titlebar slot (sits with
  // History/Bell, mirroring the left side-panel toggle). Guard for null so
  // the cockpit is safe even when mounted before the titlebar DOM is ready.
  const tbRightSlot = document.getElementById("tb-right-panel-slot");
  const rightPanelToggle = (
    <button
      className="tb-action"
      aria-label="Afficher/Masquer le panneau"
      title="Afficher/Masquer le panneau (Éditeur / Révision)"
      onClick={() => {
        if (layout.rightPanelOpen) {
          setRightPanelOpen(false);
        } else {
          openSurface(layout.activeSurface);
        }
      }}
    >
      {/* Mirrors the left tb-side-toggle but flipped: divider on the right
          side (x=15) and chevron direction reflects panel open/closed state. */}
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="16" rx="2"/>
        <line x1="15" y1="4" x2="15" y2="20"/>
        {layout.rightPanelOpen
          ? <path d="M18 9l3 3-3 3"/>
          : <path d="M12 9l3 3-3 3"/>}
      </svg>
    </button>
  );

  return (
    <div className="cockpit" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      {/* Portal the toggle into the titlebar right cluster (next to History/Bell). */}
      {tbRightSlot && createPortal(rightPanelToggle, tbRightSlot)}

      <PanelGroup
        direction="horizontal"
        style={{ flex: 1, minHeight: 0 }}
        onLayout={(sizes) => {
          // Persist only when the panel is expanded (two real sizes).
          if (sizes.length === 2 && sizes[1] > 1) setSizes([sizes[0], sizes[1]]);
        }}
      >
        <Panel id="cockpit-chat" order={1} minSize={30} defaultSize={layout.sizes[0]}>
          {/* position:relative + overflow:hidden is REQUIRED here: ChatView's
              root `.cx` is `position:absolute; inset:0`, so without a positioned
              wrapper it fills the whole `.cockpit` instead of this panel — the
              chat would overflow full-width under the right panel. This wrapper
              confines the chat to its panel so the split actually shrinks it.
              disableSplit: suppress the old in-chat split — the right panel IS
              the editor surface in the cockpit. */}
          <div style={{ position: "relative", height: "100%", overflow: "hidden" }}>
            <ChatView
              activeConv={activeConv}
              onOpenSnippet={shell.openSnippetInEditor}
              disableSplit
            />
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
          <RightPanel />
        </Panel>
      </PanelGroup>
    </div>
  );
}
