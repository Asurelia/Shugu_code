// Shugu Forge — RootLayout: shell chrome + all shared state.
// Replaces the App component. Navigation is now URL-driven via TanStack Router.

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
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
import { MenuBar } from "@/components/MenuBar";
import { ChatSidebar } from "@/features/chat/chat-sidebar";
import { Onboarding } from "@/features/onboarding/Onboarding";
import {
  DockWorkspace,
  ContextMenu,
  AccountDropdown,
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

import { seedAgents } from "@/mocks/seedAgents";
import { seedGenerations } from "@/mocks/seedGenerations";
import { seedGalleryFolders } from "@/mocks/seedGalleryFolders";
import type { DockState, FileNode } from "@/lib/types";
import { db, seedIfEmpty, toGenerationRow } from "@/lib/db";
import { useActiveConv, createConversation, sendChatMessage } from "@/features/chat/chat-sync";
import { loadOpenFiles, saveOpenFiles } from "@/lib/ide-state";
import { fsReadFile, fsWriteFile, fsCreateDir, fsCreateFile, langToExt } from "@/lib/fs";
import { useFileTree, invalidateFileTree } from "@/features/fs/queries";
import { useFsEvents } from "@/features/fs/useEvents";
import { useGitEvents } from "@/features/git/useEvents";
import { useRefreshOpenFiles } from "@/features/fs/useRefreshOpenFiles";
import { indexWorkspace } from "@/features/fs/workspaceIndexer";
import { AgentsPanel } from "@/features/agents/AgentsPanel";
import { useAgentEvents } from "@/features/agents/useEvents";
import { useActiveAgents, setSelectedAgentId } from "@/features/agents/queries";
import { useChatEvents } from "@/features/chat/useEvents";
import { useChatStreamListener } from "@/features/chat/useChatStream";
import { runImmediate } from "@/features/code/ai-edit/aiEditController";
import { setApplyRequest } from "@/features/code/ai-edit/applyController";
import { detectBlockPath, stripPathComment } from "@/lib/markdown";
import { ToastHost } from "@/components/ToastHost";
import { useLlamaLifecycle } from "@/features/llama/useLlamaLifecycle";
import { COMMANDS, getCommandById, fmtKbd, type CommandContext } from "@/lib/commands";
import { useCommandKeybindings } from "@/lib/keybindings";
import { FindPanel } from "@/features/code/FindPanel";
import { invalidateGitHead } from "@/features/git/queries";
import { SideGit } from "@/features/git/SideGit";

// Context + hook live in ./shell-context to keep this file Fast-Refresh
// friendly (a module exporting both a hook and a component forces a full
// page reload on every HMR edit, which in turn caused the intermittent
// "useShell must be used inside RootLayout" errors in the Tauri webview).
import { ShellContext, type ShellContextValue, type EditorPrefs, DEFAULT_EDITOR_PREFS } from "./shell-context";
import { loadJSON, saveJSON } from "@/features/settings/settings-extras";
import { formatCurrentDocumentCli, formatCodeDirect } from "@/features/code/format";

// ─── Path → view string (derived navigation) ─────────────────

type ViewKey =
  | "chat" | "code" | "git" | "image" | "agents"
  | "gallery" | "settings" | "profile" | "connections";

function pathToView(pathname: string): ViewKey {
  if (pathname === "/chat")         return "chat";
  if (pathname === "/code")         return "code";
  if (pathname === "/git")          return "git";
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
    chat: "/chat", code: "/code", git: "/git", image: "/image",
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

function CommandPalette({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: CommandContext }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Build the active command list from COMMANDS, filtered by when() and search query.
  // Commands with when()===false are hidden (Pass 1 behaviour: filter rather than grey-out).
  // Input-local commands and commands without icons are excluded from palette display.
  const activeCmds = useMemo(() => {
    return COMMANDS.filter(c => {
      if (c.scope === "input") return false;
      if (c.when && !c.when(ctx)) return false;
      return true;
    });
  }, [ctx]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return activeCmds;
    return activeCmds.filter(c =>
      (c.title + " " + (c.description || "")).toLowerCase().includes(qq)
    );
  }, [q, activeCmds]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Group by category (replaces old group field).
  const grouped = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    filtered.forEach(c => {
      if (!m.has(c.category)) m.set(c.category, []);
      m.get(c.category)!.push(c);
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
      if (c) { void c.run(ctx); onClose(); }
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
                const kbd = fmtKbd(c.keybinding);
                return (
                  <div
                    key={c.id}
                    className={"palette-item" + (me === idx ? " active" : "")}
                    onMouseEnter={() => setIdx(me)}
                    onClick={() => { void c.run(ctx); onClose(); }}
                  >
                    <div className="ico"><Icon name={c.icon ?? "search"} size={13}/></div>
                    <div className="body">
                      <div className="name">{c.title}</div>
                      {c.description && <div className="hint">{c.description}</div>}
                    </div>
                    {kbd && <span className="kbd">{kbd}</span>}
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
        // Left-click opens the placement menu (the user's preferred flow —
        // see the in-menu "Show / Hide panel" item for the toggle behavior
        // we used to expose as left-click). The DockSideMenu inside the
        // dock chrome was removed in favor of this single source of truth.
        className={"lgb lgb-sm" + (isHidden ? "" : " lgb-primary")}
        onClick={() => setOpen((o) => !o)}
        title="Panel placement & options"
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
            <button className={"chat-ctx-item" + (dockState.split ? " on" : "")} onClick={() => {
              // Use the same per-pane logic as the dock chrome's split
              // toggle: when turning ON, create a NEW terminal tab in
              // pane 1 (vscode/cursor pattern); when turning OFF, merge
              // pane-1 tabs back into pane 0 to preserve the user's PTYs.
              setDockState((s: any) => {
                if (s.split) {
                  return {
                    ...s,
                    tabs: s.tabs.map((t: any) => t.pane === 1 ? { ...t, pane: 0 } : t),
                    split: false,
                    splitActiveId: null,
                  };
                }
                const id = "t" + Date.now();
                const counts = s.tabs.filter((t: any) => t.kind === "term").length + 1;
                return {
                  ...s,
                  tabs: [...s.tabs, { id, kind: "term", name: `bash · ${counts}`, pane: 1 }],
                  split: true,
                  splitActiveId: id,
                  splitRatio: 0.55,
                };
              });
              setOpen(false);
            }}>
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

  // Chat state — activeConvo is cross-window synchronised via chat-sync's
  // useActiveConv hook (localStorage + Tauri event). Messages no longer
  // live in component state: ChatView and FloatChat each subscribe via
  // useMessages(activeConv) and read directly from SQLite (LOCAL-FIRST).
  const [activeConvo, setActiveConvo] = useActiveConv();
  const [activeConvoTitle, setActiveConvoTitle] = useState<string | null>(null);

  // TanStack-only : un seul listener Tauri qui invalide les queries agent.
  // Plus de store Zustand custom, plus de applyEvent manuel. Le freeze
  // diagnostiqué dans Plan v2 est résolu par cette migration architecturale.
  useAgentEvents();
  // Chat events : invalide useMessages quand un message est appendé OU
  // quand un agent complete (le delegate flow appende sa réponse alors).
  useChatEvents();
  // Chat stream listener : capte les chat://delta events et accumule
  // dans le cache TanStack pour que TOUTES les windows voient le
  // streaming (au lieu d'un acceptingRef local qui drop les chunks).
  useChatStreamListener();

  // Auto-stop/start llama-server quand le model chat passe local↔API.
  // Restauré après diagnostic — innocent du freeze (testé Plan v2 Step C).
  useLlamaLifecycle();
  // Count via TanStack — re-render uniquement quand le nombre change
  // (TanStack fait un compare structurel sur le résultat, et data?.length
  // est une primitive number). Renommé `activeAgents` pour éviter le
  // conflit avec une autre variable `agents` dans le scope.
  const { data: activeAgents } = useActiveAgents();
  const agentsCount = activeAgents?.length ?? 0;
  // Local toggle for the agents side overlay. Phase 0: chat view only —
  // Phase 1+ may extend to code/image views once the orchestrator can
  // run alongside other workflows.
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);

  // Phase 1 — cross-component "open this agent" trigger. When the user
  // clicks a "via orchestrator" chip on a chat message, `revealAgent()`
  // emits `app://reveal-agent` (Tauri event bus) so every window can
  // react. Here we react by: 1/ navigating to /chat (the agents overlay
  // is scoped to that view), 2/ flipping the overlay on, 3/ selecting
  // the targeted agent in the agents store so its transcript drawer
  // auto-expands. Decoupled from any React context — pure event-bus.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlisten = await mod.listen<{ agentId?: string }>("app://reveal-agent", (e) => {
          if (cancelled) return;
          const agentId = e.payload?.agentId;
          if (!agentId) return;
          navigate({ to: "/chat" as any });
          setShowAgentsPanel(true);
          setSelectedAgentId(agentId);
        });
      } catch (err) {
        console.warn("[RootLayout] reveal-agent listen failed:", err);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // navigate is stable (router-provided); setShowAgentsPanel + store
    // setter are stable React identity. Empty deps are correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // File state — fileTree migré vers useFileTree (TanStack Query).
  // Le useState local + useEffect+useState async ont disparu dans la
  // Phase G de la migration TanStack (mai 2026). `invalidateFileTree()`
  // est exposé via shellContext pour les mutations externes (command
  // palette open-folder).
  const { data: fileTree = [] } = useFileTree();
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileContents, setFileContents] = useState<Record<string, any>>({});
  const [filesPanelActive, setFilesPanelActive] = useState("");

  // Image / gallery state
  const [generations, setGenerations] = useState(seedGenerations);

  /**
   * Write-through wrapper: whenever a generation is ADDED (new id appears),
   * persist it to SQLite via db.generations.create.
   */
  const setGenerationsPersisted: React.Dispatch<React.SetStateAction<any[]>> = useCallback(
    (updater) => {
      setGenerations((prev) => {
        const next: any[] = typeof updater === "function" ? (updater as (p: any[]) => any[])(prev) : updater;
        const added = next.filter((g) => !prev.some((p) => p.id === g.id));
        added.forEach((g) => void db.generations.create(toGenerationRow(g)));
        return next;
      });
    },
    []
  );

  const [galleryFolders] = useState(seedGalleryFolders);
  const [activeFolder, setActiveFolder] = useState("g1");

  // Agents
  const [agents] = useState(seedAgents);
  const [activeAgent, setActiveAgent] = useState("a1");

  // LOT 2 — Find-in-files panel open state. Lifted ici car (1) la commande
  // `search-in-files` (commands.ts:447) doit pouvoir l'ouvrir depuis le
  // CommandContext, et (2) le panel lui-même est mounté en overlay dans
  // la return tree de ce composant. Exposé aux routes via ShellContext.
  const [findPanelOpen, setFindPanelOpen] = useState(false);

  // LOT 3 — Compare mode: both workspace-relative paths for the 2-pane diff.
  // When non-null, the /code view renders a MergeView instead of the standard
  // CodeMirrorEditor. Cleared on activeFile change or by the `close-compare`
  // command.
  const [compareFile, setCompareFile] = useState<{ left: string; right: string } | null>(null);

  // Auto-close compare view when the user switches to a different file.
  // Without this, switching tabs while a diff is open leaves a stale
  // comparison (the left/right paths no longer relate to the new activeFile).
  useEffect(() => {
    setCompareFile(null);
  }, [activeFile]);

  // LOT 1 — Editor preferences. Lifted here so toggling a setting propagates
  // to the live editor in the same window without relying on the `storage`
  // DOM event (which only fires cross-window). Hydrated from localStorage via
  // loadJSON (synchronous), persisted on mutation via saveJSON.
  const [editorPrefs, setEditorPrefsState] = useState<EditorPrefs>(
    () => ({ ...DEFAULT_EDITOR_PREFS, ...loadJSON("shugu.editor.v1", {}) }),
  );
  const setEditorPref = useCallback(<K extends keyof EditorPrefs>(key: K, value: EditorPrefs[K]) => {
    setEditorPrefsState(prev => {
      const next = { ...prev, [key]: value };
      saveJSON("shugu.editor.v1", next);
      return next;
    });
  }, []);

  // Editor ref — forwarded from CodeMirrorEditor via ShellContext + CommandContext
  // so that find-in-file / replace-in-file commands can open the search panel.
  // The ref is null while any route other than /code is mounted.
  const editorViewRef = useRef<import("@/features/code/CodeMirrorEditor").CodeMirrorEditorHandle>(null);

  // Side panel
  const [sideCollapsed, setSideCollapsed] = useState(false);
  const [sideWidth, setSideWidth] = useState(248);

  // Dock
  const [dockState, setDockState] = useState<DockState>({
    side: "bottom",
    size: 280,
    tabs: [
      { id: "t1", kind: "term",     name: "bash · 1", pane: 0 },
      { id: "t2", kind: "agent",    name: "agent",    pane: 0 },
      { id: "t3", kind: "output",   name: "output",   pane: 0 },
      { id: "t4", kind: "problems", name: "problems", pane: 0 },
    ],
    activeId: "t1",
    splitActiveId: null,
    split: false,
    splitRatio: 0.55,
  });

  // Context menu + annotations + account
  const [ctx, setCtx] = useState<any>({ open: false, x: 0, y: 0, target: null });
  const [annotations, setAnnotations] = useState<any[]>([]);
  const [pinnedAnno, setPinnedAnno] = useState<any>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  // Hydrate generations from SQLite on mount (Tauri mode only).
  // seedIfEmpty() ensures a fresh DB has prototype data on first run.
  // Write-through is handled by setGenerationsPersisted passed into ShellContext.
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

  // File tree loading + fs watcher : maintenant gérés par useFileTree /
  // useFsEvents (Phase G migration TanStack). Le hook fetch au mount,
  // le listener invalide sur fs://changed.
  useFsEvents();
  // LOT 3 git-ui — listen `git://changed` (`.git/HEAD`, `.git/index`,
  // refs/*, MERGE_HEAD, ORIG_HEAD) and invalidate all git query keys.
  useGitEvents();
  // Smoke test fix — auto-refresh des fichiers ouverts (non-dirty) quand
  // ils changent sur le disque depuis un éditeur externe.
  // NB : on passe openFiles/fileContents/setFileContents en arguments
  // (pas via useShell()) parce que ce hook tourne DANS RootLayout, qui
  // EST le Provider du ShellContext — utiliser useShell() ici throw
  // "useShell must be used inside RootLayout".
  useRefreshOpenFiles(openFiles, fileContents, setFileContents);

  // VEC3 — best-effort workspace indexer. Run ONCE on mount, after a small
  // delay so it doesn't compete with the boot phase (window mount, llama
  // autostart, file tree first load). The indexer has its own internal
  // in-flight guard + 24-h TTL so re-triggers are no-ops.
  //
  // IMPORTANT — must NOT depend on [fileTree] : the fs watcher fires
  // `fs://changed` events repeatedly at boot (db creation, seed writes,
  // first openFile), each one invalidating the file tree query, each
  // invalidation re-running this effect, each re-run spawning a parallel
  // workspace walk → catastrophic freeze (observed 2026-05-17).
  useEffect(() => {
    const t = setTimeout(() => { void indexWorkspace(); }, 5000);
    return () => clearTimeout(t);
  }, []);

  // Restore the previously open tabs + active file from SQLite.
  //
  // Runs once on mount, AFTER the workspace tree is requested (they run in
  // parallel; that's fine — fsReadFile in openFile() doesn't need the tree
  // to be loaded, it just needs the workspace root). Each persisted path is
  // attempted; missing files (renamed/deleted since last session) are
  // silently skipped so a stale state can't crash the boot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const restored = await loadOpenFiles();
      if (cancelled || !restored) return;
      for (const path of restored.openFiles) {
        try {
          const content = await fsReadFile(path);
          if (cancelled) return;
          setFileContents(c => ({ ...c, [path]: content }));
          setOpenFiles(p => p.includes(path) ? p : [...p, path]);
        } catch {
          // File no longer exists — skip silently.
        }
      }
      if (cancelled) return;
      // Only restore activeFile if it actually made it into openFiles
      // (avoids a "blank editor pointing at a deleted file" state).
      if (restored.activeFile) {
        setOpenFiles(p => {
          if (p.includes(restored.activeFile!)) setActiveFile(restored.activeFile);
          return p;
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist the open-tabs set on every change, debounced 500ms. Bursts
  // (opening 5 files in quick succession) collapse into one SQLite write.
  useEffect(() => {
    const t = setTimeout(() => {
      void saveOpenFiles({ openFiles, activeFile });
    }, 500);
    return () => clearTimeout(t);
  }, [openFiles, activeFile]);

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
    // Collect the active selection at two granularities:
    //   - label: short (60 chars) for the pinned-annotation UI overlay
    //   - fullText: longer (2000 chars) for the prompt body sent to the IA
    // Right-click on something OTHER than a selection (no text selected)
    // falls back to data-ctx-label or the tag name, in which case fullText
    // is identical to label (no real code to send to the LLM).
    const sel = (window.getSelection()?.toString() || "").trim();
    const label = sel.slice(0, 60) ||
      t?.closest("[data-ctx-label]")?.getAttribute("data-ctx-label") ||
      t?.tagName?.toLowerCase();
    const fullText = sel ? sel.slice(0, 2000) : label;
    e.preventDefault();
    setCtx({ open: true, x: e.clientX, y: e.clientY, target: { label, fullText, kind: t?.tagName?.toLowerCase(), x: e.clientX, y: e.clientY } });
  }, []);

  const onAnnotate = useCallback(({ kind, payload, target }: any) => {
    // LOT Éditeur⇄AI — "rewrite"/"fix" sur une sélection DANS l'éditeur =
    // édition inline (diff + accept/reject), pas le chat. Hors éditeur,
    // "rewrite" retombe sur le chat (comportement historique) ; "fix" n'a
    // pas de chemin chat → no-op.
    if (kind === "rewrite" || kind === "fix") {
      const ev = editorViewRef.current?.getView();
      const hasSel = !!ev && ev.state.selection.main.from !== ev.state.selection.main.to;
      if (view === "code" && ev && hasSel) {
        const fc = activeFile ? fileContents[activeFile] : null;
        const coords = ev.coordsAtPos(ev.state.selection.main.from);
        const anchor = coords
          ? { x: coords.left, y: coords.bottom + 6 }
          : { x: target?.x ?? 80, y: target?.y ?? 80 };
        void runImmediate(ev, {
          mode: kind === "fix" ? "fix" : "refactor",
          path: activeFile,
          lang: fc?.lang ?? "",
          wasDirty: !!fc?.dirty,
          anchor,
        });
        return;
      }
      if (kind === "fix") return; // pas de chemin chat pour "fix" hors éditeur
      // "rewrite" hors éditeur : tombe dans le bloc chat ci-dessous.
    }
    if (kind === "pin") { setPinnedAnno({ label: target?.label, text: target?.label }); return; }
    if (kind === "ask" || kind === "explain" || kind === "rewrite") {
      // Pin the short label for the mascot's "tu as épinglé X" overlay…
      setPinnedAnno({ label: target?.label });
      // …and actually send the full selection as a structured prompt to
      // the active conversation. Both windows (main IDE + mascot) receive
      // the chat://messages-changed event and render the user message +
      // the IA reply.
      const fullText: string = target?.fullText || target?.label || "";
      if (!fullText) return;
      const prompts: Record<string, string> = {
        ask:     `Question about this:\n\n${fullText}`,
        explain: `Explain this:\n\n${fullText}`,
        rewrite: `Rewrite this for clarity:\n\n${fullText}`,
      };
      const prompt = prompts[kind];
      void sendChatMessage(activeConvo, prompt, "shugu-haiku-4-5");
      return;
    }
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
  }, [activeConvo, view, activeFile, fileContents]);

  // LOT 2 — openFile est maintenant exposé via ShellContext (utilisé par
  // FindPanel pour ouvrir un fichier depuis un résultat grep). On évite
  // de capturer `fileContents` dans la closure : sinon openFile serait
  // recréé à chaque édition, ce qui recréerait shellValue, ce qui
  // re-renderait TOUS les consumers useShell en cascade — y compris au
  // boot où loadOpenFiles ouvre N fichiers séquentiellement (cf. ligne 515).
  // Pattern useRef sync : lit fileContents via fileContentsRef.current,
  // jamais via fermeture. openFile devient un callback stable (deps vides).
  const fileContentsRef = useRef(fileContents);
  fileContentsRef.current = fileContents;
  const openFile = useCallback(async (path: string) => {
    if (!(path in fileContentsRef.current)) {
      const content = await fsReadFile(path);
      setFileContents(c => ({ ...c, [path]: content }));
    }
    setOpenFiles(p => p.includes(path) ? p : [...p, path]);
    setActiveFile(path);
    setFilesPanelActive(path);
  }, []);

  const saveFile = useCallback(async (path: string) => {
    const content = fileContents[path];
    if (!content) return;

    // Format-on-save: run CLI formatter before writing.
    // NEVER blocks save — if format fails, save proceeds with original content.
    // Uses CLI-only path (not LSP) because formatDocument is async-dispatch:
    // reading view.state.doc immediately after would return pre-format content.
    //
    // Corruption guard: editorViewRef always points to the ACTIVE file's view.
    // When saveAll() iterates dirty files, non-active files must NOT use the
    // view — they would read the active file's content and write it to the
    // wrong path. Two paths:
    //   • isActiveFile  → view-based (LCS cursor preservation, then read doc)
    //   • !isActiveFile → direct invoke on content.text (no view dispatch)
    let textToWrite = content.text;
    if (editorPrefs.formatOnSave) {
      const isActiveFile = path === activeFile;
      if (isActiveFile) {
        const view = editorViewRef.current?.getView();
        // readOnly === inline AI-edit session active (aiEditCompartment lock):
        // view.state.doc holds the partial-streamed / preview diff text, not a
        // user-saveable doc. Skip the formatter branch so textToWrite stays
        // content.text (pre-session value — onChange is suppressed during the
        // stream) rather than persisting half-generated AI output to disk.
        if (view && !view.state.readOnly) {
          // formatCurrentDocumentCli never throws (contract: catches errors
          // internally, returns boolean) — no try/catch needed. Reading
          // view.state.doc after the await captures whichever of these cases
          // applies: (a) format dispatched → formatted content; (b) format
          // skipped (no formatter, race, error) → unchanged content; (c) user
          // typed during format → formatCurrentDocumentCli bails out and the
          // typing is preserved. In all three cases textToWrite is correct.
          await formatCurrentDocumentCli(view, content.lang, path);
          textToWrite = view.state.doc.toString();
        }
      } else {
        // Non-active file: format directly without touching the editor view.
        // formatCodeDirect respects the shared noCliFormatter cache and
        // populates it on "no formatter" / "formatter not found" errors so
        // repeated saveAll calls don't re-spawn a failing process.
        const formatted = await formatCodeDirect(content.lang, content.text, path);
        if (formatted !== null) textToWrite = formatted;
      }
    }

    await fsWriteFile(path, textToWrite);
    setFileContents(c => ({
      ...c,
      [path]: { ...c[path], text: textToWrite, dirty: false, original: textToWrite },
    }));
    // LOT 3 — invalidate git HEAD cache for this file so that inline diff
    // decorations reflect the new saved state vs HEAD immediately.
    invalidateGitHead(path);
  }, [fileContents, editorPrefs.formatOnSave, activeFile, editorViewRef]);

  const saveAll = useCallback(async () => {
    const dirty = openFiles.filter(p => fileContents[p]?.dirty);
    await Promise.all(dirty.map(saveFile));
  }, [openFiles, fileContents, saveFile]);

  // openSnippetInEditor — turn a chat code block into an editable file.
  //
  // Path: <workspace>/.shugu-snippets/snippet-<unix-ms>.<ext>. Stable folder
  // name so all snippets cluster together; timestamped filename so no
  // collision and no overwrites. The folder is created on demand
  // (fsCreateDir is idempotent on the Rust side — succeeds if the dir
  // already exists). After the file lands on disk, openFile() does the
  // standard read+tab dance, and we navigate to /code so the user
  // immediately sees their snippet in CodeMirror.
  const openSnippetInEditor = useCallback(async (code: string, lang: string) => {
    const ext = langToExt(lang);
    const filename = `snippet-${Date.now()}.${ext}`;
    const path = `.shugu-snippets/${filename}`;
    try {
      await fsCreateDir(".shugu-snippets");
      await fsCreateFile(path, code);
      await openFile(path);
      navigate({ to: "/code" });
    } catch (err) {
      console.warn("[openSnippetInEditor] failed:", err);
    }
  }, [openFile, navigate]);

  // Lot 2 — applyCodeToFile : applique un bloc de code du chat à un fichier,
  // avec preview diff inline (réutilise la primitive du Lot 1 via startApply).
  //
  // Découpage du flux : ICI on résout + ouvre + active le fichier cible (cross-
  // route, on a openFile + navigate), puis on POSE une ApplyRequest dans le
  // cache. useApplyRunner (monté dans CodeView) attend que la view du fichier
  // soit prête et démarre le diff. Sans chemin déclaré → repli non destructif
  // vers openSnippetInEditor (jamais de remplacement fichier-entier implicite).
  const applyCodeToFile = useCallback(async (code: string, lang: string) => {
    const detected = detectBlockPath(code);
    if (!detected) {
      await openSnippetInEditor(code, lang);
      return;
    }
    const path = detected;
    const proposed = stripPathComment(code);
    try {
      // openFile lit le disque (fsReadFile throw si absent) puis active le tab.
      // Fichier neuf → on le crée vide d'abord pour que le diff aille de vide
      // au contenu proposé (Accept écrit alors le fichier).
      try {
        await openFile(path);
      } catch {
        const slash = path.lastIndexOf("/");
        if (slash > 0) await fsCreateDir(path.slice(0, slash));
        await fsCreateFile(path, "");
        await openFile(path);
      }
      navigate({ to: "/code" });
      setApplyRequest({ path, text: proposed, lang });
    } catch (err) {
      console.warn("[applyCodeToFile] failed:", err);
    }
  }, [openFile, openSnippetInEditor, navigate]);

  // newChat creates a fresh conversation row in SQLite and switches the
  // active conv to it. The empty-messages render falls out naturally:
  // useMessages(newId) returns [] for a conv with no rows. The active
  // conv change broadcasts via chat://active-changed so the mascot
  // window switches in lock-step.
  const newChat = useCallback(() => {
    void (async () => {
      const id = await createConversation("New chat");
      setActiveConvo(id);
    })();
  }, [setActiveConvo]);

  // Navigate helper used by Rail, CommandPalette, AccountDropdown, SideSettings
  const navigateTo = useCallback((v: string) => {
    navigate({ to: railTargetFor(v) as any });
  }, [navigate]);

  // ── CommandContext ─────────────────────────────────────────
  // Assembled from RootLayout-local state. NOT lifted into ShellContext.
  // Must be declared AFTER navigateTo, newChat, onAnnotate, setTweak, etc.
  // setTweak is wrapped to satisfy the generic (key: string, value: any) signature.
  const cmdCtx: CommandContext = useMemo(() => ({
    navigateTo,
    currentView: view,
    setPaletteOpen,
    sideCollapsed,
    setSideCollapsed,
    dockState,
    setDockState,
    tweaks,
    setTweak: (key: string, value: any) => setTweak(key as any, value),
    newChat,
    // Files (alphabetical)
    activeFile,
    fileContents,
    fileTree,
    openFiles,
    saveAll,
    saveFile,
    setActiveFile,
    setFileContents,
    /** Refetch le file tree (utilisé par command palette open-folder).
     *  Remplace l'ancien `setFileTree` (qui était un useState setter)
     *  par un trigger d'invalidation TanStack — le useFileTree hook
     *  refetch automatiquement et propage à tous les consumers. */
    invalidateFileTree,
    setOpenFiles,
    // Gallery / Agents
    generations,
    agents,
    onAnnotate,
    // Editor
    editorViewRef,
    // LOT 2 — Find-in-files panel
    setFindPanelOpen,
    // LOT 1 — editor prefs
    editorPrefs,
    setEditorPref,
    // LOT 3 — compare mode
    compareFile,
    setCompareFile,
  }), [
    navigateTo, view, setPaletteOpen,
    sideCollapsed, setSideCollapsed,
    dockState, setDockState,
    tweaks, setTweak,
    newChat,
    // Files (alphabetical)
    activeFile, fileContents, fileTree, openFiles,
    saveAll, saveFile,
    setActiveFile, setFileContents, setOpenFiles,
    // Gallery / Agents
    generations, agents,
    onAnnotate,
    // Editor (stable ref object — inclusion is defensive/explicit)
    editorViewRef,
    // LOT 2 — setFindPanelOpen est stable (setter useState), inclusion explicite.
    setFindPanelOpen,
    // LOT 1 — editor prefs
    editorPrefs,
    setEditorPref,
    // LOT 3 — compare mode
    compareFile, setCompareFile,
  ]);

  // Global keybinding dispatcher — replaces the hardcoded Cmd+K useEffect.
  // Escape-to-close is handled inside CommandPalette's own onKey handler.
  useCommandKeybindings(cmdCtx);

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
          tree={fileTree}
          active={filesPanelActive}
          onPick={openFile}
        />
      );
    }
    if (view === "git") {
      return <SideGit />;
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
      case "git":      return { title: "Source Control", sub: activeFile || "" };
      case "image":    return { title: <span><span className="acc">Image Studio</span></span>, sub: "flux.1 · sdxl · lcm-fast" };
      case "agents":   return { title: "Agents",        sub: `${agents.filter((a: any) => a.status === "running").length} running · ${agents.length} total` };
      case "gallery":  return { title: "Gallery",       sub: `${generations.length} generations` };
      case "settings": return { title: "Settings",      sub: settingsSection };
      case "profile":  return { title: "Profile",       sub: "account & personal info" };
      case "connections": return { title: "Connections", sub: "API keys & external tools" };
      default: return { title: "", sub: "" };
    }
  })();

  // /git réutilise le main content de /code (l'éditeur reste central) — donc le
  // dock est rendu dans les deux vues. Pattern VSCode : changer le sidebar ne
  // doit pas masquer le terminal ouvert en bas.
  const isCode = (view === "code" || view === "git") && dockState.side !== "hidden";

  // Shared state exposed to leaf routes via context
  const shellValue: ShellContextValue = useMemo(() => ({
    openFiles, setOpenFiles,
    activeFile, setActiveFile,
    fileContents, setFileContents,
    generations, setGenerations: setGenerationsPersisted,
    agents,
    openSnippetInEditor,
    applyCodeToFile,
    editorViewRef,
    // LOT 2 — Find-in-files panel state piped to /code route components.
    findPanelOpen, setFindPanelOpen,
    // LOT 2 — openFile (read+open+focus) lifted so FindPanel can open a
    // file from a grep result even if it isn't already in openFiles.
    openFile,
    // LOT 1 — editor prefs
    editorPrefs,
    setEditorPref,
    // LOT 3 — compare mode
    compareFile,
    setCompareFile,
  }), [
    openFiles, activeFile, fileContents, generations, agents,
    setOpenFiles, setActiveFile, setFileContents, setGenerationsPersisted,
    openSnippetInEditor,
    applyCodeToFile,
    // editorViewRef is a stable ref object; included for explicit dependency tracking
    editorViewRef,
    // LOT 2
    findPanelOpen, setFindPanelOpen,
    openFile,
    // LOT 1 — editor prefs
    editorPrefs,
    setEditorPref,
    // LOT 3 — compare mode
    compareFile, setCompareFile,
  ]);

  // The per-view content (the routed <Outlet/> + the absolute annotation layer).
  // Reused in both the plain (flex) layout and the resizable dock workspace.
  const editorBody = (
    <>
      <Suspense fallback={<div className="loading"><div className="ring"></div></div>}>
        <Outlet/>
      </Suspense>
      <AnnotationLayer
        annotations={annotations}
        onRemove={(id: number) => setAnnotations(a => a.filter(x => x.id !== id))}
      />
    </>
  );

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
            onSettings={() => getCommandById("open-settings")?.run(cmdCtx)}
            sideCollapsed={sideCollapsed}
            onToggleSide={() => setSideCollapsed(c => !c)}
            menu={<MenuBar ctx={cmdCtx}/>}
          />
          <div className="main">
            <Rail view={view} setView={navigateTo}/>
            <SidePanel width={sideWidth} setWidth={setSideWidth} collapsed={sideCollapsed}>
              {sidePanel}
            </SidePanel>
            <div className="content">
              <div className="content-head">
                <div className="content-title">{heading.title}</div>
                <div className="content-sub">{heading.sub}</div>
                <div style={{ flex: 1 }}/>
                {view === "chat" && <>
                  <button className="lgb lgb-sm"><Icon name="copy" size={11}/> Share</button>
                  <button className="lgb lgb-sm"><Icon name="sparkle" size={11}/> Compact</button>
                  {/* Agents observability toggle. Inline SVG (org-chart glyph) so
                      we don't have to invent a new Icon name in the design kit
                      just for Phase 0. `lgb-primary` lights up when the panel
                      is visible so the user has a visual cue of which surface
                      is on top. */}
                  <button
                    className={"lgb lgb-sm" + (showAgentsPanel ? " lgb-primary" : "")}
                    onClick={() => setShowAgentsPanel(o => !o)}
                    title={showAgentsPanel ? "Hide agents panel" : "Show agents panel"}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="2" width="6" height="5" rx="1"/>
                      <rect x="2" y="17" width="6" height="5" rx="1"/>
                      <rect x="16" y="17" width="6" height="5" rx="1"/>
                      <path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/>
                    </svg>
                    Agents{agentsCount > 0 ? ` (${agentsCount})` : ""}
                  </button>
                </>}
                {view === "code" && <>
                  <button className="lgb lgb-sm"><Icon name="git" size={11}/> Commit</button>
                  <button
                    className="lgb lgb-sm"
                    onClick={() => getCommandById("ai-inline-edit")?.run(cmdCtx)}
                    title="Édition AI inline (Cmd+K)"
                  ><Icon name="sparkle" size={11}/> Ask Shugu</button>
                  <DockToggleButton dockState={dockState} setDockState={setDockState}/>
                </>}
                {view === "image" && <>
                  <button className="lgb lgb-sm"><Icon name="thumbs" size={11}/> Variations</button>
                  <button className="lgb lgb-sm"><Icon name="download" size={11}/> Export</button>
                </>}
              </div>
              {isCode ? (
                <DockWorkspace
                  dockState={dockState}
                  setDockState={setDockState}
                  fileContents={fileContents}
                >
                  <div className="content-body" style={{ position: "relative", height: "100%" }}>
                    {editorBody}
                  </div>
                </DockWorkspace>
              ) : (
                <div className="content-body" style={{ position: "relative" }}>
                  {editorBody}
                  {/* Agents side overlay — visible only on chat view in Phase 0.
                      Anchored right within the content-body's relative
                      positioning context so it scrolls/sizes with the chat
                      surface. Inline styles for Phase 0; once the UX is
                      validated we'll move this to a real CSS class. */}
                  {view === "chat" && showAgentsPanel && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        bottom: 0,
                        width: 380,
                        background: "var(--surface, rgba(20, 16, 36, 0.96))",
                        backdropFilter: "blur(var(--lg-blur, 12px))",
                        borderLeft: "1px solid rgba(124, 58, 237, 0.22)",
                        overflowY: "auto",
                        zIndex: 10,
                      }}
                    >
                      <AgentsPanel />
                    </div>
                  )}
                </div>
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
        {/* FloatChat moved to the dedicated mascot window (src/mascot.tsx) —
            the chibi now lives in its own transparent Tauri window instead
            of being embedded in the IDE. pinnedAnno will flow to the mascot
            window via Tauri events at M4 (chat://pin). */}

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          ctx={cmdCtx}
        />

        {/* LOT 2 — Find-in-files workspace panel (ripgrep backend).
            Self-mounted via shell-context.findPanelOpen ; triggered par
            commands.ts::search-in-files (Cmd+Shift+F). */}
        <FindPanel />

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

        {/* First-run onboarding overlay. Self-decides whether to show:
            renders nothing if the default bundle model is already installed
            or if the user clicked "Plus tard" in a previous session. The
            overlay sits at z-index 5000 (above TweaksPanel) so it pre-empts
            the rest of the chrome while it's visible. */}
        <Onboarding/>

        {/* Toasts globaux (échecs silencieux FIM, feedback réindexation…). */}
        <ToastHost/>
      </>
    </ShellContext.Provider>
  );
}
