// Shugu Forge — shared atoms (icons, layout chrome)
// Ported from prototype components.jsx — exports replace window globals.

import React, { useState } from "react";

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
    case "play":   return p(<><path d="m6 4 14 8L6 20Z"/></>);
    case "pause":  return p(<><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></>);
    case "stop":   return p(<><rect x="5" y="5" width="14" height="14" rx="2"/></>);
    case "copy":   return p(<><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>);
    case "download": return p(<><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>);
    case "git":    return p(<><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8"/><path d="M16 12H8a2 2 0 0 1-2-2"/></>);
    case "diff":   return p(<><path d="M9 3v6m0 6v6"/><path d="M6 6h6"/><path d="M6 18h6"/><path d="M15 9h6"/></>);
    case "file":   return p(<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6"/></>);
    case "folderTree": return p(<><path d="M3 7a2 2 0 0 1 2-2h3l2 2h4a2 2 0 0 1 2 2v1"/><path d="M8 21H5a2 2 0 0 1-2-2V7"/><path d="M21 14h-7a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h7Z"/></>);
    case "thumbs": return p(<><path d="M7 22V11"/><path d="M14 4l-1 7h6a2 2 0 0 1 2 2.2l-1 6A2 2 0 0 1 18 21H8.5"/></>);
    case "history":return p(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></>);
    case "shield": return p(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></>);
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
export function Titlebar({ project = "shugu-forge", onSearch, onAvatar, sideCollapsed, onToggleSide }: any) {
  return (
    <div className="titlebar">
      <div className="traffic">
        <button className="dot close" aria-label="Close"></button>
        <button className="dot min" aria-label="Minimize"></button>
        <button className="dot max" aria-label="Maximize"></button>
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
      <div className="tb-spacer"></div>
      <div className="tb-search" onClick={onSearch}>
        <Icon name="search" size={13}/>
        <span>Search files, commands, generations…</span>
        <span className="kbd">⌘K</span>
      </div>
      <div className="tb-spacer"></div>
      <button className="tb-action" title="History"><Icon name="history" size={15}/></button>
      <button className="tb-action" title="Notifications"><Icon name="bell" size={15}/></button>
      <button className="tb-action" title="Settings"><Icon name="gear" size={15}/></button>
      <button className="tb-avatar" title="Account" onClick={onAvatar}>
        <span>VU</span>
        <span className="online"></span>
      </button>
    </div>
  );
}

// ── Activity Rail ───────────────────────────────────────────
export function Rail({ view, setView }: any) {
  const items = [
    { id: "chat",    icon: "chat",    label: "Chat" },
    { id: "code",    icon: "code",    label: "Editor" },
    { id: "image",   icon: "image",   label: "Image" },
    { id: "agents",  icon: "agent",   label: "Agents" },
    { id: "gallery", icon: "gallery", label: "Gallery" },
  ];
  return (
    <nav className="rail">
      {items.map((it, i) => (
        <React.Fragment key={it.id}>
          {i === 3 && <div className="rail-divider"/>}
          <button
            className={"rail-btn" + (view === it.id ? " active" : "")}
            onClick={() => setView(it.id)}
            aria-label={it.label}
          >
            <Icon name={it.icon} size={18}/>
            <span className="rail-tip">{it.label}</span>
          </button>
        </React.Fragment>
      ))}
      <div className="rail-bottom">
        <button
          className={"rail-btn" + (view === "settings" ? " active" : "")}
          onClick={() => setView("settings")}
          aria-label="Settings"
        >
          <Icon name="gear" size={18}/>
          <span className="rail-tip">Settings</span>
        </button>
        <div className="rail-avatar" title="Account">SH</div>
      </div>
    </nav>
  );
}

// ── Side panel (varies by view) ─────────────────────────────
export function SideHistory({ items, active, onPick, onNew }: any) {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Conversations</div>
        <button className="side-new" onClick={onNew}><Icon name="plus" size={11}/> New</button>
      </div>
      <div className="side-list scroll">
        <div className="side-section-label">Today</div>
        {items.slice(0, 3).map((c: any) => (
          <div key={c.id} className={"side-item" + (c.id === active ? " active" : "")} onClick={() => onPick(c.id)}>
            <Icon name="chat" size={13} className="ico"/>
            <span className="label">{c.title}</span>
            <span className="meta">{c.time}</span>
          </div>
        ))}
        <div className="side-section-label">Yesterday</div>
        {items.slice(3, 6).map((c: any) => (
          <div key={c.id} className={"side-item" + (c.id === active ? " active" : "")} onClick={() => onPick(c.id)}>
            <Icon name="chat" size={13} className="ico"/>
            <span className="label">{c.title}</span>
            <span className="meta">{c.time}</span>
          </div>
        ))}
        <div className="side-section-label">Older</div>
        {items.slice(6).map((c: any) => (
          <div key={c.id} className={"side-item" + (c.id === active ? " active" : "")} onClick={() => onPick(c.id)}>
            <Icon name="chat" size={13} className="ico"/>
            <span className="label">{c.title}</span>
            <span className="meta">{c.time}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function SideFiles({ tree, active, onPick }: any) {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Explorer · shugu-forge</div>
        <button className="side-new"><Icon name="plus" size={11}/></button>
      </div>
      <div className="side-list scroll">
        {tree.map((node: any) => <FileNode key={node.path} node={node} depth={0} active={active} onPick={onPick}/>) }
      </div>
    </aside>
  );
}

export function FileNode({ node, depth, active, onPick }: any) {
  const [open, setOpen] = useState(node.open !== false);
  const isDir = node.children;
  const pad = 10 + depth * 14;
  return (
    <>
      <div
        className={"side-item" + (!isDir && node.path === active ? " active" : "")}
        style={{ paddingLeft: pad }}
        onClick={() => isDir ? setOpen(o => !o) : onPick(node.path)}
      >
        {isDir
          ? <Icon name="folder" size={13} className="ico" />
          : <Icon name="file" size={13} className="ico" />}
        <span className="label">{node.name}</span>
        {!isDir && node.git && <span className="meta" style={{color: node.git === 'M' ? 'var(--warn)' : node.git === 'A' ? 'var(--success)' : 'var(--on-surface-muted)'}}>{node.git}</span>}
      </div>
      {isDir && open && node.children.map((c: any) => <FileNode key={c.path} node={c} depth={depth+1} active={active} onPick={onPick}/>) }
    </>
  );
}

export function SideGallery({ folders, active, onPick }: any) {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Collections</div>
        <button className="side-new"><Icon name="plus" size={11}/></button>
      </div>
      <div className="side-list scroll">
        {folders.map((f: any) => (
          <div key={f.id} className={"side-item" + (f.id === active ? " active" : "")} onClick={() => onPick(f.id)}>
            <Icon name="gallery" size={13} className="ico"/>
            <span className="label">{f.name}</span>
            <span className="meta">{f.count}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function SideAgents({ agents, active, onPick }: any) {
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Workers</div>
        <button className="side-new"><Icon name="plus" size={11}/> New</button>
      </div>
      <div className="side-list scroll">
        <div className="side-section-label">Running</div>
        {agents.filter((a: any) => a.status === 'running').map((a: any) => (
          <div key={a.id} className={"side-item" + (a.id === active ? " active" : "")} onClick={() => onPick(a.id)}>
            <span className="ico" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:14,height:14,fontSize:11}}>{a.icon}</span>
            <span className="label">{a.name}</span>
            <span className="meta" style={{color:'var(--tertiary)'}}>●</span>
          </div>
        ))}
        <div className="side-section-label">Idle</div>
        {agents.filter((a: any) => a.status !== 'running').map((a: any) => (
          <div key={a.id} className={"side-item" + (a.id === active ? " active" : "")} onClick={() => onPick(a.id)}>
            <span className="ico" style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:14,height:14,fontSize:11}}>{a.icon}</span>
            <span className="label">{a.name}</span>
          </div>
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
    { id: 'shortcuts', label: 'Keyboard shortcuts' },
    { id: 'privacy', label: 'Privacy' },
    { id: 'about', label: 'About' },
  ];
  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Settings</div>
      </div>
      <div className="side-list scroll">
        {sections.map(s => (
          <div key={s.id} className={"side-item" + (s.id === section ? " active" : "")} onClick={() => setSection(s.id)}>
            <span className="label">{s.label}</span>
          </div>
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
