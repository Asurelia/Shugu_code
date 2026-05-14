// Shugu Forge — RootLayout: shell chrome + all shared state.
// Replaces the App component. Navigation is now URL-driven via TanStack Router.

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  createContext,
  useContext,
  Suspense,
} from "react";
import { useNavigate, useRouterState, Outlet } from "@tanstack/react-router";

import {
  Icon,
  Titlebar,
  Rail,
  SidePanel,
  SideFiles,
  SideAgents,
  SideGallery,
  SideSettings,
} from "@/components/components";
import { ChatSidebar } from "@/features/chat/chat-sidebar";
import {
  DockHostMount,
  ContextMenu,
  AccountDropdown,
  FloatChat,
  AnnotationLayer,
} from "@/features/panels/panels";
import {
  useTweaks,
  TweaksPanel,
  TweakSection,
  TweakSlider,
  TweakRadio,
  TweakColor,
} from "@/features/tweaks/tweaks-panel";
import { shiftHsl } from "@/lib/colors";

import { seedFileTree } from "@/mocks/seedFileTree";
import { seedFileContents } from "@/mocks/seedFileContents";
import { seedAgents } from "@/mocks/seedAgents";
import { seedGenerations } from "@/mocks/seedGenerations";
import { seedGalleryFolders } from "@/mocks/seedGalleryFolders";
import { seedMessages } from "@/mocks/seedMessages";
import type { DockState } from "@/lib/types";
import { db, seedIfEmpty } from "@/lib/db";

// ─── Types ────────────────────────────────────────────────────

export interface ShellContextValue {
  messages: any[];
  setMessages: React.Dispatch<React.SetStateAction<any[]>>;
  openFiles: string[];
  setOpenFiles: React.Dispatch<React.SetStateAction<string[]>>;
  activeFile: string | null;
  setActiveFile: React.Dispatch<React.SetStateAction<string | null>>;
  fileContents: any;
  setFileContents: React.Dispatch<React.SetStateAction<any>>;
  generations: any[];
  setGenerations: React.Dispatch<React.SetStateAction<any[]>>;
  agents: any[];
}

// ─── Context ─────────────────────────────────────────────────

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error("useShell must be used inside RootLayout");
  return ctx;
}

// ─── Path → view string (derived navigation) ─────────────────

type ViewKey =
  | "chat" | "code" | "image" | "agents"
  | "gallery" | "settings" | "profile" | "connections";

function pathToView(pathname: string): ViewKey {
  if (pathname === "/chat")         return "chat";
  if (pathname === "/code")         return "code";
  if (pathname === "/image")        return "image";
  if (pathname === "/agents")       return "agents";
  if (pathname === "/gallery")      return "gallery";
  if (pathname.startsWith("/settings")) return "settings";
  if (pathname === "/profile")      return "profile";
  if (pathname === "/connections")  return "connections";
  return "chat";
}

function railTargetFor(v: string): string {
  const map: Record<string, string> = {
    chat: "/chat", code: "/code", image: "/image",
    agents: "/agents", gallery: "/gallery", settings: "/settings",
    profile: "/profile", connections: "/connections",
  };
  return map[v] ?? "/chat";
}

function pathToSettingsSection(pathname: string): string {
  if (pathname === "/profile")     return "profile";
  if (pathname === "/connections") return "connections";
  if (pathname === "/settings")    return "general";
  const m = pathname.match(/^\/settings\/(.+)/);
  return m ? m[1] : "general";
}

// ─── TWEAK DEFAULTS ───────────────────────────────────────────

const TWEAK_DEFAULTS = {
  palette: ["#e08efe", "#fd6c9c", "#81ecff"] as [string, string, string],
  glassBlur: 12,
  glassTint: 55,
  backgroundMode: "aurora" as "aurora" | "static" | "off",
  showTweaks: false,
  rail: "wide",
  density: "comfortable",
  auroraIntensity: 55,
};

// ─── CommandPalette (moved from App.tsx) ─────────────────────

function CommandPalette({ open, onClose, setView, onNewChat }: any) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const cmds = useMemo(() => [
    { id: "view-chat",     group: "Navigate", name: "Open Chat",         hint: "switch to conversation",      icon: "chat",    kbd: "⇧⌘C", run: () => setView("chat") },
    { id: "view-code",     group: "Navigate", name: "Open Editor",       hint: "switch to code editor",       icon: "code",    kbd: "⇧⌘E", run: () => setView("code") },
    { id: "view-image",    group: "Navigate", name: "Open Image Studio", hint: "switch to image generator",   icon: "image",   kbd: "⇧⌘I", run: () => setView("image") },
    { id: "view-agents",   group: "Navigate", name: "Show Agents",       hint: "background workers",          icon: "agent",   kbd: "⇧⌘A", run: () => setView("agents") },
    { id: "view-gallery",  group: "Navigate", name: "Open Gallery",      hint: "past generations",            icon: "gallery", kbd: "⇧⌘G", run: () => setView("gallery") },
    { id: "new-chat",      group: "Create",   name: "New Conversation",  hint: "fresh chat",                  icon: "plus",    kbd: "⌘N",  run: () => { setView("chat"); onNewChat(); } },
    { id: "new-image",     group: "Create",   name: "Generate Image…",   hint: "open prompt with cursor",     icon: "sparkle",              run: () => setView("image") },
    { id: "new-agent",     group: "Create",   name: "Dispatch Agent…",   hint: "background task",             icon: "agent",                run: () => setView("agents") },
    { id: "set-model",     group: "Models",   name: "Switch Model · shugu-sonnet-5",   hint: "balanced · 200k ctx", icon: "sparkle", run: () => {} },
    { id: "set-model-h",   group: "Models",   name: "Switch Model · shugu-haiku-4-5",  hint: "fast · default",      icon: "sparkle", run: () => {} },
    { id: "set-model-l",   group: "Models",   name: "Switch Model · local qwen-32b",   hint: "ollama",              icon: "sparkle", run: () => {} },
    { id: "view-settings", group: "Tools",    name: "Settings",          hint: "preferences",                 icon: "gear",    kbd: "⌘,",  run: () => setView("settings") },
  ], [setView, onNewChat]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return cmds;
    return cmds.filter(c => (c.name + " " + (c.hint || "")).toLowerCase().includes(qq));
  }, [q, cmds]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof cmds>();
    filtered.forEach(c => {
      if (!m.has(c.group)) m.set(c.group, []);
      m.get(c.group)!.push(c);
    });
    return [...m.entries()];
  }, [filtered]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx(i => Math.min(i + 1, filtered.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter") {
      e.preventDefault();
      const c = filtered[idx];
      if (c) { c.run(); onClose(); }
    }
  };

  if (!open) return null;

  let cursor = 0;
  return (
    <div className="palette-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <div className="palette-search">
          <Icon name="search" size={16}/>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey} placeholder="Type a command, file, or jump to a view…"/>
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list scroll">
          {grouped.map(([group, items]) => (
            <div key={group}>
              <div className="palette-section-label">{group}</div>
              {items.map(c => {
                const me = cursor++;
                return (
                  <div
                    key={c.id}
                    className={"palette-item" + (me === idx ? " active" : "")}
                    onMouseEnter={() => setIdx(me)}
                    onClick={() => { c.run(); onClose(); }}
                  >
                    <div className="ico"><Icon name={c.icon} size={13}/></div>
                    <div className="body">
                      <div className="name">{c.name}</div>
                      {c.hint && <div className="hint">{c.hint}</div>}
                    </div>
                    {c.kbd && <span className="kbd">{c.kbd}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{padding:"30px 16px", textAlign:"center", color:"var(--on-surface-muted)", fontFamily:"var(--font-mono)", fontSize:12}}>
              No match for "{q}"
            </div>
          )}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑</span><span className="kbd" style={{marginLeft:2}}>↓</span> navigate</span>
          <span><span className="kbd">↵</span> run</span>
          <span className="spacer"></span>
          <span style={{color:"var(--primary)"}}>shugu-forge ⌘K</span>
        </div>
      </div>
    </div>
  );
}

// ─── DockToggleButton (moved from App.tsx) ───────────────────

function DockToggleButton({ dockState, setDockState }: any) {
  const [open, setOpen] = useState(false);
  const isHidden = dockState.side === "hidden";
  const cycle = () => {
    if (isHidden) setDockState((s: any) => ({ ...s, side: s._lastSide || "bottom" }));
    else setDockState((s: any) => ({ ...s, _lastSide: s.side, side: "hidden" }));
  };
  const setSide = (side: string) => { setDockState((s: any) => ({ ...s, side, _lastSide: side })); setOpen(false); };
  return (
    <span style={{position:"relative"}}>
      <button
        className={"lgb lgb-sm" + (isHidden ? "" : " lgb-primary")}
        onClick={cycle}
        onContextMenu={(e) => { e.preventDefault(); setOpen(o => !o); }}
        title={isHidden ? "Show panel (right-click for position)" : "Hide panel (right-click for position)"}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          {dockState.side === "bottom" && <line x1="3"  y1="15" x2="21" y2="15"/>}
          {dockState.side === "top"    && <line x1="3"  y1="9"  x2="21" y2="9"/>}
          {dockState.side === "left"   && <line x1="9"  y1="3"  x2="9"  y2="21"/>}
          {dockState.side === "right"  && <line x1="15" y1="3"  x2="15" y2="21"/>}
        </svg>
        Panel
        <Icon name="down" size={10}/>
      </button>
      {open && (
        <>
          <div style={{position:"fixed",inset:0,zIndex:9997}} onClick={() => setOpen(false)}/>
          <div className="chat-ctx" style={{position:"absolute", top: "calc(100% + 6px)", right: 0, minWidth: 200, zIndex: 9998}}>
            <div className="chat-ctx-target">Panel position</div>
            {[
              { v: "bottom", l: "Bottom", kbd: "⌘J" },
              { v: "top",    l: "Top" },
              { v: "left",   l: "Left" },
              { v: "right",  l: "Right" },
            ].map(o => (
              <button key={o.v} className={"chat-ctx-item" + (dockState.side === o.v ? " on" : "")} onClick={() => setSide(o.v)}>
                <span className="label">{o.l}</span>
                {dockState.side === o.v ? <span className="kbd" style={{color:"var(--primary)"}}>✓</span> : (o.kbd && <span className="kbd">{o.kbd}</span>)}
              </button>
            ))}
            <div className="chat-ctx-sep"></div>
            <button className={"chat-ctx-item" + (dockState.split ? " on" : "")} onClick={() => { setDockState((s: any) => ({ ...s, split: !s.split, splitId: s.split ? null : s.tabs.find((t: any) => t.id !== s.activeId)?.id || s.tabs[1]?.id, splitRatio: 0.55 })); setOpen(false); }}>
              <span className="label">Split pane</span>
              {dockState.split && <span className="kbd" style={{color:"var(--primary)"}}>✓</span>}
            </button>
            <button className="chat-ctx-item" onClick={() => { setDockState((s: any) => ({ ...s, size: 320 })); setOpen(false); }}>
              <span className="label">Reset size</span>
            </button>
            <div className="chat-ctx-sep"></div>
            <button className={"chat-ctx-item" + (isHidden ? "" : " danger")} onClick={() => { cycle(); setOpen(false); }}>
              <span className="label">{isHidden ? "Show panel" : "Hide panel"}</span>
              <span className="kbd">⌘J</span>
            </button>
          </div>
        </>
      )}
    </span>
  );
}

// ─── RootLayout ───────────────────────────────────────────────

export function RootLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Derive view and settings section from path
  const view = pathToView(pathname);
  const settingsSection = pathToSettingsSection(pathname);

  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Chat state
  const [activeConvo, setActiveConvo] = useState("c1");
  const [activeConvoTitle, setActiveConvoTitle] = useState<string | null>(null);
  const [messages, setMessages] = useState(seedMessages);

  // File state
  const [openFiles, setOpenFiles] = useState(["src/components/Forge.tsx", "src-tauri/src/main.rs", "src/lib/store.ts"]);
  const [activeFile, setActiveFile] = useState<string | null>("src/components/Forge.tsx");
  const [fileContents, setFileContents] = useState<any>(seedFileContents);
  const [filesPanelActive, setFilesPanelActive] = useState("src/components/Forge.tsx");

  // Image / gallery state
  const [generations, setGenerations] = useState(seedGenerations);
  const [galleryFolders] = useState(seedGalleryFolders);
  const [activeFolder, setActiveFolder] = useState("g1");

  // Agents
  const [agents] = useState(seedAgents);
  const [activeAgent, setActiveAgent] = useState("a1");

  // Side panel
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideWidth, setSideWidth] = useState(248);

  // Dock
  const [dockState, setDockState] = useState<DockState>({
    side: "bottom",
    size: 280,
    tabs: [
      { id: "t1", kind: "term",     name: "bash · 1" },
      { id: "t2", kind: "agent",    name: "agent" },
      { id: "t3", kind: "output",   name: "output" },
      { id: "t4", kind: "problems", name: "problems" },
    ],
    activeId: "t1",
    split: true,
    splitId: "t2",
    splitRatio: 0.6,
  });

  // Context menu + annotations + account
  const [ctx, setCtx] = useState<any>({ open: false, x: 0, y: 0, target: null });
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [pinnedAnno, setPinnedAnno] = useState<any>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  // Hydrate generations from SQLite on mount (Tauri mode only).
  // seedIfEmpty() ensures a fresh DB has prototype data on first run.
  // TODO: write-through on new generation — wire db.generations.create()
  //        inside ImageView / wherever setGenerations is called downstream.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await seedIfEmpty();
      const rows = await db.generations.list();
      if (!cancelled && rows.length > 0) {
        setGenerations(rows.map((r) => ({
          id: r.id,
          prompt: r.prompt,
          ratio: r.ratio ?? "1:1",
          hue: r.hue ?? 0,
          ts: String(r.ts),
          model: r.model ?? undefined,
          seed: r.seed ?? undefined,
          steps: r.steps ?? undefined,
          guidance: r.guidance ?? undefined,
          style: r.style ?? undefined,
        })));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // CSS variable sync from tweaks
  useEffect(() => {
    const root = document.documentElement;
    const [p, s, te] = tweaks.palette;
    root.style.setProperty("--primary", p);
    root.style.setProperty("--primary-container", shiftHsl(p, -8));
    root.style.setProperty("--primary-dim", shiftHsl(p, -16));
    root.style.setProperty("--secondary", s);
    root.style.setProperty("--secondary-dim", shiftHsl(s, -12));
    root.style.setProperty("--tertiary", te);
    root.style.setProperty("--lg-blur", `${tweaks.glassBlur}px`);
    root.style.setProperty("--lg-tint", `rgba(18, 14, 30, ${tweaks.glassTint / 100})`);
  }, [tweaks.palette, tweaks.glassBlur, tweaks.glassTint]);

  // Cmd+K
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === "Escape" && paletteOpen) {
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen]);

  // Right-click context menu
  const onContext = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (
      t.closest("[data-no-global-ctx]") ||
      t.closest(".chat-side") ||
      t.closest(".chat-ctx") ||
      t.closest(".float-shell") ||
      t.closest(".dock") ||
      t.closest(".rail") ||
      t.closest(".titlebar") ||
      t.closest(".tweaks-panel")
    ) return;
    const label =
      (window.getSelection()?.toString() || "").slice(0, 60) ||
      t?.closest("[data-ctx-label]")?.getAttribute("data-ctx-label") ||
      t?.tagName?.toLowerCase();
    e.preventDefault();
    setCtx({ open: true, x: e.clientX, y: e.clientY, target: { label, kind: t?.tagName?.toLowerCase(), x: e.clientX, y: e.clientY } });
  }, []);

  const onAnnotate = useCallback(({ kind, payload, target }: any) => {
    if (kind === "pin") { setPinnedAnno({ label: target?.label, text: target?.label }); return; }
    if (kind === "ask" || kind === "explain" || kind === "rewrite") { setPinnedAnno({ label: target?.label }); return; }
    if (kind === "comment") {
      const text = window.prompt("Comment:", "") || "";
      if (!text) return;
      setAnnotations(a => [...a, { id: Date.now(), kind, x: target.x + 4, y: target.y - 18, text, label: target.label, payload }]);
      return;
    }
    if (kind === "flag" || kind === "tag") {
      setAnnotations(a => [...a, { id: Date.now(), kind, x: target.x, y: target.y, payload, label: target.label }]);
      return;
    }
  }, []);

  const openFile = (path: string) => {
    setFilesPanelActive(path);
    if (!openFiles.includes(path)) setOpenFiles(p => [...p, path]);
    setActiveFile(path);
  };

  const newChat = () => { setMessages([]); };

  // Navigate helper used by Rail, CommandPalette, AccountDropdown, SideSettings
  const navigateTo = useCallback((v: string) => {
    navigate({ to: railTargetFor(v) as any });
  }, [navigate]);

  // SideSettings section navigation
  const onSideSettingsSection = useCallback((s: string) => {
    if (s === "profile" || s === "connections") {
      navigate({ to: `/${s}` as any });
    } else {
      navigate({ to: s === "general" ? "/settings" : `/settings/${s}` as any });
    }
  }, [navigate]);

  // Side panel per view
  const sidePanel = (() => {
    if (view === "profile" || view === "connections") {
      return (
        <SideSettings
          section={view}
          setSection={onSideSettingsSection}
        />
      );
    }
    if (view === "chat") {
      return (
        <ChatSidebar
          activeId={activeConvo}
          setActiveId={setActiveConvo}
          onActiveTitle={setActiveConvoTitle}
        />
      );
    }
    if (view === "code") {
      return (
        <SideFiles
          tree={seedFileTree}
          active={filesPanelActive}
          onPick={openFile}
        />
      );
    }
    if (view === "agents") {
      return (
        <SideAgents
          agents={agents}
          active={activeAgent}
          onPick={setActiveAgent}
        />
      );
    }
    if (view === "gallery") {
      return (
        <SideGallery
          folders={galleryFolders}
          active={activeFolder}
          onPick={setActiveFolder}
        />
      );
    }
    if (view === "settings") {
      return (
        <SideSettings
          section={settingsSection}
          setSection={onSideSettingsSection}
        />
      );
    }
    return null;
  })();

  const heading = (() => {
    switch (view) {
      case "chat":     return { title: "Conversation",  sub: activeConvoTitle || "(none selected)" };
      case "code":     return { title: "Editor",        sub: activeFile };
      case "image":    return { title: <span><span className="acc">Image Studio</span></span>, sub: "flux.1 · sdxl · lcm-fast" };
      case "agents":   return { title: "Agents",        sub: `${agents.filter((a: any) => a.status === "running").length} running · ${agents.length} total` };
      case "gallery":  return { title: "Gallery",       sub: `${generations.length} generations` };
      case "settings": return { title: "Settings",      sub: settingsSection };
      case "profile":  return { title: "Profile",       sub: "account & personal info" };
      case "connections": return { title: "Connections", sub: "API keys & external tools" };
      default: return { title: "", sub: "" };
    }
  })();

  const isCode = view === "code" && dockState.side !== "hidden";

  // Shared state exposed to leaf routes via context
  const shellValue: ShellContextValue = useMemo(() => ({
    messages, setMessages,
    openFiles, setOpenFiles,
    activeFile, setActiveFile,
    fileContents, setFileContents,
    generations, setGenerations,
    agents,
  }), [
    messages, openFiles, activeFile, fileContents, generations, agents,
    setMessages, setOpenFiles, setActiveFile, setFileContents, setGenerations,
  ]);

  return (
    <ShellContext.Provider value={shellValue}>
      <>
        <div className="desktop">
          <div
            className="aurora"
            style={{ opacity: tweaks.backgroundMode === "off" ? 0 : tweaks.auroraIntensity / 100 }}
          >
            <div className="blob b1" style={{ background: `radial-gradient(circle, ${tweaks.palette[0]} 0%, transparent 70%)` }}/>
            <div className="blob b2" style={{ background: `radial-gradient(circle, ${tweaks.palette[1]} 0%, transparent 70%)` }}/>
            <div className="blob b3" style={{ background: `radial-gradient(circle, ${tweaks.palette[2]} 0%, transparent 70%)` }}/>
          </div>
        </div>
        <div className="window" onContextMenu={onContext}>
          <Titlebar
            onSearch={() => setPaletteOpen(true)}
            onAvatar={() => setAccountOpen(o => !o)}
            sideCollapsed={sideCollapsed}
            onToggleSide={() => setSideCollapsed(c => !c)}
          />
          <div className="main">
            <Rail view={view} setView={navigateTo}/>
            <SidePanel width={sideWidth} setWidth={setSideWidth} collapsed={sideCollapsed}>
              {sidePanel}
            </SidePanel>
            <div
              className={"content" + (isCode ? " workspace" : "")}
              style={isCode ? {
                display: "grid",
                gridTemplate:
                  dockState.side === "bottom" ? `auto 1fr ${dockState.size}px / 1fr` :
                  dockState.side === "top"    ? `auto ${dockState.size}px 1fr / 1fr` :
                  dockState.side === "left"   ? `auto 1fr / ${dockState.size}px 1fr` :
                                                `auto 1fr / 1fr ${dockState.size}px`,
                gridTemplateAreas:
                  dockState.side === "bottom" ? `"head" "main" "dock"` :
                  dockState.side === "top"    ? `"head" "dock" "main"` :
                  dockState.side === "left"   ? `"head head" "dock main"` :
                                                `"head head" "main dock"`,
              } : {}}
            >
              <div className="content-head" style={isCode ? { gridArea: "head" } : {}}>
                <div className="content-title">{heading.title}</div>
                <div className="content-sub">{heading.sub}</div>
                <div style={{ flex: 1 }}/>
                {view === "chat" && <>
                  <button className="lgb lgb-sm"><Icon name="copy" size={11}/> Share</button>
                  <button className="lgb lgb-sm"><Icon name="sparkle" size={11}/> Compact</button>
                </>}
                {view === "code" && <>
                  <button className="lgb lgb-sm"><Icon name="git" size={11}/> Commit</button>
                  <button className="lgb lgb-sm"><Icon name="sparkle" size={11}/> Ask Shugu</button>
                  <DockToggleButton dockState={dockState} setDockState={setDockState}/>
                </>}
                {view === "image" && <>
                  <button className="lgb lgb-sm"><Icon name="thumbs" size={11}/> Variations</button>
                  <button className="lgb lgb-sm"><Icon name="download" size={11}/> Export</button>
                </>}
              </div>
              <div
                className="content-body"
                style={isCode ? { gridArea: "main", position: "relative" } : { position: "relative" }}
              >
                <Suspense fallback={<div className="loading"><div className="ring"></div></div>}>
                  <Outlet/>
                </Suspense>
                <AnnotationLayer
                  annotations={annotations}
                  onRemove={(id: number) => setAnnotations(a => a.filter(x => x.id !== id))}
                />
              </div>
              {isCode && (
                <DockHostMount
                  dockState={dockState}
                  setDockState={setDockState}
                  fileContents={fileContents}
                />
              )}
            </div>
          </div>
        </div>

        <ContextMenu
          open={ctx.open}
          x={ctx.x}
          y={ctx.y}
          target={ctx.target}
          onClose={() => setCtx((c: any) => ({ ...c, open: false }))}
          onAnnotate={onAnnotate}
        />
        <AccountDropdown
          open={accountOpen}
          onClose={() => setAccountOpen(false)}
          onView={navigateTo}
        />
        <FloatChat pinnedAnno={pinnedAnno} clearPinned={() => setPinnedAnno(null)}/>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          setView={navigateTo}
          onNewChat={newChat}
        />

        <TweaksPanel title="Tweaks">
          <TweakSection label="Palette">
            <TweakColor
              label="Accent set"
              value={tweaks.palette}
              onChange={(v: any) => setTweak("palette", v)}
              options={[
                ["#e08efe", "#fd6c9c", "#81ecff"],
                ["#7cffd1", "#81ecff", "#a8c5ff"],
                ["#ffcf6b", "#ff8c70", "#fd6c9c"],
                ["#c2f6ff", "#a8c5ff", "#d8b4fe"],
                ["#ff5dcd", "#ffae34", "#52e3ff"],
              ]}
            />
          </TweakSection>
          <TweakSection label="Glass">
            <TweakSlider label="Blur radius" min={2} max={28} step={1} value={tweaks.glassBlur} onChange={(v: number) => setTweak("glassBlur", v)} unit="px"/>
            <TweakSlider label="Tint opacity" min={20} max={92} step={1} value={tweaks.glassTint} onChange={(v: number) => setTweak("glassTint", v)} unit="%"/>
          </TweakSection>
          <TweakSection label="Background">
            <TweakRadio
              label="Mode"
              value={tweaks.backgroundMode}
              onChange={(v: any) => setTweak("backgroundMode", v)}
              options={[
                { value: "aurora", label: "Aurora" },
                { value: "static", label: "Static" },
                { value: "off",    label: "Off" },
              ]}
            />
            <TweakSlider label="Intensity" min={0} max={100} step={5} value={tweaks.auroraIntensity} onChange={(v: number) => setTweak("auroraIntensity", v)} unit="%"/>
          </TweakSection>
        </TweaksPanel>
      </>
    </ShellContext.Provider>
  );
}
