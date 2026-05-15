// Shugu Forge — Dock, ContextMenu, Account, FloatChat, Connections, Profile, ModelPicker.
// Ported from panels.jsx (60KB original). Window globals removed in favor of ES exports.

import { useState, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Icon } from "@/components/components";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@/lib/tauri";

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

  const editorPanel = (
    <Panel id="editor" order={dockFirst ? 2 : 1} minSize={20}>
      {children}
    </Panel>
  );
  const dockPanel = (
    <Panel id="dock" order={dockFirst ? 1 : 2} defaultSize={dockState.sizePct ?? 32} minSize={12} maxSize={80}>
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
        // Re-key on side change (direction + order flip) and on resizeNonce
        // bump (Reset/Maximize re-apply defaultSize via a clean remount).
        key={side + ":" + (dockState.resizeNonce ?? 0)}
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
  const { side, tabs, activeId, split, splitId, splitRatio } = dockState;
  const set = (patch: any) => setDockState((s: any) => ({ ...s, ...patch }));
  const isHorizontal = side === "bottom" || side === "top";

  const moveDock = (next: string) => set({ side: next });
  const closeTab = (id: string) => {
    const idx = tabs.findIndex((t: any) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t: any) => t.id !== id);
    let nActive = activeId;
    let nSplit = splitId;
    if (id === activeId) nActive = next[Math.max(0, idx - 1)]?.id || null;
    if (id === splitId) nSplit = null;
    set({ tabs: next, activeId: nActive, splitId: nSplit, split: nSplit ? split : false });
  };
  const addTab = (kind: string) => {
    const id = "t" + Date.now();
    const counts = tabs.filter((t: any) => t.kind === kind).length + 1;
    const nameMap: Record<string, string> = { term: "bash", agent: "agent", output: "output", problems: "problems" };
    const newTab = { id, kind, name: `${nameMap[kind]}${kind === "term" ? " · " + counts : ""}` };
    set({ tabs: [...tabs, newTab], activeId: id });
  };
  const toggleSplit = () => {
    if (split) { set({ split: false, splitId: null }); return; }
    const other = tabs.find((t: any) => t.id !== activeId);
    if (other) set({ split: true, splitId: other.id, splitRatio: 0.55 });
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

  const activeTab = tabs.find((t: any) => t.id === activeId);
  const splitTab = split && splitId ? tabs.find((t: any) => t.id === splitId) : null;

  return (
    <div className={"dock dock-" + side} style={{ width: "100%", height: "100%" }}>
      <div className="dock-chrome">
        <div
          className="dock-drag"
          title="Drag to dock to a different edge"
          draggable
          onDragStart={onDockDragStart}
          onDragEnd={onDockDragEnd}
        />
        <div className="dock-tabs">
          {tabs.map((t: any) => (
            <button
              key={t.id}
              className={"dock-tab kind-" + t.kind + (t.id === activeId ? " active" : "")}
              onClick={() => set({ activeId: t.id })}
            >
              <span className="led"></span>
              <span>{t.name}</span>
              <span className="x" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>×</span>
            </button>
          ))}
          <DockAddMenu onPick={addTab}/>
        </div>
        <div className="dock-actions">
          <button className={"dock-act" + (split ? " on" : "")} title="Split pane" onClick={toggleSplit}>
            <Icon name="diff" size={13}/>
          </button>
          <DockSideMenu side={side} onPick={moveDock}/>
          <button className="dock-act" title="Maximize" onClick={maximize}>
            <Icon name="up" size={13}/>
          </button>
        </div>
      </div>
      <div className={"dock-body " + (split ? (isHorizontal ? "split-h" : "split-v") : "")}>
        <div className="dock-pane" style={split ? { flex: splitRatio } : {}}>
          <DockPaneContent tab={activeTab} fileContents={fileContents}/>
        </div>
        {split && splitTab && <>
          <div className={"dock-split-bar " + (isHorizontal ? "h" : "v")} onMouseDown={onSplit}></div>
          <div className="dock-pane" style={{ flex: 1 - splitRatio }}>
            <DockPaneContent tab={splitTab} fileContents={fileContents}/>
          </div>
        </>}
      </div>
    </div>
  );
}

function DockAddMenu({ onPick }: { onPick: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{position:"relative"}}>
      <button className="dock-tab-add" title="New panel" onClick={() => setOpen(o => !o)}>+</button>
      {open && (
        <>
          <div style={{position:"fixed",inset:0,zIndex:9}} onClick={() => setOpen(false)}/>
          <div className="ctx-menu" style={{position:"absolute", top:24, left:0, minWidth:200, zIndex:20}}>
            <div className="ctx-section">New panel</div>
            {[
              { k: "term", l: "Terminal", i: "term", kbd: "⌘`" },
              { k: "output", l: "Output", i: "term" },
              { k: "problems", l: "Problems", i: "shield" },
            ].map(o => (
              <button key={o.k} className="ctx-item" onClick={() => { onPick(o.k); setOpen(false); }}>
                <span className="ico"><Icon name={o.i} size={13}/></span>
                <span className="label">{o.l}</span>
                {o.kbd && <span className="kbd">{o.kbd}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
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
  if (tab.kind === "term") return <DockTerminal name={tab.name}/>;
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

const PROMPT = "shugu ❯ ";

// ─── Dock terminal (xterm.js, real line editing) ────────────────
export function DockTerminal({ name }: { name: string }) {
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

    // Line buffer — plain var, not React state, to avoid stale closures.
    let lineBuf = "";
    let opened = false;
    let disposed = false;
    let rafId = 0;
    let dataSub: { dispose: () => void } | null = null;

    // Two distinct hazards make a naive open()+write() throw
    // "Cannot read properties of undefined (reading 'dimensions')":
    //   1. open() on a 0-sized container → render service never measures.
    //      Fix: gate open() on the container actually being laid out, driven
    //      by the ResizeObserver (the dock pane is 0-sized on mount frame).
    //   2. Even on a sized container, xterm's initial char-cell measurement
    //      isn't ready on the SAME synchronous tick as open(). Writing/fitting
    //      immediately hits Viewport.syncScrollArea before renderService
    //      .dimensions exists. Fix: defer fit()+first write() one frame.
    const writeInitial = () => {
      if (disposed) return;
      try { fit.fit(); } catch (_) { /* transient zero size */ }
      term.write(`Shugu Forge · ${name}\r\n`);
      term.write(PROMPT);
      term.focus();
      dataSub = term.onData((data: string) => {
        // Backspace (\x7f): erase one character from buffer and screen.
        if (data === "\x7f") {
          if (lineBuf.length > 0) {
            lineBuf = lineBuf.slice(0, -1);
            term.write("\b \b");
          }
          return;
        }
        // Enter (\r): run the buffered command.
        if (data === "\r") {
          const cmd = lineBuf.trim();
          lineBuf = "";
          term.write("\r\n");
          if (cmd) {
            invoke<string>("term_run", { command: cmd }).then((out) => {
              term.write(out + "\r\n" + PROMPT);
            });
          } else {
            term.write(PROMPT);
          }
          return;
        }
        // Printable characters: echo and append to buffer.
        if (data >= " " || data === "\t") {
          lineBuf += data;
          term.write(data);
        }
      });
    };

    const initOrFit = () => {
      if (disposed) return;
      if (opened) {
        try { fit.fit(); } catch (_) { /* transient zero size */ }
        return;
      }
      if (el.clientWidth === 0 || el.clientHeight === 0) return; // not laid out yet
      opened = true;
      term.open(el);
      // Defer fit + first write one frame so xterm's renderer finishes its
      // initial measurement and renderService.dimensions becomes defined.
      rafId = requestAnimationFrame(writeInitial);
    };

    const ro = new ResizeObserver(initOrFit);
    ro.observe(el);
    initOrFit(); // try immediately in case the container is already sized

    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
      dataSub?.dispose();
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

// ─── Custom right-click context menu ────────────────────────
export function ContextMenu({ open, x, y, target, onClose, onAnnotate }: any) {
  const [submenu, setSubmenu] = useState<string | null>(null);
  if (!open) return null;

  const W = 260, H = 480;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - H - 8);

  const tagColors = [
    { name: "Bug",      hex: "#ff6a8a" },
    { name: "Note",     hex: "#e08efe" },
    { name: "Idea",     hex: "#ffcf6b" },
    { name: "Question", hex: "#81ecff" },
    { name: "Done",     hex: "#8aefc7" },
  ];

  const onItem = (kind: string, payload?: any) => {
    if (kind === "close") { onClose(); return; }
    onAnnotate({ kind, payload, target });
    onClose();
  };

  return (
    <>
      <div style={{position:"fixed", inset:0, zIndex:9998}} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}/>
      <div className="ctx-menu" style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
        {target?.label && (
          <div className="ctx-target-info">
            <span className="badge">{target.kind || "selection"}</span>
            <span className="target-text">{target.label}</span>
          </div>
        )}

        <div className="ctx-section">Annotate</div>
        <button className="ctx-item" onClick={() => onItem("comment")}>
          <span className="ico"><Icon name="chat" size={13}/></span>
          <span className="label">Add comment…</span>
          <span className="kbd">⌘⇧M</span>
        </button>
        <div
          className="ctx-submenu-wrap"
          onMouseEnter={() => setSubmenu("flag")}
          onMouseLeave={() => setSubmenu(null)}
        >
          <button className="ctx-item">
            <span className="ico"><Icon name="thumbs" size={13}/></span>
            <span className="label">Add flag</span>
            <span className="submark">›</span>
          </button>
          {submenu === "flag" && (
            <div className="ctx-menu ctx-submenu">
              <div className="ctx-section">Flag color</div>
              <div className="ctx-color-row">
                {tagColors.map(c => (
                  <div key={c.hex} className="ctx-color" style={{background:c.hex}} title={c.name} onClick={() => onItem("flag", c)}/>
                ))}
              </div>
            </div>
          )}
        </div>
        <div
          className="ctx-submenu-wrap"
          onMouseEnter={() => setSubmenu("tag")}
          onMouseLeave={() => setSubmenu(null)}
        >
          <button className="ctx-item">
            <span className="ico"><Icon name="copy" size={13}/></span>
            <span className="label">Add tag</span>
            <span className="submark">›</span>
          </button>
          {submenu === "tag" && (
            <div className="ctx-menu ctx-submenu">
              <div className="ctx-section">Tag</div>
              {tagColors.map(c => (
                <button key={c.name} className="ctx-item" onClick={() => onItem("tag", c)}>
                  <span className="ico" style={{background:c.hex, width:10, height:10, borderRadius:3}}></span>
                  <span className="label">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="ctx-item" onClick={() => onItem("pin")}>
          <span className="ico"><Icon name="up" size={13}/></span>
          <span className="label">Pin to floating chat</span>
          <span className="kbd">⌘P</span>
        </button>

        <div className="ctx-divider"></div>
        <div className="ctx-section">Shugu</div>
        <button className="ctx-item" onClick={() => onItem("ask")}>
          <span className="ico"><Icon name="sparkle" size={13}/></span>
          <span className="label">Ask Shugu about this</span>
          <span className="kbd">⌘E</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("rewrite")}>
          <span className="ico"><Icon name="sparkle" size={13}/></span>
          <span className="label">Rewrite with Shugu…</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("explain")}>
          <span className="ico"><Icon name="chat" size={13}/></span>
          <span className="label">Explain this</span>
        </button>

        <div className="ctx-divider"></div>
        <button className="ctx-item" onClick={() => onItem("copy")}>
          <span className="ico"><Icon name="copy" size={13}/></span>
          <span className="label">Copy</span>
          <span className="kbd">⌘C</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("paste")}>
          <span className="ico"><Icon name="copy" size={13}/></span>
          <span className="label">Paste</span>
          <span className="kbd">⌘V</span>
        </button>
        <button className="ctx-item" onClick={() => onItem("inspect")}>
          <span className="ico"><Icon name="search" size={13}/></span>
          <span className="label">Inspect element</span>
        </button>
      </div>
    </>
  );
}

// ─── Account dropdown (titlebar avatar) ─────────────────────
export function AccountDropdown({ open, onClose, onView }: any) {
  if (!open) return null;
  return (
    <>
      <div style={{position:"fixed",inset:0,zIndex:199}} onClick={onClose}/>
      <div className="account-pop">
        <div className="account-head">
          <div className="avatar">VU</div>
          <div className="who">
            <div className="name">Vincent Ulrich</div>
            <div className="email">vincent@shugu.dev</div>
          </div>
          <button className="dock-act" title="Edit profile"><Icon name="gear" size={13}/></button>
        </div>

        <div className="account-tier">
          <span className="badge">Pro</span>
          <div className="info">
            <div className="l">Plan</div>
            <div className="v">Shugu Pro · <small>renews May 30</small></div>
          </div>
        </div>

        <div className="account-usage">
          <div className="row"><span>Chat tokens</span><span className="v">128k / 500k</span></div>
          <div className="bar"><div className="fill" style={{width:"26%"}}></div></div>
          <div className="row" style={{marginTop:8}}><span>Image credits</span><span className="v">42 / 200</span></div>
          <div className="bar"><div className="fill" style={{width:"21%"}}></div></div>
        </div>

        <div className="account-menu">
          <button className="account-item" onClick={() => { onView("profile"); onClose(); }}>
            <span className="ico"><Icon name="agent" size={13}/></span>Account & Profile
          </button>
          <button className="account-item" onClick={() => { onView("connections"); onClose(); }}>
            <span className="ico"><Icon name="folder" size={13}/></span>Connections & API keys
          </button>
          <button className="account-item" onClick={() => { onView("privacy"); onClose(); }}>
            <span className="ico"><Icon name="shield" size={13}/></span>Privacy & data
          </button>
          <button className="account-item">
            <span className="ico"><Icon name="copy" size={13}/></span>Billing & invoices
          </button>
          <button className="account-item">
            <span className="ico"><Icon name="sparkle" size={13}/></span>Switch theme
          </button>
          <div className="ctx-divider"></div>
          <button className="account-item">
            <span className="ico"><Icon name="search" size={13}/></span>Help & support
          </button>
          <button className="account-item danger">
            <span className="ico"><Icon name="x" size={13}/></span>Sign out
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Model picker popover (used by float chat footer) ─────────
export function ModelPicker({ model, onChange }: { model: string; onChange: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const models = [
    { group: "Anthropic", items: [
      { id: "anthropic/claude-haiku-4-5", label: "claude-haiku-4-5", meta: "fast · default" },
      { id: "anthropic/claude-sonnet-5",  label: "claude-sonnet-5",  meta: "balanced · 200k" },
      { id: "anthropic/claude-opus-4",    label: "claude-opus-4",    meta: "deep · slow" },
    ]},
    { group: "OpenAI", items: [
      { id: "openai/gpt-4o",       label: "gpt-4o",       meta: "vision · 128k" },
      { id: "openai/gpt-4o-mini",  label: "gpt-4o-mini",  meta: "cheap" },
      { id: "openai/o1-preview",   label: "o1-preview",   meta: "reasoning" },
    ]},
    { group: "Local", items: [
      { id: "ollama/qwen2.5:32b",  label: "qwen2.5:32b",  meta: "local · 32B" },
      { id: "ollama/llama3.3:70b", label: "llama3.3:70b", meta: "local · 70B" },
    ]},
    { group: "Other", items: [
      { id: "mistral/mistral-large", label: "mistral-large", meta: "EU · 128k" },
      { id: "groq/llama-3.3-70b",    label: "groq · llama-3.3-70b", meta: "fast lpu" },
    ]},
  ];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <span ref={ref} style={{position:"relative", minWidth:0}}>
      <button className="float-foot-model" title="Switch model" onClick={() => setOpen(o => !o)}>
        <span className="live"></span>
        <span className="name">{model}</span>
        <Icon name="down" size={10}/>
      </button>
      {open && (
        <div className="model-pop">
          {models.map(g => (
            <div key={g.group}>
              <div className="model-pop-group">{g.group}</div>
              {g.items.map(m => (
                <button key={m.id} className={"model-pop-item" + (m.id === model ? " on" : "")} onClick={() => { onChange(m.id); setOpen(false); }}>
                  <span className="name">{m.label}</span>
                  <span className="meta">{m.meta}</span>
                  {m.id === model && <span className="check">✓</span>}
                </button>
              ))}
            </div>
          ))}
          <div className="model-pop-foot">
            <button className="lgb lgb-sm"><Icon name="plus" size={11}/> Add provider</button>
            <span style={{flex:1}}></span>
            <button className="lgb lgb-sm" onClick={() => setOpen(false)}>Settings →</button>
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Mascot — Shugu chibi (drop-in image) ───────────────────
// Replaces the original astronaut SVG. Moods map to one of 5
// hand-drawn expressions; the 2 "peek" poses are used only when the
// mascot is tucked against a screen edge.
export type ChibiMood =
  | "neutral" | "smile" | "joy" | "sad" | "cry"
  | "peek_open" | "peek_closed";

// PNG assets live in public/assets/chibi/ → served at /assets/chibi/*
// (works identically in web mode and the bundled Tauri webview).
const CHIBI_VARIANTS: Record<ChibiMood, string> = {
  neutral: "/assets/chibi/neutral.png", // calm idle, blue eyes
  smile:   "/assets/chibi/smile.png",   // content, closed eyes
  joy:     "/assets/chibi/joy.png",     // excited, eyes squished shut
  sad:     "/assets/chibi/sad.png",     // worried / half-closed eyes
  cry:     "/assets/chibi/cry.png",     // big teary eyes
  // Peek poses — the figure grips the edge with its hands, the rest
  // off-screen. peek_open = new LLM reply waiting; peek_closed = idle.
  peek_open:   "/assets/chibi/peek_open.png",
  peek_closed: "/assets/chibi/peek_closed.png",
};

const CHIBI_LABELS: Record<ChibiMood, string> = {
  neutral: "Calme",
  smile: "Content·e",
  joy: "Excité·e",
  sad: "Triste",
  cry: "Pleure",
  peek_open: "Coucou !",
  peek_closed: "Repos",
};

export function MascotAstronaut({ size = 92, mood = "neutral" }: { size?: number; mood?: ChibiMood }) {
  const src = CHIBI_VARIANTS[mood] || CHIBI_VARIANTS.neutral;
  const isPeek = mood === "peek_open" || mood === "peek_closed";
  // Peek poses are stickers — render smaller and squarer than the
  // full-body chibi so the head fills the visible area at the edge.
  const w = isPeek ? Math.round(size * 0.4) : size;
  const h = isPeek ? Math.round(size * 0.4) : Math.round(size * 1.2);
  return (
    <div className={"chibi-mascot mood-" + mood} style={{ width: w, height: h }}>
      <img
        src={src}
        alt={"Shugu — " + (CHIBI_LABELS[mood] || mood)}
        draggable={false}
        width={w}
        height={h}
      />
    </div>
  );
}

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
  // moodOverride: null = derived from state; otherwise forces a mood (alt+click cycle).
  const [moodOverride, setMoodOverride] = useState<ChibiMood | null>(null);
  // Last user-interaction timestamp — drives the "lonely" sad face after long idle.
  const [lastInteract, setLastInteract] = useState(Date.now());
  // Ticking clock so we re-derive mood as time passes.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);
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
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState("anthropic/claude-haiku-4-5");
  const [tokens, setTokens] = useState(0);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasUnread, setHasUnread] = useState(false); // an LLM reply arrived while tucked / closed
  const historyRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);

  const side: "left" | "right" =
    forceSide === "left" || forceSide === "right"
      ? forceSide
      : pos.x + 39 > window.innerWidth / 2 ? "right" : "left";

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
    setMsgs(m => [...m, { who: "you", text: t }]);
    setInput("");
    setBusy(true);
    setMode("full");
    setLastInteract(Date.now());
    setTimeout(() => {
      setMsgs(m => [...m, { who: "ai", text: "Mock reply — connect a real Anthropic key in Settings → Connections." }]);
      setTokens(n => n + Math.floor(80 + Math.random() * 200));
      setBusy(false);
      setLastInteract(Date.now());
      // The reply just landed. If the mascot is tucked or closed the
      // user won't see it, so flag it as unread → peek_open expression.
      setHasUnread(true);
    }, 900);
  };

  // Clear the unread flag once the user actually sees the conversation
  // (panel expanded to "full") or starts typing again.
  useEffect(() => {
    if (mode === "full" && hasUnread) setHasUnread(false);
  }, [mode, hasUnread]);
  useEffect(() => {
    if (input && hasUnread) setHasUnread(false);
  }, [input, hasUnread]);

  // Alt+click cycles the mood override; null → first → … → last → null (auto).
  const MOOD_CYCLE: ChibiMood[] = ["neutral", "smile", "joy", "sad", "cry"];
  const cycleMood = () => {
    setMoodOverride(curr => {
      if (curr === null) return MOOD_CYCLE[0];
      const i = MOOD_CYCLE.indexOf(curr);
      if (i === MOOD_CYCLE.length - 1) return null;
      return MOOD_CYCLE[i + 1];
    });
  };

  // ── Mood derivation ──
  // Priority: edge-tucked (peek pose) → manual override → busy (joy) →
  // no key (cry) → pinned annotation (smile) → long idle (sad) →
  // recent interaction (smile) → neutral default.
  const idleMs = now - lastInteract;
  const derivedMood: ChibiMood = (() => {
    if (edge) return hasUnread ? "peek_open" : "peek_closed";
    if (busy) return "joy";
    if (!hasKey) return "cry";
    if (pinnedAnno) return "smile";
    if (idleMs > 60_000) return "sad";
    if (idleMs < 10_000 && msgs.length > 0) return "smile";
    return "neutral";
  })();
  // Manual override doesn't apply when tucked — the peek pose is geometry, not expression.
  const mood: ChibiMood = edge ? derivedMood : (moodOverride || derivedMood);

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
              <MascotAstronaut size={240} mood={mood}/>
            </span>
          </span>
          <span className="float-avatar-glow"></span>
        </button>
        {edge && <span className="float-edge-tip">Click to bring back</span>}
      </div>

      <div className="float-body">
        {mode === "full" && (
          <div className="float-history-shell">
            <div className="float-history" ref={historyRef}>
              {msgs.length === 0 && (
                <div style={{color:"var(--on-surface-muted)", fontSize:12, padding:"24px 8px", textAlign:"center", fontFamily:"var(--font-mono)"}}>
                  No conversation yet — say something.
                </div>
              )}
              {msgs.map((m, i) => <div key={i} className={"fm " + m.who}>{m.text}</div>)}
            </div>
          </div>
        )}

        <div className="float-panel">
          <div className="float-aot"><span className="pulse"></span> always-on-top · persistent</div>

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
                placeholder={busy ? "…" : "Ready. Message Space Agent…"}
                rows={1}
              />
              {!input && !hasKey && (
                <button className="float-api-badge" onClick={() => setHasKey(true)} title="Configure your LLM provider">
                  Set LLM API key
                </button>
              )}
            </div>
            <div className="float-actions-col">
              <button className="float-icon-btn send" disabled={!input.trim() || !hasKey || busy} onClick={send} title="Send (Enter)">
                <Icon name="up" size={15}/>
              </button>
              <button className="float-icon-btn" title="Attach a file or screenshot">
                <Icon name="attach" size={14}/>
              </button>
            </div>
          </div>

          <div className="float-foot">
            <button className={"float-foot-toggle" + (mode === "full" ? " on" : "")} onClick={() => setMode(m => m === "full" ? "compact" : "full")} title={mode === "full" ? "Collapse" : "Expand history"}>
              <Icon name={mode === "full" ? "down" : "up"} size={12}/>
            </button>
            <ModelPicker model={model} onChange={setModel}/>
            <span className="float-foot-tokens"><span className="v">{tokens.toLocaleString()}</span> tokens</span>
            <div className="float-foot-icons">
              <button className="b" title="Sampling parameters">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6"  x2="4"  y2="14"/>
                  <line x1="4" y1="18" x2="4"  y2="22"/>
                  <line x1="12" y1="2" x2="12" y2="10"/>
                  <line x1="12" y1="14" x2="12" y2="22"/>
                  <line x1="20" y1="2" x2="20" y2="14"/>
                  <line x1="20" y1="18" x2="20" y2="22"/>
                  <circle cx="4" cy="16" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="20" cy="16" r="2"/>
                </svg>
              </button>
              <button className="b" title="Conversation history">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6"  x2="21" y2="6"/>
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="18" x2="14" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Inline annotations (rendered absolute over targets) ─────
export function AnnotationLayer({ annotations, onRemove }: any) {
  return (
    <>
      {annotations.map((a: any) => (
        <div key={a.id} className="anno-bubble" style={{ left: a.x, top: a.y }}>
          {a.kind === "flag" && (
            <div className="anno-flag" style={{ borderColor: `transparent ${a.payload?.hex || '#e08efe'} transparent transparent` }} title={a.payload?.name + " · " + (a.label || '')} onClick={() => onRemove(a.id)}/>
          )}
          {a.kind === "tag" && (
            <span className="chip" style={{background: (a.payload?.hex || '#e08efe') + '22', borderColor: a.payload?.hex, color: a.payload?.hex, textTransform:'uppercase', fontFamily:'var(--font-mono)', fontSize:9}}>
              {a.payload?.name}
            </span>
          )}
          {a.kind === "comment" && (
            <div className="anno-comment" onClick={() => onRemove(a.id)}>
              <div className="head">comment · {a.author || "you"}</div>
              {a.text}
            </div>
          )}
          {a.kind === "pin" && <div className="anno-pin" title={a.label}/>}
        </div>
      ))}
    </>
  );
}

// ─── Connections page (settings → connections) ──────────────
export function ConnectionsView() {
  const [tab, setTab] = useState("models");
  const [customModels, setCustomModels] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const tabs = [
    { v: "models",    l: "AI Providers" },
    { v: "tools",     l: "Dev tools" },
    { v: "image",     l: "Image services" },
    { v: "storage",   l: "Storage" },
  ];

  const cards: Record<string, any[]> = {
    models: [
      { id: "anthropic", name: "Anthropic", meta: "Claude / Shugu models", logo: "A", color: "#d97757", status: "connected", fields: [["API key", "sk-ant-…", true]] },
      { id: "openai",    name: "OpenAI",    meta: "GPT-4o, o1, embeddings", logo: "O", color: "#10a37f", status: "disconnected", fields: [["API key", "sk-…", true], ["Org ID", "org-…", false]] },
      { id: "ollama",    name: "Ollama",    meta: "Local model server",     logo: "O", color: "#000",    status: "warn",         fields: [["Endpoint", "http://localhost:11434", false]] },
      { id: "mistral",   name: "Mistral",   meta: "European open-weights",  logo: "M", color: "#ff7000", status: "disconnected", fields: [["API key", "…", true]] },
      { id: "groq",      name: "Groq",      meta: "Fast LPU inference",     logo: "G", color: "#f55036", status: "disconnected", fields: [["API key", "gsk_…", true]] },
    ],
    tools: [
      { id: "github",    name: "GitHub",    meta: "Repos, PRs, issues",         logo: "G", color: "#24292f", status: "connected", fields: [["Personal token", "ghp_…", true]] },
      { id: "gitlab",    name: "GitLab",    meta: "Repos & CI",                 logo: "G", color: "#fc6d26", status: "disconnected", fields: [["Token", "glpat-…", true], ["Host", "https://gitlab.com", false]] },
      { id: "linear",    name: "Linear",    meta: "Issues & projects",          logo: "L", color: "#5e6ad2", status: "disconnected", fields: [["API key", "lin_api_…", true]] },
      { id: "vercel",    name: "Vercel",    meta: "Deploy from Forge",          logo: "▲", color: "#000",    status: "disconnected", fields: [["Token", "…", true]] },
      { id: "docker",    name: "Docker",    meta: "Local daemon",               logo: "D", color: "#2496ed", status: "connected", fields: [["Socket", "/var/run/docker.sock", false]] },
    ],
    image: [
      { id: "replicate", name: "Replicate", meta: "flux.1, sdxl, hosted models", logo: "R", color: "#fff",  status: "connected", fields: [["API token", "r8_…", true]] },
      { id: "stability", name: "Stability AI", meta: "SDXL turbo, SD3",          logo: "S", color: "#9b51e0", status: "disconnected", fields: [["Key", "sk-…", true]] },
      { id: "modal",     name: "Modal",     meta: "Custom inference functions",   logo: "M", color: "#7ee787", status: "disconnected", fields: [["Token", "…", true]] },
    ],
    storage: [
      { id: "drive",  name: "Google Drive", meta: "Sync generations & projects", logo: "D", color: "#4285f4", status: "disconnected", fields: [] },
      { id: "s3",     name: "S3-compatible", meta: "Self-hosted bucket",         logo: "S", color: "#ff9900", status: "disconnected", fields: [["Endpoint", "s3.example.com", false], ["Key ID", "AKIA…", false], ["Secret", "…", true]] },
      { id: "icloud", name: "iCloud Drive", meta: "macOS only",                  logo: "i", color: "#007aff", status: "connected", fields: [] },
    ],
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Connections</h3>
          <p className="sub">Branche tes outils externes. Toutes les clés sont stockées chiffrées dans le keychain de l'OS via Tauri.</p>
          <div className="conn-tabs">
            {tabs.map(t => (
              <button key={t.v} className={"conn-tab-btn" + (tab === t.v ? " on" : "")} onClick={() => setTab(t.v)}>{t.l}</button>
            ))}
          </div>
          <div className="connections-grid">
            {(cards[tab] || []).map((c: any) => <ConnCard key={c.id} c={c}/>)}
            {tab === "models" && customModels.map((c: any) => <ConnCard key={c.id} c={c}/>)}
            {tab === "models" && (
              <div className="conn-add-card" onClick={() => setAdding(true)}>
                <span className="plus"><Icon name="plus" size={18}/></span>
                <div className="t">Add custom provider</div>
                <div className="s">OpenAI-compatible endpoint, vLLM, LM Studio, Together AI, custom router…</div>
              </div>
            )}
          </div>
        </div>
      </div>
      {adding && <AddProviderModal onClose={() => setAdding(false)} onAdd={(c: any) => { setCustomModels(p => [...p, c]); setAdding(false); }}/>}
    </div>
  );
}

export function AddProviderModal({ onClose, onAdd }: any) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("https://");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [kind, setKind] = useState("openai");
  const ok = name && endpoint && key;
  const submit = () => {
    if (!ok) return;
    onAdd({
      id: "custom-" + Date.now(),
      name, meta: kind + " · " + (model || "auto"),
      logo: name[0]?.toUpperCase() || "?",
      color: "#5063c5",
      status: "disconnected",
      fields: [["API key", "•••", true], ["Endpoint", endpoint, false], ["Default model", model || "auto", false]],
    });
  };
  return (
    <div className="palette-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" style={{width: "min(540px, 90%)", padding: 0}}>
        <div style={{padding: "16px 18px", borderBottom: "1px solid rgba(255,255,255,0.05)"}}>
          <div style={{fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15}}>Add custom provider</div>
          <div style={{fontSize: 12, color: "var(--on-surface-variant)", marginTop: 4}}>
            Any OpenAI-compatible endpoint works (LM Studio, vLLM, Together, Fireworks, OpenRouter…).
          </div>
        </div>
        <div style={{padding: 18, display: "flex", flexDirection: "column", gap: 12}}>
          <div className="conn-field">
            <label>Display name</label>
            <div className="input"><input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. OpenRouter, My LM Studio…" autoFocus/></div>
          </div>
          <div className="conn-field">
            <label>Protocol</label>
            <div style={{display:"flex", gap:6}}>
              {[
                { v: "openai", l: "OpenAI compatible" },
                { v: "anthropic", l: "Anthropic" },
                { v: "ollama", l: "Ollama" },
                { v: "custom", l: "Custom" },
              ].map(k => (
                <button key={k.v} className={"conn-tab-btn" + (kind === k.v ? " on" : "")} onClick={() => setKind(k.v)}>{k.l}</button>
              ))}
            </div>
          </div>
          <div className="conn-field">
            <label>Endpoint URL</label>
            <div className="input"><input value={endpoint} onChange={e => setEndpoint(e.target.value)} placeholder="https://api.example.com/v1"/></div>
          </div>
          <div className="conn-field">
            <label>API key</label>
            <div className="input"><input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…"/></div>
          </div>
          <div className="conn-field">
            <label>Default model (optional)</label>
            <div className="input"><input value={model} onChange={e => setModel(e.target.value)} placeholder="gpt-4o-mini, llama-3.3-70b, claude-3-5-sonnet…"/></div>
          </div>
        </div>
        <div style={{padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 8}}>
          <button className="lgb" onClick={onClose}>Cancel</button>
          <span style={{flex:1}}></span>
          <button className="lgb"><Icon name="thumbs" size={11}/> Test connection</button>
          <button className="lgb lgb-primary" disabled={!ok} onClick={submit}>
            <Icon name="plus" size={12}/> Add provider
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConnCard({ c }: any) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((c.fields || []).map(([l]: any) => [l, ""])));
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  return (
    <div className={"conn-card " + (c.status === "connected" ? "connected" : c.status === "warn" ? "warn" : "")}>
      <div className="conn-head">
        <div className="conn-logo" style={{background: c.color, color: c.color === "#000" || c.color === "#24292f" ? "white" : "rgba(0,0,0,0.7)"}}>{c.logo}</div>
        <div className="conn-info">
          <div className="conn-name">{c.name}</div>
          <div className="conn-meta">{c.meta}</div>
        </div>
        <span className={"conn-status " + c.status}>{c.status}</span>
      </div>
      {c.fields && c.fields.length > 0 && c.fields.map(([label, ph, secret]: any) => (
        <div key={label} className="conn-field">
          <label>{label}</label>
          <div className="input">
            <input
              type={secret && !reveal[label] ? "password" : "text"}
              value={vals[label] || ""}
              onChange={(e) => setVals(s => ({ ...s, [label]: e.target.value }))}
              placeholder={ph}
            />
            {secret && (
              <button onClick={() => setReveal(r => ({ ...r, [label]: !r[label] }))} title="Show/hide">
                <Icon name={reveal[label] ? "x" : "search"} size={12}/>
              </button>
            )}
            <button title="Paste">
              <Icon name="copy" size={12}/>
            </button>
          </div>
        </div>
      ))}
      <div className="conn-actions">
        {c.status === "connected"
          ? <><button className="lgb lgb-sm lgb-primary"><Icon name="thumbs" size={11}/> Test</button>
              <button className="lgb lgb-sm">Disconnect</button></>
          : <button className="lgb lgb-sm lgb-primary"><Icon name="sparkle" size={11}/> Connect</button>}
        <span style={{flex:1}}></span>
        <button className="lgb lgb-sm"><Icon name="folder" size={11}/></button>
      </div>
    </div>
  );
}

// ─── Profile ──────────────────────────────────────
export function ProfileView() {
  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Profile</h3>
          <p className="sub">Tes informations personnelles. Stockées uniquement localement, jamais transmises sauf appel API explicite.</p>
          <div className="profile-card">
            <div className="avatar">VU</div>
            <div className="info">
              <div className="name">Vincent Ulrich</div>
              <div className="email">vincent@shugu.dev</div>
              <div className="meta">
                <span className="chip primary">Pro</span>
                <span className="chip">macOS 14 · arm64</span>
                <span className="chip success">verified</span>
              </div>
            </div>
            <button className="lgb lgb-sm">Edit</button>
          </div>
        </div>

        <div className="setting-section">
          <h3>Preferences</h3>
          <div className="conn-field" style={{marginBottom:10}}>
            <label>Display name</label>
            <div className="input"><input defaultValue="Vincent Ulrich" placeholder="Your name"/></div>
          </div>
          <div className="conn-field" style={{marginBottom:10}}>
            <label>Email</label>
            <div className="input"><input defaultValue="vincent@shugu.dev" placeholder="you@domain.com"/></div>
          </div>
          <div className="conn-field" style={{marginBottom:10}}>
            <label>Default language</label>
            <div className="input"><input defaultValue="Français (France)"/></div>
          </div>
          <div className="conn-field">
            <label>Default model</label>
            <div className="input"><input defaultValue="shugu-haiku-4-5"/></div>
          </div>
        </div>
      </div>
    </div>
  );
}
