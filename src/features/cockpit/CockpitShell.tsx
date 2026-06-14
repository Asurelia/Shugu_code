// src/features/cockpit/CockpitShell.tsx
// The cockpit: chat (left) + a resizable, collapsible right panel (kept mounted
// for keep-warm). An outer VERTICAL PanelGroup splits the whole cockpit into
// a top area (chat | right) and a collapsible bottom terminal dock.
// Both panels mirror the same imperative collapse/expand pattern (panelRef +
// layout.rightPanelOpen / bottomRef + layout.bottomDockOpen).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { ChatView } from "@/features/chat/views-chat";
import { useShell } from "@/routes/shell-context";
import { RightPanel } from "./RightPanel";
import { BottomDock } from "./BottomDock";
import {
  useCockpitLayout,
  hydrateLayout,
  isLayoutHydrated,
  setRightPanelOpen,
  openSurface,
  setSizes,
  setBottomDockOpen,
  setBottomDockSize,
  getLayout,
} from "./layoutStore";
import { loadLayout } from "./layoutPersistence";

// react-resizable-panels ne connaît que des POURCENTAGES : un minSize de 12%
// vaut 72px de terminal utile sur une fenêtre de 600px de haut, et 20% de
// right panel devient illisible à 720px de large. Ce hook convertit un
// minimum exprimé en PIXELS en % du conteneur cockpit mesuré en live
// (ResizeObserver — la taille du .cockpit = fenêtre moins titlebar/rail,
// plus juste que window.inner*). Clamp à 90% pour ne jamais rendre un panel
// non-réductible sur une fenêtre minuscule. `el` arrive via callback-ref
// (state) parce que le div cockpit ne monte qu'après l'hydratation du layout.
function useMinSizePct(
  el: HTMLElement | null,
  minPx: number,
  axis: "w" | "h",
  fallbackPct: number,
): number {
  const [pct, setPct] = useState(fallbackPct);
  useEffect(() => {
    if (!el) return;
    const compute = () => {
      const size = axis === "w" ? el.clientWidth : el.clientHeight;
      if (size > 0) setPct(Math.min(90, (minPx / size) * 100));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, minPx, axis]);
  return pct;
}

export function CockpitShell({ activeConv }: { activeConv: string }) {
  const shell = useShell();
  const layout = useCockpitLayout();
  const panelRef = useRef<ImperativePanelHandle>(null);
  const bottomRef = useRef<ImperativePanelHandle>(null);
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

  // Minima des panels en PIXELS réels (convertis en % du cockpit mesuré) :
  // chat 320px, right panel 260px (FileList Révision + diff lisible),
  // dock 140px (header 28px + ~6 lignes de terminal). Les fallbacks sont les
  // anciens minSize statiques, utilisés avant la première mesure.
  const [cockpitEl, setCockpitEl] = useState<HTMLDivElement | null>(null);
  const chatMinPctRaw = useMinSizePct(cockpitEl, 320, "w", 30);
  const rightMinPctRaw = useMinSizePct(cockpitEl, 260, "w", 20);
  const dockMinPct = useMinSizePct(cockpitEl, 140, "h", 12);
  // chat | right vivent dans le MÊME PanelGroup horizontal : react-resizable-
  // panels FIGE tout resize si la somme de leurs minSize dépasse 100 %. La
  // fenêtre min Tauri (720px de large → ~80 %) ne l'atteint pas, mais sur une
  // largeur atypique (sous ~580px) chat 320 + right 260 franchit le seuil. On
  // rabote proportionnellement à 92 % max (8 % de marge pour garder la poignée
  // mobile). Le dock est dans le groupe vertical → hors de cette somme.
  const horizMinSum = chatMinPctRaw + rightMinPctRaw;
  const minScale = horizMinSum > 92 ? 92 / horizMinSum : 1;
  const chatMinPct = chatMinPctRaw * minScale;
  const rightMinPct = rightMinPctRaw * minScale;

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

  // Drive the imperative collapse/expand of the RIGHT panel from the store.
  // expand() takes the persisted width so opening-from-closed restores the
  // saved size rather than snapping to minSize.
  useEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    if (layout.rightPanelOpen && p.isCollapsed()) p.expand(layout.sizes[1]);
    if (!layout.rightPanelOpen && !p.isCollapsed()) p.collapse();
  }, [layout.rightPanelOpen]);

  // Drive the imperative collapse/expand of the BOTTOM dock from the store.
  // Same pattern as above: expand with the persisted size.
  useEffect(() => {
    const b = bottomRef.current;
    if (!b) return;
    if (layout.bottomDockOpen && b.isCollapsed()) b.expand(layout.bottomDockSize);
    if (!layout.bottomDockOpen && !b.isCollapsed()) b.collapse();
  }, [layout.bottomDockOpen]);

  // Ctrl+` keyboard shortcut: toggle the bottom terminal dock.
  // Uses getLayout() (non-hook) to read live state without stale closure.
  // Guards against input/textarea/contenteditable so the backtick is not eaten.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== "`") return;
      const target = e.target as HTMLElement;
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || target.isContentEditable) return;
      e.preventDefault();
      setBottomDockOpen(!getLayout().bottomDockOpen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    <div ref={setCockpitEl} className="cockpit" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      {/* Portal the toggle into the titlebar right cluster (next to History/Bell). */}
      {tbRightSlot && createPortal(rightPanelToggle, tbRightSlot)}

      {/* OUTER vertical PanelGroup: top area (chat | right) + bottom dock. */}
      <PanelGroup
        direction="vertical"
        style={{ flex: 1, minHeight: 0 }}
        onLayout={(sizes) => {
          // Persist bottom dock size only when it is expanded (size > 1).
          if (sizes.length === 2 && sizes[1] > 1) setBottomDockSize(sizes[1]);
        }}
      >
        {/* TOP panel: contains the horizontal chat | right PanelGroup. */}
        <Panel id="cockpit-top" order={1} minSize={30}>
          {/* INNER horizontal PanelGroup: chat (left) | right panel.
              height:100% because the parent is an rrp Panel div (not flex). */}
          <PanelGroup
            direction="horizontal"
            style={{ width: "100%", height: "100%", minHeight: 0 }}
            onLayout={(sizes) => {
              // Persist only when the panel is expanded (two real sizes).
              if (sizes.length === 2 && sizes[1] > 1) setSizes([sizes[0], sizes[1]]);
            }}
          >
            <Panel id="cockpit-chat" order={1} minSize={chatMinPct} defaultSize={layout.sizes[0]}>
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
              minSize={rightMinPct}
              defaultSize={layout.rightPanelOpen ? layout.sizes[1] : 0}
              onCollapse={() => setRightPanelOpen(false)}
              onExpand={() => setRightPanelOpen(true)}
            >
              <RightPanel convId={activeConv} />
            </Panel>
          </PanelGroup>
        </Panel>

        {/* Horizontal resize handle (divides top from bottom). */}
        <PanelResizeHandle className="dock-rrp-handle h" />

        {/* BOTTOM dock: collapsible terminal dock (Codex-style). */}
        <Panel
          id="cockpit-bottom"
          order={2}
          ref={bottomRef}
          collapsible
          collapsedSize={0}
          minSize={dockMinPct}
          defaultSize={layout.bottomDockOpen ? layout.bottomDockSize : 0}
          onCollapse={() => setBottomDockOpen(false)}
          onExpand={() => setBottomDockOpen(true)}
        >
          <BottomDock />
        </Panel>
      </PanelGroup>
    </div>
  );
}
