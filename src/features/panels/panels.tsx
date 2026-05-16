// Shugu Forge — Dock, ContextMenu, Account, FloatChat, Connections, Profile, ModelPicker.
// Ported from panels.jsx (60KB original). Window globals removed in favor of ES exports.

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Icon } from "@/components/components";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke, listen } from "@/lib/tauri";
import { useMessages, useActiveConv, useActiveModel, sendChatMessage, createConversation } from "@/features/chat/chat-sync";
import { db } from "@/lib/db";
import { getProviderField, setProviderField, clearProviderConfig, setProviderEnabled } from "@/lib/credentials";
import { useDiscoveredModels, invalidateDiscovery, useDiscoveryStore } from "@/lib/modelDiscovery";
import { useChibiMood } from "@/features/mascot/useChibiMood";
import { Chibi, type ChibiMood } from "@/features/mascot/Chibi";
// Reuse import for FloatChat — same hook, single source of truth for the
// "are any providers actually configured?" question used by both the
// ModelPicker popover and the chibi's mood/send-enabled gating.
// `invalidateDiscovery` is called by ConnCard and AddProviderModal so the
// model picker in every window picks up newly-saved keys without a manual
// refresh.

// Relative time format for chibi history rows (handoff helper).
function fmtAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "j";
}

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

// ContextMenu — moved to its own module. Re-exported so RootLayout's
// existing import keeps working until migrated to the direct path.
export { ContextMenu } from "@/features/panels/ContextMenu";

// AccountDropdown — moved to its own module. Re-exported for RootLayout.
export { AccountDropdown } from "@/features/panels/AccountDropdown";

// ModelPicker — moved to its own module. Re-exported so existing
// imports of ModelPicker from @/features/panels/panels keep working
// until consumers are migrated to @/features/panels/ModelPicker.
export { ModelPicker } from "@/features/panels/ModelPicker";

// Mascot — Chibi component + ChibiMood type live in their own module now.
// Imported above; re-exported here so existing external imports
// (e.g. mascot.tsx, kit.jsx) keep working until they migrate to
// @/features/mascot/Chibi directly.
export { Chibi, type ChibiMood };

// ─── Floating mini-chat (space-agent style) ─────────────────
// `disableInternalDrag`: when true, the chibi avatar's mousedown becomes a
// no-op for drag purposes — click-to-toggle still works. The host (e.g. the
// mascot window in src/mascot.tsx) is then free to install its own
// mousedown handler that moves the OS window instead of repositioning the
// chibi inside the viewport.
// `forceSide`: when provided, overrides the default left/right detection
// (which relies on the chibi's intra-window pos.x). Used by the mascot
// window to flip the chibi + dock the chat panel based on where the WINDOW
// sits on the monitor, not where the chibi is inside the window.
// `freezePos`: when true, NO useEffect touches the chibi's intra-window
// position. Used by the mascot window so a screen-edge snap can slide the
// OS window into place without ever repositioning the chibi inside the
// frame — keeps the chibi visually anchored to wherever the user dropped
// it, no "teleport" feel.
// `forceEdge`: when "left"|"right"|"top"|"bottom", the chibi switches to
// the matching peek pose (gripping the screen edge sprite) and the chat
// panel hides — the shimeji-style "tucked at the edge" state. Pass null
// to un-tuck (e.g. before the user drags away). The host (mascot.tsx)
// sets this on a screen-edge snap so the snap is VISUALLY confirmed by
// the chibi's pose change.
export function FloatChat({ pinnedAnno, clearPinned, disableInternalDrag, forceSide, freezePos, forceEdge }: any) {
  const [mode, setMode] = useState<"closed" | "compact" | "full">("compact");
  // Mood state + derivation + idle ticker are encapsulated in useChibiMood
  // (src/features/mascot/useChibiMood.ts). The hook owns moodOverride,
  // lastInteract, and the 5s ticker — FloatChat only feeds it inputs and
  // calls bumpInteract() from user-interaction handlers.
  const [pos, setPos] = useState(() => {
    // Default: CENTER of viewport, both axes. With FloatChat now only used
    // in the mascot window (M2), the wide-enough mascot frame (≥ 844 px)
    // ensures the chat panel fits flush on EITHER side of the chibi —
    // critical when the host (mascot.tsx) flips forceSide based on which
    // half of the monitor the chibi visible body sits on.
    const w = 156, h = 156;
    return {
      x: Math.round(window.innerWidth  / 2 - w / 2),
      y: Math.round(window.innerHeight / 2 - h / 2),
    };
  });
  // Coupling with the mascot host:
  //   - freezePos=true  → never touch pos (mascot mode: window slides for snap)
  //   - freezePos=false + forceSide set → M3-v2 slide pos.x to side
  //
  // The "freeze" mode trades chat-panel clipping risk for visual stability:
  // when the user drops the chibi loosely on the left half of the screen
  // but the chibi is still rendered at the right of the window, the chat
  // panel may extend past the window's right edge. That's the next thing to
  // address but it's a SOFT bug; the previous "anchor preset" behaviour had
  // a HARD bug where the chibi visually jumped on every snap, which felt
  // like a teleport.
  useEffect(() => {
    if (freezePos) return;
    if (forceSide === "left" || forceSide === "right") {
      setPos(p => ({
        x: forceSide === "left" ? 12 : window.innerWidth - 156 - 12,
        y: p.y,
      }));
    }
  }, [forceSide, freezePos]);
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  // Bridge: when the host pushes a new forceEdge value, mirror it into the
  // internal `edge` state so the rest of the component (peek-pose mood,
  // edge-hidden CSS class, chat hide) works unchanged. The host CLEARS by
  // sending null; subsequent clicks on the chibi (onAvatarClick) can also
  // clear `edge` locally — both paths converge on the same state.
  useEffect(() => {
    if (forceEdge !== undefined) setEdge(forceEdge ?? null);
  }, [forceEdge]);
  const [speech, setSpeech] = useState({ visible: true, text: "Hey · clic pour parler" });
  // `hasKey` is the truth-source for "can the chibi actually chat?". It used
  // to be a local `useState(false)` that toggled when the user clicked the
  // "Set API key" badge — purely decorative, never persisted, never matched
  // reality. Now we derive it from the live discovery: if AT LEAST ONE
  // provider responded with at least one model, we have somewhere to talk to.
  const { data: discoveredModels } = useDiscoveredModels();
  const hasKey = discoveredModels.length > 0;
  // The selected model is shared with the main IDE composer via the
  // chat-sync useActiveModel hook (localStorage + Tauri event). Whatever
  // the user picks in either window applies to BOTH from now on.
  const [model] = useActiveModel();
  // Messages are no longer local state — they live in SQLite and stream in
  // from the chat-sync layer. The mascot window READS the active conv from
  // useActiveConv() (the main IDE's ChatSidebar drives the writes); this
  // window now ALSO writes via the new-convo / load-history actions below.
  const [activeConv, setActiveConv] = useActiveConv();
  const { data: msgs } = useMessages(activeConv);
  const [lastMsgCount, setLastMsgCount] = useState(0);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasUnread, setHasUnread] = useState(false); // an LLM reply arrived while tucked / closed
  // Tab switches the .float-history-shell content: "feed" → current convo,
  // "history" → list of past conversations (loaded from SQLite).
  const [tab, setTab] = useState<"feed" | "history">("feed");
  // Past conversations (excluding the active one) — populated lazily when
  // the history tab opens. `histRefresh` bumps to re-pull after delete /
  // new-convo so the list stays in sync without a full hook rewrite.
  const [historyConvs, setHistoryConvs] = useState<{ id: string; title: string; ts: number }[]>([]);
  const [histRefresh, setHistRefresh] = useState(0);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);

  // Detect "new AI message landed while tucked/closed" so the chibi pops
  // the peek_open expression. Compare the message count against the last
  // observed count — only AI messages added since the user last saw the
  // panel count toward unread.
  useEffect(() => {
    if (msgs.length > lastMsgCount) {
      const newest = msgs[msgs.length - 1];
      if (newest?.role === "ai" && (mode !== "full" || edge)) {
        setHasUnread(true);
      }
    }
    setLastMsgCount(msgs.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msgs.length]);

  const side: "left" | "right" =
    forceSide === "left" || forceSide === "right"
      ? forceSide
      : pos.x + 39 > window.innerWidth / 2 ? "right" : "left";

  // ── History tab: load conversations (excluding the active one) ──
  // Only fetch when the history tab is visible and the panel is open. In
  // web mode (no Tauri / no SQLite), db.conversations.list() returns [] —
  // the empty-state message takes over.
  useEffect(() => {
    if (mode !== "full" || tab !== "history") return;
    let cancelled = false;
    void (async () => {
      try {
        const rows = await db.conversations.list();
        if (cancelled) return;
        const mapped = rows
          .filter((r: any) => r.id !== activeConv && !r.archived)
          .map((r: any) => ({ id: r.id as string, title: (r.title as string) || "Untitled", ts: (r.updated_at as number) ?? Date.now() }));
        setHistoryConvs(mapped);
      } catch {
        if (!cancelled) setHistoryConvs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, tab, activeConv, histRefresh]);

  // ── Chibi tab actions ──
  // newConvo: only fork a fresh row when the current convo has messages —
  // avoids polluting SQLite with empty rows on rapid "+" clicks. After
  // creating, we flip active to the new id so useMessages reloads to [].
  const newConvo = async () => {
    if (msgs.length === 0) {
      // Already on a fresh empty convo — just switch to the feed tab.
      setTab("feed");
      setMode("full");
      return;
    }
    const id = await createConversation("New chat");
    if (id) setActiveConv(id);
    setInput("");
    bumpInteract();
    setTab("feed");
    setMode("full");
    setHistRefresh(n => n + 1);
  };
  // loadConvo: jump to a past conversation. useMessages picks up the new
  // activeConv and refetches automatically.
  const loadConvo = (id: string) => {
    setActiveConv(id);
    setTab("feed");
    setMode("full");
    bumpInteract();
  };
  // deleteConvo: stops event propagation so the row click doesn't also
  // load the deleted conv. Messages are NOT cascade-deleted (no FK in the
  // schema) — pre-existing limitation, orphaned rows are harmless.
  const deleteConvo = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try { await db.conversations.remove(id); } catch { /* no-op */ }
    setHistoryConvs(h => h.filter(c => c.id !== id));
    setHistRefresh(n => n + 1);
  };

  useEffect(() => {
    if (pinnedAnno) {
      setSpeech({ visible: true, text: `Tu as épinglé : "${(pinnedAnno.label || pinnedAnno.text || "").slice(0, 60)}"` });
      if (mode === "closed") setMode("compact");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedAnno]);

  useEffect(() => {
    if (!speech.visible) return;
    const t = setTimeout(() => setSpeech(s => ({ ...s, visible: false })), 5500);
    return () => clearTimeout(t);
  }, [speech.text, speech.visible]);

  useEffect(() => {
    if (mode === "full" && historyRef.current) {
      historyRef.current.scrollTop = historyRef.current.scrollHeight;
    }
  }, [msgs, mode]);

  useEffect(() => {
    const onResize = () => {
      setPos(p => ({
        x: Math.max(0, Math.min(p.x, window.innerWidth - 156)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - 156)),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const send = () => {
    const t = input.trim();
    if (!t || !hasKey) return;
    setInput("");
    setBusy(true);
    setMode("full");
    bumpInteract();
    // sendChatMessage handles both user + AI message persistence in SQLite
    // and broadcasts chat://messages-changed — useMessages above picks up
    // both events and re-renders the history feed. The main IDE's ChatView
    // sees the same updates on its side.
    void (async () => {
      try {
        await sendChatMessage(activeConv, t, model);
      } finally {
        setBusy(false);
        bumpInteract();
      }
    })();
  };

  // Clear the unread flag once the user actually sees the conversation
  // (panel expanded to "full") or starts typing again.
  useEffect(() => {
    if (mode === "full" && hasUnread) setHasUnread(false);
  }, [mode, hasUnread]);
  useEffect(() => {
    if (input && hasUnread) setHasUnread(false);
  }, [input, hasUnread]);

  // Mood derivation, manual override + idle ticker are owned by useChibiMood.
  // See src/features/mascot/useChibiMood.ts for the priority table.
  const { mood, cycleMood, bumpInteract } = useChibiMood({
    edge,
    hasUnread,
    busy,
    hasKey,
    pinnedAnno,
    hasMessages: msgs.length > 0,
  });

  const onAvatarMouseDown = (e: React.MouseEvent) => {
    // When the host (mascot window) drives drag at the OS level, bail
    // out — but still preventDefault so the browser doesn't initiate
    // text selection on the SVG/img inside the avatar.
    if (disableInternalDrag) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    movedRef.current = false;
    const startX = e.clientX, startY = e.clientY;
    const startPos = { ...pos };
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true;
      const nx = Math.max(-30, Math.min(window.innerWidth - 48, startPos.x + dx));
      const ny = Math.max(-30, Math.min(window.innerHeight - 48, startPos.y + dy));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setPos(p => {
        const SNAP = 14;
        const aw = 156;
        const ah = 156;
        const distLeft   = p.x;
        const distRight  = window.innerWidth - (p.x + aw);
        const distTop    = p.y;
        const distBottom = window.innerHeight - (p.y + ah);
        const minDist = Math.min(distLeft, distRight, distTop, distBottom);
        if (minDist > SNAP) {
          setEdge(null);
          return p;
        }
        if (minDist === distLeft)   { setEdge("left");   return { x: -aw / 2 + 6, y: p.y }; }
        if (minDist === distRight)  { setEdge("right");  return { x: window.innerWidth - aw / 2 - 6, y: p.y }; }
        if (minDist === distTop)    { setEdge("top");    return { x: p.x, y: -ah / 2 + 6 }; }
        if (minDist === distBottom) { setEdge("bottom"); return { x: p.x, y: window.innerHeight - ah / 2 - 6 }; }
        return p;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onAvatarClick = (e: React.MouseEvent) => {
    if (movedRef.current) return;
    if (e.altKey) { cycleMood(); return; }
    if (edge) {
      setEdge(null);
      // In mascot-mode (freezePos), don't auto-reposition the chibi inside
      // the window on un-tuck — the host is responsible for window
      // positioning. Without this guard, clicking the chibi after a screen-
      // edge snap would teleport it 360 px to the side-buffer position.
      if (!freezePos) {
        setPos(p => {
          const aw = 156;
          let nx = p.x, ny = p.y;
          if (edge === "left")   nx = 24;
          if (edge === "right")  nx = window.innerWidth - aw - 24;
          if (edge === "top")    ny = 24;
          if (edge === "bottom") ny = window.innerHeight - aw - 24;
          return { x: nx, y: ny };
        });
      }
      if (mode === "closed") setMode("compact");
      return;
    }
    setMode(m => m === "closed" ? "compact" : "closed");
  };

  const onAvatarDouble = () => {
    setMode(m => m === "full" ? "compact" : "full");
  };

  const onCtx = (e: React.MouseEvent) => {
    e.preventDefault();
    setPos(p => ({ x: window.innerWidth - p.x - 156, y: p.y }));
  };

  const shellClass = [
    "float-shell",
    "side-" + side,
    mode === "closed" ? "closed" : "",
    mode === "compact" ? "compact" : "",
    mode === "full" ? "full" : "",
    edge ? "edge-hidden edge-hidden-" + edge : "",
    dragging ? "dragging" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={shellClass} style={{ left: pos.x, top: pos.y }}>
      <div className="float-cluster">
        {speech.visible && mode !== "closed" && !edge && (
          <div className="float-speech" onClick={() => setSpeech(s => ({ ...s, visible: false }))}>
            {speech.text}
          </div>
        )}
        <button
          className="float-avatar-btn"
          onMouseDown={onAvatarMouseDown}
          onClick={onAvatarClick}
          onDoubleClick={onAvatarDouble}
          onContextMenu={onCtx}
          title={edge
            ? "Cliquer pour ramener"
            : (mode === "closed"
              ? "Cliquer pour ouvrir · drag · alt+clic pour changer d'humeur"
              : "Cliquer pour fermer · double pour étendre · drag pour déplacer · alt+clic pour humeur")}
        >
          <span className="float-avatar-orbit">
            <span className="float-avatar-flip">
              <Chibi size={240} mood={mood}/>
            </span>
          </span>
          <span className="float-avatar-glow"></span>
        </button>
        {edge && <span className="float-edge-tip">Click to bring back</span>}
      </div>

      <div className="float-body">
        {mode === "full" && (
          <div className="float-history-shell">
            {tab === "feed" ? (
              <div className="float-history" ref={historyRef}>
                {msgs.length === 0 && (
                  <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                    No conversation yet — say something.
                  </div>
                )}
                {msgs.map((m) => (
                  <div key={String(m.id)} className={"fm " + (m.role === "user" ? "you" : "ai")}>
                    {m.text ?? m.body ?? ""}
                  </div>
                ))}
              </div>
            ) : (
              <div className="float-history-list">
                {historyConvs.length === 0 ? (
                  <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                    Pas encore d'historique.
                  </div>
                ) : (
                  historyConvs.map((h) => (
                    <div key={h.id} className="fhl-item" onClick={() => loadConvo(h.id)}>
                      <div className="fhl-info">
                        <span className="t">{h.title}</span>
                        <span className="m">{fmtAgo(h.ts)}</span>
                      </div>
                      <button className="fhl-del" onClick={(e) => deleteConvo(h.id, e)} title="Supprimer">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>
                        </svg>
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {mode === "full" && (
          <div className="float-tabs">
            <button className={"float-tab" + (tab === "feed" ? " on" : "")} onClick={() => setTab("feed")} title="Chat">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span>Chat</span>
              {msgs.length > 0 && <span className="float-tab-count">{msgs.length}</span>}
            </button>
            <button className="float-tab new" onClick={() => { void newConvo(); }} title="Nouvelle conversation">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>Nouveau</span>
            </button>
            <button className={"float-tab" + (tab === "history" ? " on" : "")} onClick={() => setTab("history")} title="Historique">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span>Historique</span>
              {historyConvs.length > 0 && <span className="float-tab-count">{historyConvs.length}</span>}
            </button>
          </div>
        )}

        <div className="float-panel cchrome-naked cstyle-pill csize-thin csend-kbd cfoot-hidden">
          {pinnedAnno && (
            <div className="float-pinned-note">
              pinned
              <span className="target">"{pinnedAnno.label || pinnedAnno.text}"</span>
              <span className="x" onClick={clearPinned}>×</span>
            </div>
          )}

          <div className="float-composer">
            <div style={{position:"relative", minWidth:0}}>
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={busy ? "…" : "Message Shugu…"}
                rows={1}
              />
              {!input && !hasKey && (
                <button
                  className="float-api-badge"
                  type="button"
                  title="Aucun provider configuré — ouvre Settings → Connections dans la fenêtre principale"
                  onClick={async () => {
                    // Cross-window deep-link to Settings → Connections.
                    // 1. Emit a generic navigate event the main window listens to.
                    // 2. Show + unminimize + focus the main window so the user
                    //    actually sees the page that just changed under their
                    //    nose. Each step is independently best-effort: if Tauri
                    //    is somehow unavailable (web mode, missing API) the
                    //    button is just a no-op rather than crashing.
                    try {
                      const eventMod = await import("@tauri-apps/api/event");
                      await eventMod.emit("app://navigate", { path: "/settings/connections" });
                    } catch (err) {
                      console.warn("[chibi] emit navigate failed", err);
                    }
                    try {
                      const winMod = await import("@tauri-apps/api/webviewWindow");
                      const main = await winMod.WebviewWindow.getByLabel("main");
                      if (main) {
                        await main.show();
                        await main.unminimize();
                        await main.setFocus();
                      }
                    } catch (err) {
                      console.warn("[chibi] focus main window failed", err);
                    }
                  }}
                >
                  Set API key
                </button>
              )}
            </div>
            <div className="float-actions-col">
              <span className={"float-kbd-hint" + (input.trim() && hasKey && !busy ? " ready" : "")} onClick={send} title="Send (Enter)">
                <span className="k">↵</span>
              </span>
              <button className="float-icon-btn attach" title="Attach a file or screenshot">
                <Icon name="attach" size={13}/>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// AnnotationLayer — moved to its own module. Re-exported for RootLayout.
export { AnnotationLayer } from "@/features/panels/AnnotationLayer";
// ─── Connections (moved) ────────────────────────────────────
// ConnectionsView + AddProviderModal + ConnCard + types live in their own
// module now. Re-exported so views-code.tsx (its only current consumer)
// keeps working until migrated to the direct path.
export {
  ConnectionsView,
  AddProviderModal,
  ConnCard,
} from "@/features/connections/Connections";
export type { ConnField, ConnCardData } from "@/features/connections/Connections";

export { ProfileView } from "@/features/profile/ProfileView";
