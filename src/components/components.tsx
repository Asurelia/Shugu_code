// Shugu Forge — shared atoms (icons, layout chrome)
// Ported from prototype components.jsx — exports replace window globals.

import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { fsCreateFile, fsCreateDir, fsRename, fsDelete } from "@/lib/fs";
// LOT 3 git-ui — annotate the file tree with git status.
import { useGitStatusMap, type GitStatusChar } from "@/features/git/useGitStatusMap";
// Lazy tree — each folder fetches its direct children on first expand
// (fs_read_dir_shallow), so huge projects open instantly (no 5000-entry cap).
import { useDirChildren } from "@/features/fs/queries";
// Colored file-type icons (Shugu's hand-made VS Code-style set).
import { FileTypeIcon } from "@/components/fileIcons";
// Mini-chibi mood-sync dans le Rail (S1a) — remplace l'avatar générique « SH ».
import { RailChibi } from "@/features/mascot/RailChibi";
// Clic droit « Ajouter au chat (@source) » — file d'attente consommée par le
// composer du ChatView (insertion d'une @-mention).
import { requestChatMention } from "@/features/chat/chatMentionStore";
import { pushToast } from "@/components/toast";
import { useModalFocusTrap } from "@/lib/modalFocus";

// ── Icons (24x24 stroke) ────────────────────────────────────
export function Icon({ name, size = 18, className = "" }: { name: string; size?: number; className?: string }) {
  const s = size;
  const p = (d: React.ReactNode) => (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={className}>{d}</svg>
  );
  switch (name) {
    case "chat":   return p(<><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.6A8.5 8.5 0 1 1 21 12Z"/></>);
    case "code":   return p(<><path d="m9 18-6-6 6-6"/><path d="m15 6 6 6-6 6"/></>);
    case "image":  return p(<><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></>);
    case "folder": return p(<><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></>);
    case "term":   return p(<><path d="m4 7 5 5-5 5"/><path d="M12 19h8"/></>);
    case "agent":  return p(<><circle cx="12" cy="8" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/><circle cx="12" cy="8" r="1" fill="currentColor"/></>);
    case "gallery":return p(<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>);
    case "gear":   return p(<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></>);
    case "plus":   return p(<><path d="M12 5v14M5 12h14"/></>);
    case "send":   return p(<><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7Z"/></>);
    case "search": return p(<><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></>);
    case "bell":   return p(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/></>);
    case "x":      return p(<><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>);
    case "down":   return p(<><path d="m6 9 6 6 6-6"/></>);
    case "sparkle":return p(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/></>);
    case "attach": return p(<><path d="m21 11-8.6 8.6a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8L16 6.5"/></>);
    case "mic":    return p(<><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></>);
    case "camera": return p(<><path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5L14.5 4Z"/><circle cx="12" cy="13" r="3.5"/></>);
    case "speaker": return p(<><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></>);
    case "speaker-off": return p(<><path d="M11 5 6 9H2v6h4l5 4V5Z"/><path d="m16 9 5 5"/><path d="m21 9-5 5"/></>);
    case "play":   return p(<><path d="m6 4 14 8L6 20Z"/></>);
    case "pause":  return p(<><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>);
    case "stop":   return p(<><rect x="5" y="5" width="14" height="14" rx="2"/></>);
    case "copy":   return p(<><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>);
    case "download": return p(<><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>);
    case "git":    return p(<><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8"/><path d="M16 12H8a2 2 0 0 1-2-2"/></>);
    case "branch": return p(<><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></>);
    case "commit": return p(<><circle cx="12" cy="12" r="4"/><line x1="1.05" y1="12" x2="7" y2="12"/><line x1="17.01" y1="12" x2="22.96" y2="12"/></>);
    case "merge":  return p(<><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/></>);
    case "pull":   return p(<><path d="M12 5v14"/><path d="m5 12 7 7 7-7"/></>);
    case "push":   return p(<><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></>);
    case "stash":  return p(<><rect x="3" y="3" width="18" height="6" rx="1"/><rect x="3" y="11" width="18" height="6" rx="1"/><line x1="8" y1="19" x2="16" y2="19"/></>);
    case "revert": return p(<><path d="M3 12a9 9 0 1 0 9-9"/><path d="m3 4 0 5 5 0"/></>);
    case "diff":   return p(<><path d="M9 3v6m0 6v6"/><path d="M6 6h6"/><path d="M6 18h6"/><path d="M15 9h6"/></>);
    case "file":   return p(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></>);
    case "folderTree": return p(<><path d="M3 7a2 2 0 0 1 2-2h3l2 2h4a2 2 0 0 1 2 2v1"/><path d="M8 21H5a2 2 0 0 1-2-2V7"/><path d="M21 14h-7a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h7Z"/></>);
    case "thumbs": return p(<><path d="M7 22V11"/><path d="M14 4l-1 7h6a2 2 0 0 1 2 2.2l-1 6A2 2 0 0 1 18 21H8.5"/></>);
    case "history":return p(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></>);
    case "shield": return p(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></>);
    case "palette": return p(<><circle cx="13.5" cy="6.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.5" cy="10.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="6.5" cy="12.5" r="1.3" fill="currentColor" stroke="none"/><path d="M12 2a10 10 0 1 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4c0-4.4-4.5-8-10-8Z"/></>);
    case "check":  return p(<><path d="M20 6 9 17l-5-5"/></>);
    case "chevron-left":  return p(<><path d="m15 18-6-6 6-6"/></>);
    case "chevron-right": return p(<><path d="m9 18 6-6-6-6"/></>);
    case "list":   return p(<><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></>);
    case "plug":   return p(<><path d="M12 22v-4"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M6 8h12v4a6 6 0 0 1-12 0V8Z"/></>);
    case "lock":   return p(<><rect x="4.5" y="11" width="15" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></>);
    default: return p(<circle cx="12" cy="12" r="6"/>);
  }
}

// ── Liquid Glass layer helper ────────────────────────────────
export function LiquidLayers() {
  return (
    <>
      <span className="lg-specular" style={{position:"absolute", inset:0, pointerEvents:"none", background:"radial-gradient(120% 80% at 30% -10%, rgba(255,255,255,0.18), transparent 55%), radial-gradient(80% 60% at 80% 110%, rgba(255,255,255,0.06), transparent 60%)", mixBlendMode:"screen", borderRadius:"inherit"}}/>
      <span className="lg-edge" style={{position:"absolute", inset:0, pointerEvents:"none", boxShadow:"inset 0 0 0 1px rgba(255,255,255,0.08), inset 0 1px 0 rgba(255,255,255,0.22)", borderRadius:"inherit"}}/>
    </>
  );
}

// ── Titlebar ────────────────────────────────────────────────
// `menu` is a ReactNode slot for the MenuBar — keeps Titlebar decoupled from
// the command system. MenuBar is assembled in RootLayout and passed down.
//
// Window controls (close / minimize / maximize) are wired directly here via
// dynamic Tauri imports — same pattern as src/mascot.tsx.
//
// CLOSE: hides the main window to the system tray (Discord/Steam pattern).
// Does NOT actually exit the app — the Rust side keeps running so the user
// can restore via the tray icon. Real shutdown is "Quit" in the tray menu,
// which calls app.exit(0) on the Rust side.
//
// The mascot window is intentionally left alone. It has its own visibility
// state (tucked/un-tucked, click-through) and the user typically wants it
// to keep floating even when the main IDE is hidden.

async function windowClose(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    // Hide the current window only — Rust tray code handles restore on
    // tray click and explicit Quit on tray menu.
    await mod.getCurrentWebviewWindow().hide();
  } catch (err) {
    console.warn("[Titlebar] hide failed:", err);
  }
}

async function windowMinimize(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    await mod.getCurrentWebviewWindow().minimize();
  } catch (err) {
    console.warn("[Titlebar] minimize failed:", err);
  }
}

async function windowToggleMaximize(): Promise<void> {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const win = mod.getCurrentWebviewWindow();
    if (await win.isMaximized()) {
      await win.unmaximize();
    } else {
      await win.maximize();
    }
  } catch (err) {
    console.warn("[Titlebar] toggle maximize failed:", err);
  }
}

export function Titlebar({ project = "shugu-forge", onSearch, onAvatar, sideCollapsed, onToggleSide, menu, onHistory, onBell, bellCount = 0, avatar }: any) {
  return (
    <div className="titlebar">
      <div className="traffic">
        <button className="dot close" aria-label="Close" title="Close Shugu Forge" onClick={() => void windowClose()}></button>
        <button className="dot min"   aria-label="Minimize" title="Minimize" onClick={() => void windowMinimize()}></button>
        <button className="dot max"   aria-label="Maximize" title="Toggle maximize" onClick={() => void windowToggleMaximize()}></button>
      </div>
      <button className="tb-action tb-side-toggle" title={sideCollapsed ? "Show side panel" : "Hide side panel"} onClick={onToggleSide}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2"/>
          <line x1="9" y1="4" x2="9" y2="20"/>
          {sideCollapsed
            ? <path d="M14 9l3 3-3 3"/>
            : <path d="M6 9l-3 3 3 3"/>}
        </svg>
      </button>
      <div className="brand">
        <div className="brand-mark"></div>
        <div className="brand-name">Shugu Forge<span className="sub">/ {project}</span></div>
      </div>
      {menu}
      <div className="tb-spacer"></div>
      <button type="button" className="tb-search" onClick={onSearch} aria-label="Search files, commands, generations">
        <Icon name="search" size={13}/>
        <span>Search files, commands, generations…</span>
        <span className="kbd">⌘K</span>
      </button>
      <div className="tb-spacer"></div>
      {/* Portal target for the chat ContextBubble trigger (ChatView portals its
          small context icon-button here so it sits with History/Bell/Settings).
          display:contents — the span vanishes from layout, the button becomes a
          direct flex child of .titlebar. */}
      <span id="tb-ctx-slot" className="tb-ctx-slot" />
      {/* Portal target for the cockpit right-panel toggle. CockpitShell portals
          its toggle button here so it sits with History/Bell, mirroring the left
          side-panel toggle. display:contents — same trick as tb-ctx-slot. */}
      <span id="tb-right-panel-slot" className="tb-ctx-slot" />
      {/* Projets récents — le même picker que la commande « Open Recent
          Folder… » de la palette. L'icône horloge = « reprendre où j'en
          étais », geste central dans Codex/Cursor. */}
      <button className="tb-action" title="Projets récents" aria-label="Projets récents" onClick={onHistory}>
        <Icon name="history" size={15}/>
      </button>
      {/* Cloche — ouvre le centre de notifications (journal des toasts).
          Badge = notifications non lues. */}
      <button className="tb-action tb-bell" title="Notifications" aria-label={bellCount > 0 ? `Notifications — ${bellCount} non lue(s)` : "Notifications"} onClick={onBell}>
        <Icon name="bell" size={15}/>
        {bellCount > 0 && <span className="tb-badge">{bellCount > 99 ? "99+" : bellCount}</span>}
      </button>
      {/* Compte — le popover .account-pop s'ancre en haut-droite (top:48px right:12px),
          sous la titlebar : son déclencheur vit donc ICI. L'avatar « SH » du Rail est
          devenu la mini-chibi (→ Profil de Shugu), on ne perd donc aucun accès. */}
      {/* Contenu piloté par RootLayout (initiales réelles du profil, ou glyphe
          générique si aucun nom). Fallback "VU" pour les rendus hors-app (design-kit). */}
      <button className="tb-avatar" title="Compte" aria-label="Compte" onClick={onAvatar}>{avatar ?? "VU"}</button>
    </div>
  );
}

// ── Activity Rail ───────────────────────────────────────────
type RailItem = { id: string; icon: string; label: string; kbd?: string; badge?: number };

// Audit UI/UX 2026-06-21 (phase Navigation) : le rail plat à 8 entrées ne
// hiérarchisait rien — l'utilisateur ne savait pas quelle surface est
// principale. Regroupé en Work (le cœur agent-IDE) / Agents (les runs) /
// Create (périphérie créative), micro-labels affichés dans le rail.
// `kbd` = raccourci par défaut de la commande view-* correspondante dans
// src/lib/commands.ts (⌘ = Ctrl sous Windows/Linux, cf. keybindings.ts).
export function Rail({ view, setView, onProfile, runningAgents = 0 }: any) {
  const groups: { label: string; items: RailItem[] }[] = [
    {
      label: "Work",
      items: [
        { id: "chat", icon: "chat", label: "Chat", kbd: "⌘⇧C" },
        { id: "code", icon: "code", label: "Editor", kbd: "⌘⇧E" },
        { id: "git",  icon: "git",  label: "Source Control" },
      ],
    },
    {
      label: "Agents",
      items: [
        // Badge = nombre d'agents en cours d'exécution : l'activité de fond
        // reste visible même depuis une autre vue (pattern Cursor).
        { id: "agents", icon: "agent", label: "Agents", kbd: "⌘⇧A", badge: runningAgents },
      ],
    },
    {
      label: "Create",
      items: [
        { id: "image",   icon: "image",   label: "Image",   kbd: "⌘⇧I" },
        { id: "studio",  icon: "palette", label: "Studio" },
        { id: "gallery", icon: "gallery", label: "Gallery", kbd: "⌘⇧G" },
      ],
    },
  ];

  const renderBtn = (it: RailItem) => (
    <button
      key={it.id}
      className={"rail-btn" + (view === it.id ? " active" : "")}
      onClick={() => setView(it.id)}
      aria-label={it.badge ? `${it.label} — ${it.badge} en cours` : it.label}
    >
      <Icon name={it.icon} size={18}/>
      {!!it.badge && <span className="rail-badge">{it.badge > 9 ? "9+" : it.badge}</span>}
      <span className="rail-tip">
        {it.label}
        {it.kbd && <span className="rail-tip-kbd">{it.kbd}</span>}
      </span>
    </button>
  );

  return (
    <nav className="rail">
      {groups.map((g, gi) => (
        <React.Fragment key={g.label}>
          {gi > 0 && <div className="rail-divider"/>}
          <div className="rail-group-label" aria-hidden="true">{g.label}</div>
          {g.items.map(renderBtn)}
        </React.Fragment>
      ))}
      <div className="rail-bottom">
        {/* Groupe Configure — accès direct aux Connections (clés API, MCP,
            providers) : surface de setup centrale pour un IDE agentique,
            auparavant enfouie dans Settings. */}
        <button
          className={"rail-btn" + (view === "connections" ? " active" : "")}
          onClick={() => setView("connections")}
          aria-label="Connections"
        >
          <Icon name="plug" size={18}/>
          <span className="rail-tip">Connections</span>
        </button>
        <button
          className={"rail-btn" + (view === "settings" ? " active" : "")}
          onClick={() => setView("settings")}
          aria-label="Settings"
        >
          <Icon name="gear" size={18}/>
          <span className="rail-tip">
            Settings
            <span className="rail-tip-kbd">⌘,</span>
          </span>
        </button>
        <RailChibi onClick={onProfile} />
      </div>
    </nav>
  );
}

// ── Side panel (varies by view) ─────────────────────────────
// (SideHistory — maquette de sidebar chat à faux groupes temporels — supprimé :
//  jamais importé ; la vraie sidebar est features/chat/chat-sidebar.tsx.)

// ── File tree (controlled expansion + CRUD UX) ─────────────
//
// Why expansion state is HOISTED into SideFiles rather than kept inside each
// FileNode: when the user picks "New file" / "New folder" from a closed
// folder's context menu, that target folder must auto-open so the inline
// create row is visible. Internal per-node useState makes that impossible
// from the parent. We track *collapsed* paths (default = open) so newly
// arrived folders from a tree refresh feel "open by default" as before.

type FileCtxAction = "newFile" | "newFolder" | "rename" | "delete" | "addToChat";

export function SideFiles({ active, onPick }: any) {
  // LOT 3 git-ui — per-path git status char (no-op outside a git repo).
  const gitStatusMap = useGitStatusMap();
  // Lazy tree — root level only; each folder fetches its children on expand.
  // No 5000-entry cap (the recursive fs_read_dir hit it on big ML projects).
  const { data: rootChildren = [] } = useDirChildren("");
  // Expansion is OPT-IN now (default closed → only root level visible).
  // Was `collapsed` (default open) when the whole tree loaded eagerly; the
  // lazy loader can't pre-open everything, so we track which folders ARE open.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null); // path of node being renamed
  const [ctxMenu, setCtxMenu] = useState<{ node: any; x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<any | null>(null);
  const [creating, setCreating] = useState<{ parent: string; kind: "file" | "folder" } | null>(null);
  // Popover that asks the user "file or folder?" before the inline
  // create row appears. Anchored at the (x, y) of the trigger button.
  const [createPopover, setCreatePopover] = useState<{ parent: string; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleExpanded = (path: string) => {
    setExpanded(s => {
      const n = new Set(s);
      if (n.has(path)) n.delete(path); else n.add(path);
      return n;
    });
  };
  const forceExpand = (path: string) => {
    setExpanded(s => { const n = new Set(s); n.add(path); return n; });
  };

  const openCtxMenu = (node: any, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ node, x: e.clientX, y: e.clientY });
  };

  const doCtxAction = (action: FileCtxAction) => {
    if (!ctxMenu) return;
    const node = ctxMenu.node;
    setCtxMenu(null);
    if (action === "rename") {
      setRenaming(node.path);
    } else if (action === "delete") {
      setConfirmDelete(node);
    } else if (action === "addToChat") {
      // Insère une @-mention dans le composer chat (flux mentions.ts : le
      // contenu du fichier est joint au modèle à l'envoi). Si le chat n'est
      // pas monté, la demande attend la prochaine ouverture du composer.
      requestChatMention(node.path);
      pushToast(`@${node.path.split("/").pop()} ajouté comme source du prochain message`, "success", 3500);
    } else if (action === "newFile" || action === "newFolder") {
      const isDir = node.isDir ?? Array.isArray(node.children);
      // New file in a folder = child; new file on a file = sibling.
      const parent = isDir ? node.path : node.path.split("/").slice(0, -1).join("/");
      if (isDir) forceExpand(node.path);
      setCreating({ parent, kind: action === "newFile" ? "file" : "folder" });
    }
  };

  // Helpers that talk to the Rust backend. Errors surface in the toast strip.
  // The tree refresh happens automatically via fs://changed (RootLayout listener).
  const doRename = async (oldPath: string, newName: string) => {
    setRenaming(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    const oldName = oldPath.split("/").pop();
    if (trimmed === oldName) return; // no-op
    const dir = oldPath.split("/").slice(0, -1).join("/");
    const newPath = dir ? `${dir}/${trimmed}` : trimmed;
    try { await fsRename(oldPath, newPath); }
    catch (e: any) { setError(String(e)); }
  };
  const doDelete = async (node: any) => {
    setConfirmDelete(null);
    try { await fsDelete(node.path); }
    catch (e: any) { setError(String(e)); }
  };
  const doCreate = async (parent: string, kind: "file" | "folder", name: string) => {
    setCreating(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    const newPath = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      if (kind === "file") await fsCreateFile(newPath);
      else await fsCreateDir(newPath);
    } catch (e: any) { setError(String(e)); }
  };

  // Open the create-kind popover positioned just below an anchor button.
  // `parent` is the directory path the new file/folder should land in;
  // root creation uses `parent === ""`.
  const openCreatePopover = (parent: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setCreatePopover({ parent, x: rect.left, y: rect.bottom + 4 });
  };

  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Explorer · shugu-forge</div>
        {/* Open Folder retiré du header — accessible via File menu côté Titlebar.
            Le "+" ouvre maintenant un popover qui demande fichier ou dossier. */}
        <button
          className="side-new"
          onClick={(e) => openCreatePopover("", e)}
          title="New file or folder at root"
        >
          <Icon name="plus" size={11}/>
        </button>
      </div>
      <div className="side-list scroll">
        {creating?.parent === "" && (
          <FileCreateRow
            depth={0}
            kind={creating.kind}
            onCommit={(name) => doCreate("", creating.kind, name)}
            onCancel={() => setCreating(null)}
          />
        )}
        {rootChildren.map((node: any) => (
          <FileNode
            key={node.path}
            node={node}
            depth={0}
            active={active}
            onPick={onPick}
            expanded={expanded}
            onToggleExpanded={toggleExpanded}
            renaming={renaming}
            onCommitRename={doRename}
            onCancelRename={() => setRenaming(null)}
            onContextMenu={openCtxMenu}
            creating={creating}
            onCommitCreate={doCreate}
            onCancelCreate={() => setCreating(null)}
            onOpenCreatePopover={openCreatePopover}
            gitStatusMap={gitStatusMap}
          />
        ))}
      </div>
      {/* Portal the overlay UIs to document.body — the side panel's
          `backdrop-filter` creates a containing block that would otherwise
          trap our `position: fixed` menus and modals inside .side. */}
      {ctxMenu && createPortal(
        <FileCtxMenu
          node={ctxMenu.node}
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          onAction={doCtxAction}
        />,
        document.body
      )}
      {createPopover && createPortal(
        <FileCreatePopover
          x={createPopover.x}
          y={createPopover.y}
          onPick={(kind) => {
            const parent = createPopover.parent;
            setCreatePopover(null);
            if (parent) forceExpand(parent);
            setCreating({ parent, kind });
          }}
          onClose={() => setCreatePopover(null)}
        />,
        document.body
      )}
      {confirmDelete && createPortal(
        <FileDeleteConfirm
          node={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => doDelete(confirmDelete)}
        />,
        document.body
      )}
      {error && (
        <button type="button" className="side-toast" onClick={() => setError(null)} title="Click to dismiss" role="alert" aria-label={`Error: ${error}. Click to dismiss`}>
          {error}
        </button>
      )}
    </aside>
  );
}

export function FileNode({
  node, depth, active, onPick,
  expanded, onToggleExpanded,
  renaming, onCommitRename, onCancelRename,
  onContextMenu,
  creating, onCommitCreate, onCancelCreate,
  onOpenCreatePopover,
  gitStatusMap,
}: any) {
  // A directory node carries `children: []` from the shallow loader (files
  // carry `undefined`), so `isDir` is the explicit flag with array fallback
  // for any eagerly-loaded node (Studio passes recursive trees elsewhere).
  const isDir = node.isDir ?? Array.isArray(node.children);
  // creating.parent === node.path keeps a folder force-open while the user
  // is typing the new child's name (the create row lives inside its children).
  const isOpen = (isDir && expanded.has(node.path)) || creating?.parent === node.path;
  const isRenaming = renaming === node.path;
  const pad = 10 + depth * 14;
  // Lazy children — fetched only while this folder is open. `node.children`
  // (pre-loaded) wins if present and non-empty; otherwise use the fetched set.
  const { data: fetchedChildren = [] } = useDirChildren(node.path, isDir && isOpen);
  const children: any[] =
    Array.isArray(node.children) && node.children.length > 0
      ? node.children
      : fetchedChildren;
  // LOT 3 git-ui — stamp the node with its current git char if any.
  // The legacy renderer below uses `node.git` so we expose it via a local
  // variable instead of mutating the upstream node (mutations would
  // poison the TanStack cache for `useFileTree`).
  const gitChar: GitStatusChar | undefined =
    !isDir && gitStatusMap ? gitStatusMap.get(node.path) : undefined;

  return (
    <>
      <div
        className={"side-item" + (!isDir && node.path === active ? " active" : "")}
        style={{ paddingLeft: pad }}
        role="button"
        tabIndex={isRenaming ? -1 : 0}
        aria-label={isDir ? `Folder ${node.name}` : `File ${node.name}`}
        aria-expanded={isDir ? isOpen : undefined}
        aria-current={!isDir && node.path === active ? "true" : undefined}
        onClick={() => {
          if (isRenaming) return;
          if (isDir) onToggleExpanded(node.path);
          else onPick(node.path);
        }}
        onKeyDown={(e) => {
          if (isRenaming) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (isDir) onToggleExpanded(node.path);
            else onPick(node.path);
          }
        }}
        onContextMenu={(e) => onContextMenu(node, e)}
      >
        {isDir
          ? <span
              className="file-chevron"
              aria-hidden="true"
              onClick={(e) => { e.stopPropagation(); onToggleExpanded(node.path); }}
            >{isOpen ? "▾" : "▸"}</span>
          : <span className="file-chevron-spacer" />}
        <span className="ico" style={{ display: "inline-flex", alignItems: "center" }}>
          <FileTypeIcon name={node.name} isDir={isDir} isOpen={isOpen} size={15} />
        </span>
        {isRenaming
          ? <FileRenameInput
              initial={node.name}
              onCommit={(newName) => onCommitRename(node.path, newName)}
              onCancel={onCancelRename}
            />
          : <span className="label">{node.name}</span>}
        {!isRenaming && !isDir && (gitChar || node.git) && (() => {
          // LOT 3 git-ui — gitChar (live status) takes precedence over the
          // legacy static `node.git` field. Color map mirrors the
          // VSCode SCM color tokens : warn = modified, success = added,
          // tertiary = untracked, danger = conflicted / deleted, muted otherwise.
          const ch = (gitChar ?? node.git) as string;
          const color =
            ch === "M" ? "var(--warn)"
            : ch === "A" ? "var(--success)"
            : ch === "?" ? "var(--tertiary)"
            : ch === "U" ? "var(--danger)"
            : ch === "D" ? "var(--danger)"
            : "var(--on-surface-muted)";
          return <span className="meta" style={{ color }}>{ch}</span>;
        })()}
        {/* Hover-visible "+" — only on folders. Clicking opens the same
            file/folder choice popover used by the header "+", with this
            node's path as the parent. The popover's onPick will
            forceExpand(node.path) so the new child is immediately visible. */}
        {isDir && !isRenaming && onOpenCreatePopover && (
          <button
            className="file-add-btn"
            title="New file or folder here"
            onClick={(e) => onOpenCreatePopover(node.path, e)}
          >
            <Icon name="plus" size={10}/>
          </button>
        )}
      </div>
      {isDir && isOpen && (
        <>
          {creating?.parent === node.path && (
            <FileCreateRow
              depth={depth + 1}
              kind={creating.kind}
              onCommit={(name) => onCommitCreate(node.path, creating.kind, name)}
              onCancel={onCancelCreate}
            />
          )}
          {children.map((c: any) => (
            <FileNode
              key={c.path}
              node={c}
              depth={depth + 1}
              active={active}
              onPick={onPick}
              expanded={expanded}
              onToggleExpanded={onToggleExpanded}
              renaming={renaming}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
              onContextMenu={onContextMenu}
              creating={creating}
              onCommitCreate={onCommitCreate}
              onCancelCreate={onCancelCreate}
              onOpenCreatePopover={onOpenCreatePopover}
              gitStatusMap={gitStatusMap}
            />
          ))}
        </>
      )}
    </>
  );
}

// ── Inline edit input (rename) ──────────────────────────────
// Same pattern as VS Code: Enter commits, Escape cancels, blur commits too.
function FileRenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // committedRef avoids the double-fire of blur AFTER Enter/Escape.
  const committedRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select the basename only (everything before the last dot) so the
    // extension is preserved when the user starts typing — VS Code behavior.
    const dot = initial.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="file-rename-input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
      }}
      onBlur={commit}
    />
  );
}

// ── Inline create row (new file / new folder) ───────────────
function FileCreateRow({ depth, kind, onCommit, onCancel }: { depth: number; kind: "file" | "folder"; onCommit: (name: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committedRef = useRef(false);
  const pad = 10 + depth * 14;

  useEffect(() => { inputRef.current?.focus(); }, []);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <div className="side-item side-item-create" style={{ paddingLeft: pad }}>
      <span className="file-chevron-spacer" />
      <span className="ico" style={{ display: "inline-flex", alignItems: "center" }}>
        <FileTypeIcon name={kind === "folder" ? "folder" : "new"} isDir={kind === "folder"} size={15} />
      </span>
      <input
        ref={inputRef}
        className="file-rename-input"
        value={value}
        placeholder={kind === "folder" ? "New folder name…" : "New file name…"}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") { e.preventDefault(); cancel(); }
          e.stopPropagation();
        }}
        onBlur={commit}
      />
    </div>
  );
}

// ── File-or-folder choice popover ───────────────────────────
// Shown when the user clicks the "+" button in the explorer header or
// next to a folder row. Reuses the .file-ctx-menu visual style so it
// matches the right-click context menu. Click-outside / Escape closes.
function FileCreatePopover({
  x, y, onPick, onClose,
}: {
  x: number; y: number;
  onPick: (kind: "file" | "folder") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="file-ctx-menu" style={{ left: x, top: y, minWidth: 140 }}>
      <button onClick={() => onPick("file")}>New File…</button>
      <button onClick={() => onPick("folder")}>New Folder…</button>
    </div>
  );
}

// ── Right-click context menu (file tree only) ───────────────
// Anchored to the click coords. Mouse-down outside closes it.
function FileCtxMenu({ node, x, y, onClose, onAction }: { node: any; x: number; y: number; onClose: () => void; onAction: (a: FileCtxAction) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const isDir = node.isDir ?? Array.isArray(node.children);
  return (
    <div ref={ref} className="file-ctx-menu" style={{ left: x, top: y }}>
      {/* "New" items live at the top — VS Code convention. For a file we
          interpret them as "new sibling" (handled in doCtxAction above). */}
      <button onClick={() => onAction("newFile")}>New File…</button>
      <button onClick={() => onAction("newFolder")}>New Folder…</button>
      <div className="file-ctx-sep" />
      {/* Fichiers seulement — une @-mention de dossier ne se résout pas. */}
      {!isDir && (
        <button onClick={() => onAction("addToChat")}>Ajouter au chat (@source)</button>
      )}
      <button onClick={() => onAction("rename")}>Rename…</button>
      <button onClick={() => onAction("delete")} className="danger">Delete</button>
      {/* Hint at the bottom so the user knows what they're targeting. */}
      <div className="file-ctx-target">{isDir ? "📁" : "📄"} {node.name}</div>
    </div>
  );
}

// ── Delete confirmation modal ───────────────────────────────
// Centered overlay; click on backdrop = cancel, Escape = cancel.
function FileDeleteConfirm({ node, onCancel, onConfirm }: { node: any; onCancel: () => void; onConfirm: () => void }) {
  const isDir = node.isDir ?? Array.isArray(node.children);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusTrap({
    open: true,
    containerRef: dialogRef,
    initialFocusRef: cancelRef,
    onEscape: onCancel,
  });
  return (
    <div className="file-delete-overlay" onClick={onCancel}>
      <div
        ref={dialogRef}
        className="file-delete-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Delete ${isDir ? "folder" : "file"} ${node.name}?`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Delete {isDir ? "folder" : "file"}?</h3>
        <p>
          <strong>{node.name}</strong> will be permanently removed
          {isDir ? ", along with everything inside it." : "."}
        </p>
        <p className="muted">This cannot be undone.</p>
        <div className="file-delete-actions">
          <button ref={cancelRef} className="lgb lgb-sm" onClick={onCancel}>Cancel</button>
          <button className="lgb lgb-sm danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}

export function SideGallery({ folders, active, onPick }: any) {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Collections</div>
        {/* Le « + » inerte (aucun flux de création de collection) est retiré. */}
      </div>
      <div className="side-list scroll">
        {folders.map((f: any) => (
          <button type="button" key={f.id} className={"side-item" + (f.id === active ? " active" : "")} onClick={() => onPick(f.id)} aria-current={f.id === active ? "true" : undefined} aria-label={f.name}>
            <Icon name="gallery" size={13} className="ico"/>
            <span className="label">{f.name}</span>
            <span className="meta">{f.count}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function SideAgents({ agents, active, onPick }: any) {
  const running = agents.filter((a: any) => a.status === "running");
  const idle = agents.filter((a: any) => a.status !== "running");
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Workers</div>
        {/* L'ancien « + New » était inerte — la création d'agent vit dans la
            page (« + Nouvel agent » d'AgentDefsManager). */}
      </div>
      <div className="side-list scroll">
        {/* Sections affichées seulement si peuplées ; à vide, un état
            pédagogique remplace deux labels RUNNING/IDLE orphelins. */}
        {agents.length === 0 && (
          <div className="side-empty">
            <p>Aucun agent en cours.</p>
            <p className="muted">
              Lance une tâche en mode <b>Agent</b> depuis le Chat — les runs
              et leurs transcripts apparaîtront ici.
            </p>
          </div>
        )}
        {running.length > 0 && <div className="side-section-label">Running</div>}
        {running.map((a: any) => (
          <button type="button" key={a.id} className={"side-item" + (a.id === active ? " active" : "")} onClick={() => onPick(a.id)} aria-current={a.id === active ? "true" : undefined} aria-label={a.name}>
            <span className="ico" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:14,height:14,fontSize:11}} aria-hidden="true">{a.icon}</span>
            <span className="label">{a.name}</span>
            <span className="meta" style={{color:'var(--tertiary)'}} aria-hidden="true">●</span>
          </button>
        ))}
        {idle.length > 0 && <div className="side-section-label">Idle</div>}
        {idle.map((a: any) => (
          <button type="button" key={a.id} className={"side-item" + (a.id === active ? " active" : "")} onClick={() => onPick(a.id)} aria-current={a.id === active ? "true" : undefined} aria-label={a.name}>
            <span className="ico" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:14,height:14,fontSize:11}} aria-hidden="true">{a.icon}</span>
            <span className="label">{a.name}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function SideSettings({ section, setSection }: any) {
  const sections = [
    { id: 'general', label: 'General' },
    { id: 'profile', label: 'Account & Profile', group: 'You' },
    { id: 'connections', label: 'Connections', group: 'You' },
    { id: 'interface', label: 'Interface & Display' },
    { id: 'models', label: 'Models & Keys' },
    { id: 'image', label: 'Image Generation' },
    { id: 'editor', label: 'Editor' },
    { id: 'mascot', label: 'Profil de Shugu' },
    { id: 'shortcuts', label: 'Keyboard shortcuts' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'command-rules', label: 'Command Rules' },
    { id: 'ops', label: 'Storage & Backup' },
    { id: 'about', label: 'About' },
  ];
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Settings</div>
      </div>
      <div className="side-list scroll">
        {sections.map(s => (
          <button type="button" key={s.id} className={"side-item" + (s.id === section ? " active" : "")} onClick={() => setSection(s.id)} aria-current={s.id === section ? "true" : undefined} aria-label={s.label}>
            <span className="label">{s.label}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// Resizable side panel — wraps the per-view aside in a column with a drag handle
export function SidePanel({ width, setWidth, collapsed, children }: any) {
  if (collapsed || !children) return null;
  const onResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const start = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const maxAllowed = Math.min(520, Math.max(220, window.innerWidth - 360));
      const next = Math.max(180, Math.min(maxAllowed, startW + (ev.clientX - start)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "ew-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  return (
    <div className="side-wrap" style={{ width }}>
      {children}
      <div className="side-resize" onMouseDown={onResize} title="Drag to resize"></div>
    </div>
  );
}
