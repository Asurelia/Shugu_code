// Shugu Forge — Dock, ContextMenu, Account, FloatChat, Connections, Profile, ModelPicker.
// Ported from panels.jsx (60KB original). Window globals removed in favor of ES exports.

import { useState, useEffect, useRef } from "react";
import { Icon } from "@/components/components";
import { Terminal } from "xterm";
import type { ITheme } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import "xterm/css/xterm.css";
import { invoke } from "@/lib/tauri";

// ─── Dock host (terminal + agent chat + output + problems) ─────────
export function DockHost({ dockState, setDockState, fileContents }: any) {
  const { side, size, tabs, activeId, split, splitId, splitRatio } = dockState;
  const set = (patch: any) => setDockState((s: any) => ({ ...s, ...patch }));

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

  const dragRef = useRef<HTMLDivElement | null>(null);
  const onResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startSize = size;
    const host = (dragRef.current?.closest(".workspace") || dragRef.current?.parentElement) as HTMLElement | null;
    if (!host) return;
    const parent = host.getBoundingClientRect();
    const computedMax = (side === "left" || side === "right")
      ? Math.max(200, parent.width  - 80)
      : Math.max(160, parent.height - 60);
    const dynamicMax = Math.max(computedMax, startSize);
    const onMove = (ev: MouseEvent) => {
      let next = startSize;
      if (side === "bottom") next = startSize - (ev.clientY - startY);
      if (side === "top")    next = startSize + (ev.clientY - startY);
      if (side === "left")   next = startSize + (ev.clientX - startX);
      if (side === "right")  next = startSize - (ev.clientX - startX);
      set({ size: Math.max(120, Math.min(dynamicMax, next)) });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = (side === "left" || side === "right") ? "ew-resize" : "ns-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const startR = splitRatio;
    const splitVertical = (side === "bottom" || side === "top");
    const bodyEl = (e.currentTarget as HTMLElement).parentElement!;
    const rect = bodyEl.getBoundingClientRect();
    void startR;
    const onMove = (ev: MouseEvent) => {
      let r: number;
      if (splitVertical) r = (ev.clientX - rect.left) / rect.width;
      else r = (ev.clientY - rect.top) / rect.height;
      set({ splitRatio: Math.max(0.2, Math.min(0.8, r)) });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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

  const activeTab = tabs.find((t: any) => t.id === activeId);
  const splitTab = split && splitId ? tabs.find((t: any) => t.id === splitId) : null;
  const isHorizontal = side === "bottom" || side === "top";

  const grid = (() => {
    if (side === "bottom") return { gridTemplate: `1fr ${size}px / 1fr`, areas: `"main" "dock"` };
    if (side === "top")    return { gridTemplate: `${size}px 1fr / 1fr`, areas: `"dock" "main"` };
    if (side === "left")   return { gridTemplate: `1fr / ${size}px 1fr`, areas: `"dock main"` };
    if (side === "right")  return { gridTemplate: `1fr / 1fr ${size}px`, areas: `"main dock"` };
    return { gridTemplate: `1fr / 1fr`, areas: `"main"` };
  })();

  return {
    gridStyle: { gridTemplate: grid.gridTemplate, gridTemplateAreas: grid.areas },
    dockNode: (
      <div
        className={"dock dock-" + side}
        style={{ gridArea: "dock" }}
        ref={dragRef}
      >
        <div
          className={"dock-resize " + (isHorizontal ? "h" : "v")}
          style={
            side === "bottom" ? { top: -2, left: 0, right: 0 } :
            side === "top"    ? { bottom: -2, left: 0, right: 0 } :
            side === "left"   ? { right: -2, top: 0, bottom: 0 } :
                                { left: -2, top: 0, bottom: 0 }
          }
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onResize(e); }}
        />
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
            <button className="dock-act" title="Maximize" onClick={() => set({ size: Math.max(size, 540) })}>
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
    ),
    dropZones: draggingDock && (
      <div className="dock-zones">
        {["bottom", "top", "left", "right"].map(z => (
          <div
            key={z}
            className={"dock-zone zone-" + z + (hoverZone === z ? " over" : "")}
            onDragOver={(e) => { e.preventDefault(); setHoverZone(z); }}
            onDragLeave={() => setHoverZone(null)}
            onDrop={(e) => { e.preventDefault(); moveDock(z); setDraggingDock(false); setHoverZone(null); }}
          >dock {z}</div>
        ))}
      </div>
    ),
  };
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
    term.open(el);

    // ResizeObserver provides the initial fit and re-fits on container resize.
    const ro = new ResizeObserver(() => {
      try { fit.fit(); } catch (_) { /* container may have zero dimensions briefly */ }
    });
    ro.observe(el);

    // Print banner and initial prompt.
    term.write(`Shugu Forge · ${name}\r\n`);
    term.write(PROMPT);
    term.focus();

    // Line buffer — must live in a plain var, not React state, to avoid stale closures.
    let lineBuf = "";

    const dataSub = term.onData((data: string) => {
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

    return () => {
      dataSub.dispose();
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

// ─── Mascot — Shugu astronaut (drop-in SVG) ─────────────────
export function MascotAstronaut({ size = 92 }: { size?: number }) {
  return (
    <svg viewBox="0 0 120 144" width={size} height={Math.round(size * 1.2)} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="m-helmet" cx="35%" cy="32%" r="80%">
          <stop offset="0%" stopColor="#5c4d8a"/>
          <stop offset="60%" stopColor="#2a1f4d"/>
          <stop offset="100%" stopColor="#160d2a"/>
        </radialGradient>
        <radialGradient id="m-visor" cx="40%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#a0b3ff"/>
          <stop offset="40%" stopColor="#5063c5"/>
          <stop offset="100%" stopColor="#1c1a4d"/>
        </radialGradient>
        <linearGradient id="m-body" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#f5f1ff"/>
          <stop offset="100%" stopColor="#c9c1e3"/>
        </linearGradient>
        <linearGradient id="m-bodyShade" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgba(255,255,255,0)"/>
          <stop offset="100%" stopColor="rgba(30,16,60,0.35)"/>
        </linearGradient>
        <linearGradient id="m-accent" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fd6c9c"/>
          <stop offset="100%" stopColor="#e08efe"/>
        </linearGradient>
      </defs>
      <ellipse cx="60" cy="142" rx="32" ry="3.5" fill="rgba(0,0,0,0.4)"/>
      <rect x="44" y="98" width="14" height="32" rx="6" fill="url(#m-body)"/>
      <rect x="62" y="98" width="14" height="32" rx="6" fill="url(#m-body)"/>
      <rect x="44" y="98" width="14" height="32" rx="6" fill="url(#m-bodyShade)" opacity="0.6"/>
      <rect x="62" y="98" width="14" height="32" rx="6" fill="url(#m-bodyShade)" opacity="0.6"/>
      <rect x="42" y="124" width="18" height="10" rx="4" fill="#2a1f4d"/>
      <rect x="60" y="124" width="18" height="10" rx="4" fill="#2a1f4d"/>
      <path d="M40,70 Q40,55 60,55 Q80,55 80,70 L82,108 Q82,116 76,116 L44,116 Q38,116 38,108 Z" fill="url(#m-body)"/>
      <path d="M40,70 Q40,55 60,55 Q80,55 80,70 L82,108 Q82,116 76,116 L44,116 Q38,116 38,108 Z" fill="url(#m-bodyShade)" opacity="0.5"/>
      <rect x="50" y="78" width="20" height="14" rx="3" fill="#1d1438"/>
      <circle cx="55" cy="85" r="1.8" fill="#81ecff"/>
      <circle cx="60" cy="85" r="1.8" fill="#fd6c9c"/>
      <circle cx="65" cy="85" r="1.8" fill="#8aefc7"/>
      <rect x="38" y="72" width="44" height="3" fill="url(#m-accent)"/>
      <rect x="24" y="68" width="14" height="34" rx="6" fill="url(#m-body)"/>
      <rect x="82" y="68" width="14" height="34" rx="6" fill="url(#m-body)"/>
      <rect x="24" y="68" width="14" height="34" rx="6" fill="url(#m-bodyShade)" opacity="0.5"/>
      <rect x="82" y="68" width="14" height="34" rx="6" fill="url(#m-bodyShade)" opacity="0.5"/>
      <circle cx="31" cy="104" r="8" fill="url(#m-accent)"/>
      <circle cx="89" cy="104" r="8" fill="url(#m-accent)"/>
      <ellipse cx="60" cy="56" rx="26" ry="6" fill="#1d1438"/>
      <circle cx="60" cy="40" r="28" fill="url(#m-helmet)"/>
      <ellipse cx="60" cy="40" rx="20" ry="18" fill="url(#m-visor)"/>
      <ellipse cx="54" cy="34" rx="6" ry="3" fill="rgba(255,255,255,0.55)"/>
      <ellipse cx="65" cy="38" rx="3" ry="1.5" fill="rgba(255,255,255,0.4)"/>
      <circle cx="54" cy="42" r="1.2" fill="rgba(255,255,255,0.65)"/>
      <circle cx="66" cy="42" r="1.2" fill="rgba(255,255,255,0.65)"/>
      <line x1="60" y1="12" x2="60" y2="6" stroke="#e08efe" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="60" cy="5" r="2.5" fill="#fd6c9c">
        <animate attributeName="r" values="2.5;3.4;2.5" dur="1.8s" repeatCount="indefinite"/>
        <animate attributeName="fill-opacity" values="1;0.6;1" dur="1.8s" repeatCount="indefinite"/>
      </circle>
    </svg>
  );
}

// ─── Floating mini-chat (space-agent style) ─────────────────
export function FloatChat({ pinnedAnno, clearPinned }: any) {
  const [mode, setMode] = useState<"closed" | "compact" | "full">("compact");
  const [pos, setPos] = useState(() => {
    const m = 24;
    return { x: window.innerWidth - 78 - m, y: window.innerHeight - 78 - m };
  });
  const [dragging, setDragging] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const [speech, setSpeech] = useState({ visible: true, text: "Hey · clic pour parler" });
  const [hasKey, setHasKey] = useState(false);
  const [model, setModel] = useState("anthropic/claude-haiku-4-5");
  const [tokens, setTokens] = useState(0);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const movedRef = useRef(false);

  const side = pos.x + 39 > window.innerWidth / 2 ? "right" : "left";

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
        x: Math.max(0, Math.min(p.x, window.innerWidth - 78)),
        y: Math.max(0, Math.min(p.y, window.innerHeight - 78)),
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
    setTimeout(() => {
      setMsgs(m => [...m, { who: "ai", text: "Mock reply — connect a real Anthropic key in Settings → Connections." }]);
      setTokens(n => n + Math.floor(80 + Math.random() * 200));
      setBusy(false);
    }, 900);
  };

  const onAvatarMouseDown = (e: React.MouseEvent) => {
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
        const aw = 78;
        const ah = 78;
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

  const onAvatarClick = () => {
    if (movedRef.current) return;
    if (edge) {
      setEdge(null);
      setPos(p => {
        const aw = 78;
        let nx = p.x, ny = p.y;
        if (edge === "left")   nx = 24;
        if (edge === "right")  nx = window.innerWidth - aw - 24;
        if (edge === "top")    ny = 24;
        if (edge === "bottom") ny = window.innerHeight - aw - 24;
        return { x: nx, y: ny };
      });
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
    setPos(p => ({ x: window.innerWidth - p.x - 78, y: p.y }));
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
          title={edge ? "Cliquer pour ramener" : (mode === "closed" ? "Cliquer pour ouvrir · drag" : "Cliquer pour fermer · double pour étendre · drag pour déplacer")}
        >
          <span className="float-avatar-orbit">
            <span className="float-avatar-flip">
              <MascotAstronaut size={72}/>
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

// Wrap DockHost (returns a non-element object) into a renderable component.
export function DockHostMount(props: any) {
  const r = DockHost(props) as any;
  return <>{r.dockNode}{r.dropZones}</>;
}
