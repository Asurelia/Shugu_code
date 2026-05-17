// Shugu Forge — Dock (bottom/side workspace panel).
//
// Hosts: DockWorkspace (the editor + dock host using react-resizable-panels)
// plus the per-tab content kinds — DockTerminal (xterm.js + real PTY),
// DockAgentChat (in-pane assistant chat), DockOutput (build log), and
// DockProblems (TS diagnostics). Internal helpers (DockPanelInner,
// DockAddMenu, DockSideMenu, DockPaneContent, xterm theme) stay private.

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Icon } from "@/components/components";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke, listen } from "@/lib/tauri";

// ─── Dock workspace: editor + dock as constraint-solved resizable panels ──
// Replaces the old hand-rolled CSS-grid + mousemove resize, which could squeeze
// the editor to 0px (the prototype fought this for ~8 iterations and never won).
// react-resizable-panels does percentage-based, constraint-solved sizing: each
// panel's minSize/maxSize is GUARANTEED — neither the editor nor the dock can
// collapse, and the layout total always stays consistent.
//
// `children` is the editor body (content-body + <Outlet/>), supplied by RootLayout.
export function DockWorkspace({ dockState, setDockState, fileContents, children }: any) {
  const { side } = dockState;
  const set = (patch: any) => setDockState((s: any) => ({ ...s, ...patch }));
  const isHorizontal = side === "bottom" || side === "top"; // panels stacked vertically
  const dockFirst = side === "top" || side === "left";

  const [draggingDock, setDraggingDock] = useState(false);
  const [hoverZone, setHoverZone] = useState<string | null>(null);

  const onDockDragStart = (e: React.DragEvent) => {
    setDraggingDock(true);
    e.dataTransfer.setData("text/plain", "dock");
    e.dataTransfer.effectAllowed = "move";
    const el = document.createElement("div");
    el.style.width = "100px"; el.style.height = "30px";
    el.style.background = "rgba(224,142,254,0.4)";
    el.style.borderRadius = "8px";
    document.body.appendChild(el);
    e.dataTransfer.setDragImage(el, 50, 15);
    setTimeout(() => document.body.removeChild(el), 0);
  };
  const onDockDragEnd = () => { setDraggingDock(false); setHoverZone(null); };

  // Stable React keys ("editor", "dock") so React tracks each Panel by
  // identity rather than by position. Without them, the JSX-order flip
  // driven by `dockFirst` (line below) causes React to interpret the
  // first child as a NEW component on side change, unmounting the
  // existing one — which would kill every DockTerminal inside.
  const editorPanel = (
    <Panel key="editor" id="editor" order={dockFirst ? 2 : 1} minSize={20}>
      {children}
    </Panel>
  );
  const dockPanel = (
    <Panel key="dock" id="dock" order={dockFirst ? 1 : 2} defaultSize={dockState.sizePct ?? 32} minSize={12} maxSize={80}>
      <DockPanelInner
        dockState={dockState}
        setDockState={setDockState}
        fileContents={fileContents}
        onDockDragStart={onDockDragStart}
        onDockDragEnd={onDockDragEnd}
      />
    </Panel>
  );
  const handle = <PanelResizeHandle className={"dock-rrp-handle " + (isHorizontal ? "h" : "v")} />;

  return (
    <>
      <PanelGroup
        // Re-key ONLY on resizeNonce bump (Reset/Maximize re-apply defaultSize
        // via a clean remount). NOT on side change — re-keying on side change
        // would unmount every DockTerminal (term_kill → PTY dies → all shell
        // state lost) every time the user drags the dock to a different edge.
        // react-resizable-panels handles direction changes natively in v2+.
        // The dockFirst-driven JSX-order flip (line ~73) is enough for layout
        // reordering without a remount.
        key={"dock-pg:" + (dockState.resizeNonce ?? 0)}
        direction={isHorizontal ? "vertical" : "horizontal"}
        style={{ flex: 1, minHeight: 0 }}
      >
        {dockFirst
          ? <>{dockPanel}{handle}{editorPanel}</>
          : <>{editorPanel}{handle}{dockPanel}</>}
      </PanelGroup>
      {draggingDock && (
        <div className="dock-zones">
          {["bottom", "top", "left", "right"].map((z) => (
            <div
              key={z}
              className={"dock-zone zone-" + z + (hoverZone === z ? " over" : "")}
              onDragOver={(e) => { e.preventDefault(); setHoverZone(z); }}
              onDragLeave={() => setHoverZone(null)}
              onDrop={(e) => { e.preventDefault(); set({ side: z }); setDraggingDock(false); setHoverZone(null); }}
            >dock {z}</div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Dock panel inner: chrome (tabs/actions) + body (panes + optional split) ──
function DockPanelInner({ dockState, setDockState, fileContents, onDockDragStart, onDockDragEnd }: any) {
  const { side, tabs, activeId, splitActiveId, split, splitRatio } = dockState;
  const set = (patch: any) => setDockState((s: any) => ({ ...s, ...patch }));
  const isHorizontal = side === "bottom" || side === "top";

  // Per-pane tab filtering: each tab carries `pane: 0 | 1` so the main
  // and split panes have INDEPENDENT tabs strips (vscode/iTerm/tmux
  // pattern). Tabs with no pane field default to pane 0 for back-compat.
  const paneTabs = (paneIdx: 0 | 1) => tabs.filter((t: any) => (t.pane ?? 0) === paneIdx);
  const mainTabs = paneTabs(0);
  const splitTabs = paneTabs(1);

  const moveDock = (next: string) => set({ side: next });

  const closeTab = (id: string) => {
    const closing = tabs.find((t: any) => t.id === id);
    if (!closing) return;
    // term_kill on the BACKEND PTY happens here (the user-intent path).
    // Component unmount via route nav / side change does NOT kill — the
    // PTY survives so reattach replays scrollback via term_snapshot.
    if (closing.kind === "term") void invoke('term_kill', { tabId: id });

    const remaining = tabs.filter((t: any) => t.id !== id);
    const inPane = closing.pane ?? 0;
    let nMainActive = activeId;
    let nSplitActive = splitActiveId;
    let nSplit = split;

    if (inPane === 0 && id === activeId) {
      const rest = remaining.filter((t: any) => (t.pane ?? 0) === 0);
      nMainActive = rest[rest.length - 1]?.id || null;
    }
    if (inPane === 1) {
      if (id === splitActiveId) {
        const rest = remaining.filter((t: any) => (t.pane ?? 0) === 1);
        nSplitActive = rest[rest.length - 1]?.id || null;
      }
      // Auto-unsplit when the split pane goes empty: the chrome+body
      // for an empty pane would be confusing.
      if (remaining.filter((t: any) => (t.pane ?? 0) === 1).length === 0) {
        nSplit = false;
        nSplitActive = null;
      }
    }

    set({ tabs: remaining, activeId: nMainActive, splitActiveId: nSplitActive, split: nSplit });
  };

  const addTab = (kind: string, pane: 0 | 1 = 0) => {
    const id = "t" + Date.now();
    const counts = tabs.filter((t: any) => t.kind === kind).length + 1;
    const nameMap: Record<string, string> = { term: "bash", agent: "agent", output: "output", problems: "problems" };
    const newTab: any = {
      id, kind,
      name: `${nameMap[kind]}${kind === "term" ? " · " + counts : ""}`,
      pane,
    };
    if (pane === 0) {
      set({ tabs: [...tabs, newTab], activeId: id });
    } else {
      set({ tabs: [...tabs, newTab], splitActiveId: id, split: true });
    }
  };

  const toggleSplit = () => {
    if (split) {
      // Unsplit: MERGE pane-1 tabs into pane-0 so the user doesn't lose
      // their split-pane terminals (PTYs are still in the registry and
      // their state survives — same pattern vscode uses when collapsing
      // terminal groups). The next "Split" creates a fresh second pane.
      const merged = tabs.map((t: any) => (
        t.pane === 1 ? { ...t, pane: 0 as const } : t
      ));
      set({ tabs: merged, split: false, splitActiveId: null });
      return;
    }
    // Split: create a new shell in pane 1 (vscode/cursor/wezterm pattern,
    // confirmed in research). The active main-pane tab stays where it is.
    const id = "t" + Date.now();
    const counts = tabs.filter((t: any) => t.kind === "term").length + 1;
    const newTab: any = { id, kind: "term", name: `bash · ${counts}`, pane: 1 };
    set({
      tabs: [...tabs, newTab],
      split: true,
      splitActiveId: id,
      splitRatio: 0.55,
    });
  };
  // Maximize: re-apply an 80% dock via a PanelGroup remount (see DockState.resizeNonce).
  const maximize = () => set({ sizePct: 80, resizeNonce: (dockState.resizeNonce ?? 0) + 1 });

  // Split-bar resize between the two dock panes — internal to the dock,
  // bounded 0.2–0.8 so a pane can never collapse.
  const onSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const splitVertical = isHorizontal; // bottom/top dock → panes side by side
    const bodyEl = (e.currentTarget as HTMLElement).parentElement!;
    const rect = bodyEl.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const r = splitVertical
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      set({ splitRatio: Math.max(0.2, Math.min(0.8, r)) });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // A "panel" (one of the up-to-two visible panes) has its own tabs strip,
  // its own active id, and its own + button. Closing a tab kills its PTY
  // (when applicable); closing the last tab of the split pane auto-merges
  // back into a non-split state.
  const renderPane = (paneIdx: 0 | 1, paneTabsList: any[], paneActiveId: string | null) => (
    <div
      key={`pane-${paneIdx}`}
      className="dock-pane"
      style={{
        flex: split ? (paneIdx === 0 ? splitRatio : 1 - splitRatio) : 1,
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div
        className="dock-tabs"
        style={{ flex: "0 0 auto" }}
      >
        {paneTabsList.map((t: any) => (
          <button
            key={t.id}
            className={"dock-tab kind-" + t.kind + (t.id === paneActiveId ? " active" : "")}
            onClick={() => set(paneIdx === 0 ? { activeId: t.id } : { splitActiveId: t.id })}
          >
            <span className="led"></span>
            <span>{t.name}</span>
            <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</span>
          </button>
        ))}
        <DockAddMenu onPick={(k) => addTab(k, paneIdx)} />
      </div>
      <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: "flex", position: "relative" }}>
        {/* Render every tab of THIS pane simultaneously and toggle CSS
            visibility — keeps each PTY+xterm view mounted across tab
            switches WITHIN this pane. Switching pane changes the
            corresponding paneActiveId but doesn't unmount anything. */}
        {paneTabsList.map((t: any) => (
          <div
            key={t.id}
            style={{
              display: t.id === paneActiveId ? "flex" : "none",
              flex: 1,
              flexDirection: "column",
              minHeight: 0,
              minWidth: 0,
              width: "100%",
              height: "100%",
            }}
          >
            <DockPaneContent tab={t} fileContents={fileContents} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className={"dock dock-" + side} style={{ width: "100%", height: "100%" }}>
      {/* Outer chrome: drag handle + global actions (Split, Maximize).
          Tabs strips moved INTO each pane (iTerm/tmux convention) so each
          split pane has its own independent tab group + add button. */}
      <div className="dock-chrome">
        <div
          className="dock-drag"
          title="Drag to dock to a different edge"
          draggable
          onDragStart={onDockDragStart}
          onDragEnd={onDockDragEnd}
        />
        <div style={{ flex: 1 }} />
        <div className="dock-actions">
          <button
            className={"dock-act" + (split ? " on" : "")}
            title={split ? "Close split (merge tabs back into pane 1)" : "Split: open a new terminal in a second pane"}
            onClick={toggleSplit}
          >
            <Icon name="diff" size={13} />
          </button>
          <button className="dock-act" title="Maximize" onClick={maximize}>
            <Icon name="up" size={13} />
          </button>
        </div>
      </div>
      <div className={"dock-body " + (split ? (isHorizontal ? "split-h" : "split-v") : "")}>
        {renderPane(0, mainTabs, activeId)}
        {split && (
          <>
            <div className={"dock-split-bar " + (isHorizontal ? "h" : "v")} onMouseDown={onSplit}></div>
            {renderPane(1, splitTabs, splitActiveId)}
          </>
        )}
      </div>
    </div>
  );
}

function DockAddMenu({ onPick }: { onPick: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // Portal the dropdown to document.body so it isn't clipped by the
  // `.dock-tabs` container (which has `overflow-x: auto` in panels.css:67
  // — that overflow rule clips ANY absolute-positioned child of the tabs
  // strip, including this dropdown). The button stays in place; we
  // compute its bounding rect at open time and position the menu in
  // fixed-coordinate space below it.
  const rect = open && btnRef.current ? btnRef.current.getBoundingClientRect() : null;
  return (
    <>
      <button
        ref={btnRef}
        className="dock-tab-add"
        title="New panel"
        onClick={() => setOpen((o) => !o)}
      >+</button>
      {open && rect && createPortal(
        <>
          <div style={{position:"fixed", inset:0, zIndex:9997}} onClick={() => setOpen(false)}/>
          <div className="ctx-menu" style={{
            position: "fixed",
            top: rect.bottom + 4,
            left: rect.left,
            minWidth: 200,
            zIndex: 9998,
          }}>
            <div className="ctx-section">New panel</div>
            {[
              { k: "term",     l: "Terminal", i: "term",   kbd: "⌘`" },
              { k: "output",   l: "Output",   i: "term" },
              { k: "problems", l: "Problems", i: "shield" },
            ].map(o => (
              <button key={o.k} className="ctx-item" onClick={() => { onPick(o.k); setOpen(false); }}>
                <span className="ico"><Icon name={o.i} size={13}/></span>
                <span className="label">{o.l}</span>
                {o.kbd && <span className="kbd">{o.kbd}</span>}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  );
}

function DockSideMenu({ side, onPick }: { side: string; onPick: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{position:"relative"}}>
      <button className="dock-act" title="Dock position" onClick={() => setOpen(o => !o)}>
        <Icon name="folder" size={13}/>
      </button>
      {open && (
        <>
          <div style={{position:"fixed",inset:0,zIndex:9}} onClick={() => setOpen(false)}/>
          <div className="ctx-menu" style={{position:"absolute", top:30, right:0, minWidth:180, zIndex:20}}>
            <div className="ctx-section">Dock to</div>
            {[
              { v: "bottom", l: "Bottom", kbd: "⌘J" },
              { v: "top",    l: "Top" },
              { v: "left",   l: "Left" },
              { v: "right",  l: "Right" },
            ].map(o => (
              <button key={o.v} className={"ctx-item" + (side === o.v ? " active" : "")} onClick={() => { onPick(o.v); setOpen(false); }}>
                <span className="ico"><Icon name={o.v === "bottom" || o.v === "top" ? "down" : "right"} size={13}/></span>
                <span className="label">{o.l}</span>
                {o.kbd && <span className="kbd">{o.kbd}</span>}
                {side === o.v && <span className="submark">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

function DockPaneContent({ tab, fileContents }: any) {
  if (!tab) return <div style={{padding:24, color:"var(--on-surface-muted)", fontSize:12, fontFamily:"var(--font-mono)"}}>No tab</div>;
  if (tab.kind === "term") return <DockTerminal tabId={tab.id} name={tab.name}/>;
  if (tab.kind === "output") return <DockOutput/>;
  if (tab.kind === "problems") return <DockProblems fileContents={fileContents}/>;
  return null;
}

// ─── Celestial Veil xterm theme ────────────────────────────────
const VEIL_XTERM_THEME: ITheme = {
  background:              "rgba(8,6,16,0.45)",
  foreground:              "#ece8f5",
  cursor:                  "#e08efe",
  cursorAccent:            "#080610",
  selectionBackground:     "rgba(224,142,254,0.22)",
  black:                   "#6e6a89",
  red:                     "#fd6c9c",
  green:                   "#8aefc7",
  yellow:                  "#ffcf6b",
  blue:                    "#81ecff",
  magenta:                 "#e08efe",
  cyan:                    "#81ecff",
  white:                   "#ece8f5",
  brightBlack:             "#a5a0bf",
  brightRed:               "#fd6c9c",
  brightGreen:             "#8aefc7",
  brightYellow:            "#ffcf6b",
  brightBlue:              "#81ecff",
  brightMagenta:           "#e08efe",
  brightCyan:              "#81ecff",
  brightWhite:             "#ffffff",
};

// ─── Dock terminal (xterm.js + real PTY via term_spawn) ────────────────
export function DockTerminal({ tabId, name: _name }: { tabId: string; name: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const term = new Terminal({
      allowTransparency: true,
      theme: VEIL_XTERM_THEME,
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    let opened = false;
    let disposed = false;
    let rafId = 0;
    let dataSub: { dispose: () => void } | null = null;
    let unlistenOut: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    // Two distinct hazards make a naive open()+write() throw
    // "Cannot read properties of undefined (reading 'dimensions')":
    //   1. open() on a 0-sized container → render service never measures.
    //      Fix: gate open() on the container actually being laid out, driven
    //      by the ResizeObserver (the dock pane is 0-sized on mount frame).
    //   2. Even on a sized container, xterm's initial char-cell measurement
    //      isn't ready on the SAME synchronous tick as open(). Writing/fitting
    //      immediately hits Viewport.syncScrollArea before renderService
    //      .dimensions exists. Fix: defer fit()+first write() one frame.
    const writeInitial = async () => {
      if (disposed) return;
      try { fit.fit(); } catch (_) { /* transient zero size */ }
      const cols = term.cols;
      const rows = term.rows;
      term.focus();

      try {
        await invoke('term_spawn', { tabId, cols, rows });
      } catch (err) {
        if (err) term.write(`\r\n[term_spawn error: ${err}]\r\n`);
      }

      // Replay the PTY's recent output buffer (set up by the Rust side
      // for this tab_id) so visual state — cursor, colors, scrollback —
      // is restored when re-mounting against an existing PTY (route
      // navigation, dock side change, React strict-mode double-mount).
      // For a freshly-spawned PTY the snapshot is empty (no-op).
      // This MUST happen BEFORE the listen() below so we don't get a
      // race where new output arrives mid-replay and ends up before
      // the replayed scrollback in the visual buffer.
      try {
        const snapshot = await invoke<string>('term_snapshot', { tabId });
        if (snapshot) term.write(snapshot);
      } catch (err) {
        console.warn('[DockTerminal] term_snapshot failed:', err);
      }

      // ─────────────────────────────────────────────────────────────────
      // NOT TanStack because:
      //
      // Politique du projet (CLAUDE.md "State management") : tout state
      // externe à un composant passe par TanStack Query. CES LISTENERS
      // SONT UNE DÉROGATION DOCUMENTÉE, voici pourquoi :
      //
      //   1. Volume — `term://output/{id}` fire ~50-500 fois par seconde
      //      avec des chunks de bytes ANSI bruts. Stocker dans TanStack
      //      cache (setQueryData append) signifierait :
      //        - Sérialiser le payload à chaque IPC (coût pur)
      //        - Maintenir un Set d'observers TanStack et notifier 50-500
      //          fois/sec par observer (re-render storm potentiel)
      //        - Doubler la mémoire (xterm scrollback + TanStack cache)
      //
      //   2. xterm a son propre buffer scrollback (Terminal#buffer) —
      //      c'est SA responsabilité de tracker les bytes, pas la nôtre.
      //      L'écriture directe `term.write(payload.data)` est l'API
      //      attendue par xterm, optimisée pour ce volume.
      //
      //   3. Pas de consumer React qui doit observer le flux de bytes.
      //      Le rendu est fait par xterm via canvas, hors de React.
      //      Aucun composant ne fait `useTerminalOutput()`. Donc le cache
      //      TanStack n'aurait aucun observer = update silencieuse de cache
      //      sans bénéfice.
      //
      //   4. Le listener est PER-TAB et scope-bound au lifecycle DockTerminal —
      //      attache au mount, détache au unmount via le cleanup useEffect.
      //      Pas de risque d'orphelin cross-window (chaque tab a son propre
      //      DockTerminal mount).
      //
      // SI un jour un consumer React doit observer l'output du terminal
      // (ex: panel "tail des N dernières lignes" séparé du xterm visuel),
      // on créerait une synthetic query `dockKeys.tailBuffer(tabId)` mise
      // à jour ici via setQueryData ratemod (toutes les N ms, pas par
      // byte). Pour l'instant ce besoin n'existe pas.
      // ─────────────────────────────────────────────────────────────────
      unlistenOut = await listen<{ data: string }>(`term://output/${tabId}`, (payload) => {
        if (disposed) return;
        term.write(payload.data);
      });
      unlistenExit = await listen(`term://exit/${tabId}`, () => {
        if (disposed) return;
        term.write('\r\n[Process exited]\r\n');
      });

      dataSub = term.onData((data: string) => {
        void invoke('term_write', { tabId, data });
      });
    };

    const initOrFit = () => {
      if (disposed) return;
      // GUARD: never resize against a 0-sized container. The "render all
      // tabs with display:none" pattern in DockPanelInner means inactive
      // tabs report 0×0 dimensions via the ResizeObserver. Calling
      // fit.fit() then would compute nonsense cols/rows, and any
      // resulting term_resize would put the PTY in a degenerate state
      // (column wrap goes wrong on the next render). Skip silently —
      // the next real layout change brings us back here with real size.
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      if (opened) {
        try { fit.fit(); } catch (_) { /* transient zero size */ }
        // Sync PTY resize with xterm resize (no debounce). The previous
        // 100ms debounce opened a window where xterm rendered at the
        // NEW cols/rows while the PTY still thought it was at the OLD
        // cols/rows — output would wrap at the wrong column and the
        // visual would corrupt. ResizeObserver doesn't fire in a tight
        // loop during normal drag (it batches by frame), so per-event
        // IPC is fine cost-wise.
        void invoke('term_resize', { tabId, cols: term.cols, rows: term.rows });
        return;
      }
      opened = true;
      term.open(el);
      // Defer fit + PTY spawn one frame so xterm's renderer finishes its
      // initial measurement and renderService.dimensions becomes defined.
      rafId = requestAnimationFrame(() => { void writeInitial(); });
    };

    // Trailing-edge debounce ~150 ms on ResizeObserver before calling
    // fit() + term_resize. This is the pattern used by VSCode's terminal
    // and recommended in xterm.js issues #3584, #3962, #4841 — the rAF
    // throttle we tried earlier still fired ~60Hz which left a window
    // where xterm rendered NEW cols while the PTY emitted output at OLD
    // cols, producing the "écrire entre les lignes imprimées" symptom
    // when the user dragged the dock or split-bar horizontally. The 150
    // ms wait holds xterm at its old dimensions until the drag settles,
    // then snaps both xterm and PTY to the final size in one atomic step.
    //
    // The initial fit (on first mount, no drag) still runs synchronously
    // via the bare initOrFit() call below — only subsequent observer
    // fires go through the debounce.
    let resizeTimer = 0;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        resizeTimer = 0;
        initOrFit();
      }, 150);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    initOrFit(); // try immediately in case the container is already sized

    return () => {
      // Cleanup tears down the FRONTEND view (xterm instance + event
      // listeners + observers). It does NOT call term_kill — that would
      // kill the PTY on every unmount, including route navigations away
      // from /code and React strict-mode double-mount. Instead the Rust
      // PTY persists until the user explicitly closes the tab via the ×
      // button in the chrome (which dispatches term_kill from the dock's
      // closeTab handler). On re-mount, term_spawn is idempotent and
      // simply re-attaches.
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (resizeTimer) clearTimeout(resizeTimer);
      dataSub?.dispose();
      unlistenOut?.();
      unlistenExit?.();
      ro.disconnect();
      term.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        background: "rgba(8,6,16,0.45)",
        overflow: "hidden",
      }}
    >
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, minWidth: 0 }}
      />
    </div>
  );
}

// ─── Dock Agent Chat ────────────────────────────────────────
export function DockAgentChat() {
  const [msgs, setMsgs] = useState<any[]>([
    { who: "ai",  text: "Hey. Je suis branché sur ce terminal. Demande-moi un script, un diagnostic, ou laisse-moi exécuter quelque chose.", ts: "now" },
    { who: "user", text: "Trouve toutes les `console.log` dans src/ et propose-moi un script pour les remplacer par un vrai logger.", ts: "now" },
    { who: "ai", text: "Voici la commande, clique pour l'envoyer dans le terminal :", ts: "now" },
    { who: "cmd", text: `rg "console\\.log" src/ -l | xargs -I {} sed -i '' 's/console.log/logger.debug/g' {}` },
    { who: "ai", text: "65 fichiers concernés. Je peux aussi ajouter l'import du logger en haut de chacun si tu veux.", ts: "now" },
  ]);
  const [input, setInput] = useState("");
  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [msgs]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    setMsgs(m => [...m, { who: "user", text: t, ts: "now" }]);
    setInput("");
    setTimeout(() => setMsgs(m => [...m, { who: "ai", text: "Je regarde ça — un instant…", ts: "now" }]), 700);
  };
  const quick = (q: string) => { setInput(q); };

  return (
    <div className="agentpane">
      <div className="agentpane-head">
        <div className="who">terminal agent · shugu-haiku</div>
        <span style={{flex:1}}></span>
        <button className="dock-act" title="Settings"><Icon name="gear" size={12}/></button>
        <button className="dock-act" title="Clear"><Icon name="copy" size={12}/></button>
      </div>
      <div className="agentpane-feed" ref={feedRef}>
        {msgs.map((m, i) => (
          m.who === "cmd"
            ? <div key={i} className="agentpane-msg cmd" title="Click to send to active terminal">
                <span>$ {m.text}</span>
                <span className="run">RUN</span>
              </div>
            : <div key={i} className={"agentpane-msg " + (m.who === "user" ? "user" : "")}>
                <span className={"meta " + (m.who === "user" ? "you" : "ai")}>{m.who === "user" ? "you" : "shugu"} · {m.ts}</span>
                {m.text}
              </div>
        ))}
      </div>
      <div className="agentpane-quick">
        {["explain output", "fix this error", "write a test", "git status?", "kill port 1420"].map(q => (
          <button key={q} onClick={() => quick(q)}>{q}</button>
        ))}
      </div>
      <div className="agentpane-input">
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask about the terminal output, or paste an error…"
          rows={1}
        />
        <button className="send" disabled={!input.trim()} onClick={send}>
          <Icon name="send" size={11}/>
        </button>
      </div>
    </div>
  );
}

// ─── Output pane ────────────────────────────────────────────
export function DockOutput() {
  const lines = [
    { t: "info", time: "14:32:01", text: "[vite] hmr update /src/components/Forge.tsx" },
    { t: "info", time: "14:32:01", text: "[vite] page reload required" },
    { t: "ok",   time: "14:32:02", text: "[tauri] webview reloaded" },
    { t: "warn", time: "14:32:05", text: "[tsc] src/lib/store.ts(34,5): warning TS7053 — element implicitly has 'any' type" },
    { t: "info", time: "14:32:08", text: "[cargo] Compiling shugu-forge v0.4.0" },
    { t: "info", time: "14:32:09", text: "[cargo] Finished release [optimized] target(s) in 18.42s" },
    { t: "err",  time: "14:32:12", text: "[ipc] command \"image::generate\" panicked: model `flux.1-veil` not found on disk" },
    { t: "info", time: "14:32:13", text: "[forge] retrying with model `flux.1-schnell`…" },
    { t: "ok",   time: "14:32:18", text: "[forge] generation complete · 1024×1024 · 4.2s" },
  ];
  return (
    <div className="output-pane">
      {lines.map((l, i) => (
        <div key={i} className={"out-" + l.t}>
          <span className="out-time">{l.time}</span>{l.text}
        </div>
      ))}
    </div>
  );
}

// ─── Problems pane ──────────────────────────────────────────
export function DockProblems({ fileContents: _fc }: any) {
  const problems = [
    { sev: "err",  file: "src/lib/store.ts", loc: "34:5",  msg: "Property 'messages' does not exist on type 'ForgeStore'." },
    { sev: "warn", file: "src/lib/store.ts", loc: "12:18", msg: "'persist' is declared but never used in this scope." },
    { sev: "warn", file: "src/components/Forge.tsx", loc: "28:9", msg: "React Hook useEffect has a missing dependency: 'model'." },
    { sev: "err",  file: "src-tauri/src/main.rs", loc: "18:5", msg: "cannot find function `image::generate` in this scope" },
    { sev: "warn", file: "src/views/ImageView.tsx", loc: "47:11", msg: "unused variable: `negative`" },
  ];
  return (
    <div className="problems-pane">
      {problems.map((p, i) => (
        <div key={i} className="problem-row">
          <span className={"sev " + p.sev}>{p.sev === "err" ? "!" : "▲"}</span>
          <div style={{flex:1, minWidth:0}}>
            <div><span className="file">{p.file}</span> <span className="loc">:{p.loc}</span></div>
            <div className="msg">{p.msg}</div>
          </div>
          <button className="dock-act" title="Ask Shugu"><Icon name="sparkle" size={12}/></button>
        </div>
      ))}
    </div>
  );
}
