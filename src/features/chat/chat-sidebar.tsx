// Shugu Forge — rich chat sidebar with groups, drag, context menu, filters.
// Ported from chat-sidebar.jsx.

import { useState, useEffect, useRef, useMemo } from "react";
import { Icon } from "@/components/components";

export const SEED_GROUPS = [
  { id: "pinned",    label: "Pinned",    pinnedSection: true },
  { id: "sdnc",      label: "SDNC" },
  { id: "shugu",     label: "Shugu_Stream" },
  { id: "ungrouped", label: "Ungrouped" },
];

export const SEED_CONVOS: any[] = [
  { id: "c1", title: "amazing-grothendieck-2586d1", group: "pinned",    pinned: true,  status: "active", env: "dev",  updated: Date.now() - 4*60*1000 },
  { id: "c2", title: "Research Liquid technology capabilities and opportunities", group: "sdnc", status: "active", env: "dev",  updated: Date.now() - 22*60*1000 },
  { id: "c3", title: "Analyze SDNC implementation and identify issues",            group: "sdnc", status: "active", env: "prod", updated: Date.now() - 2*3600*1000 },
  { id: "c4", title: "Deep UX audit and workflow analysis",                        group: "shugu",status: "active", env: "dev",  updated: Date.now() - 5*3600*1000 },
  { id: "c5", title: "Veil pipeline Tauri",                                        group: "ungrouped", status: "active", env: "dev", updated: Date.now() - 26*3600*1000 },
  { id: "c6", title: "CodeMirror 6 + neovim bindings",                             group: "ungrouped", status: "active", env: "dev", updated: Date.now() - 28*3600*1000,
    children: [
      { id: "c6a", title: "Vim keymap research",   group: "ungrouped", status: "active", updated: Date.now() - 29*3600*1000 },
      { id: "c6b", title: "Insert-mode escape UX", group: "ungrouped", status: "active", updated: Date.now() - 30*3600*1000 },
    ]
  },
  { id: "c7", title: "Local Ollama integration",                                   group: "ungrouped", status: "archived", env: "dev", updated: Date.now() - 4*86400*1000 },
];

export const FMT_RELATIVE = (ts: number) => {
  const d = Math.max(0, (Date.now() - ts) / 1000);
  if (d < 60)        return Math.floor(d) + "s";
  if (d < 3600)      return Math.floor(d / 60) + "m";
  if (d < 86400)     return Math.floor(d / 3600) + "h";
  if (d < 7 * 86400) return Math.floor(d / 86400) + "d";
  return new Date(ts).toLocaleDateString();
};

export function ChatSidebar({ activeId, setActiveId, onActiveTitle }: any) {
  const [groups, setGroups]   = useState<any[]>(SEED_GROUPS);
  const [convos, setConvos]   = useState<any[]>(SEED_CONVOS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState({
    status: "active",
    project: "all",
    env: "all",
    activity: "all",
    groupBy: "custom",
    sortBy: "recency",
  });
  const [ctx, setCtx]         = useState<any>({ open: false, x: 0, y: 0, convo: null, submenu: null });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<any>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  useEffect(() => {
    if (!onActiveTitle) return;
    const c = convos.find((c: any) => c.id === activeId)
      || convos.flatMap((c: any) => c.children || []).find((c: any) => c.id === activeId);
    onActiveTitle(c?.title || null);
  }, [activeId, convos, onActiveTitle]);

  const visible = useMemo(() => {
    return convos.filter((c: any) => {
      if (filters.status === "active"   && c.status !== "active") return false;
      if (filters.status === "archived" && c.status !== "archived") return false;
      if (filters.project !== "all"     && c.group !== filters.project) return false;
      if (filters.env !== "all"         && c.env !== filters.env) return false;
      if (filters.activity !== "all") {
        const cutoff = (({ "24h": 86400, "7d": 7*86400, "30d": 30*86400 } as any)[filters.activity]) * 1000;
        if (Date.now() - c.updated > cutoff) return false;
      }
      return true;
    }).sort((a: any, b: any) => {
      if (filters.sortBy === "name")    return a.title.localeCompare(b.title);
      if (filters.sortBy === "unread")  return (b.unread || 0) - (a.unread || 0);
      return b.updated - a.updated;
    });
  }, [convos, filters]);

  const groupsForRender = useMemo(() => {
    if (filters.groupBy === "none") return [{ id: "_all", label: null, items: visible } as any];
    if (filters.groupBy === "env") {
      const m = new Map<string, any[]>();
      visible.forEach((c: any) => {
        const k = c.env || "—";
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(c);
      });
      return [...m.entries()].map(([k, items]) => ({ id: k, label: k.toUpperCase(), items }));
    }
    if (filters.groupBy === "activity") {
      const buckets = [
        { id: "today", label: "Today",     test: (c: any) => Date.now() - c.updated < 86400*1000 },
        { id: "week",  label: "This week", test: (c: any) => Date.now() - c.updated < 7*86400*1000 },
        { id: "older", label: "Older",     test: () => true },
      ];
      const used = new Set<string>();
      return buckets.map(b => ({
        id: b.id, label: b.label,
        items: visible.filter((c: any) => !used.has(c.id) && b.test(c) && used.add(c.id))
      })).filter(g => g.items.length);
    }
    return groups.map((g: any) => ({
      id: g.id, label: g.label, pinnedSection: g.pinnedSection,
      items: visible.filter((c: any) => g.pinnedSection ? c.pinned : (!c.pinned && c.group === g.id))
    })).filter((g: any) => g.items.length || !g.pinnedSection);
  }, [visible, filters.groupBy, groups]);

  const patch = (id: string, p: any) => setConvos(cs => cs.map((c: any) => c.id === id ? { ...c, ...p, updated: p.updated ?? c.updated } : c));
  const remove = (id: string) => setConvos(cs => cs.filter((c: any) => c.id !== id));
  const togglePin = (id: string) => patch(id, { pinned: !convos.find((c: any) => c.id === id)?.pinned });
  const archive   = (id: string) => patch(id, { status: "archived" });
  const unarchive = (id: string) => patch(id, { status: "active" });
  const duplicate = (id: string) => {
    const c = convos.find((c: any) => c.id === id);
    if (!c) return;
    setConvos(cs => [{ ...c, id: c.id + "-copy-" + Date.now(), title: c.title + " (copy)", updated: Date.now() }, ...cs]);
  };
  const moveTo   = (id: string, groupId: string) => patch(id, { group: groupId, updated: Date.now() });
  const addGroup = (label: string) => {
    const id = "g-" + Date.now();
    setGroups(g => [...g.slice(0, -1), { id, label }, g[g.length - 1]]);
    return id;
  };

  const onDragStart = (e: React.DragEvent, id: string) => {
    setDraggingId(id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  };
  const onDragEnd = () => { setDraggingId(null); setDropTarget(null); };
  const onDragOverGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ groupId, convoId: null });
  };
  const onDropGroup = (e: React.DragEvent, groupId: string) => {
    e.preventDefault();
    if (draggingId) {
      if (groupId === "pinned") togglePin(draggingId);
      else patch(draggingId, { group: groupId, pinned: false, updated: Date.now() });
    }
    setDraggingId(null); setDropTarget(null);
  };

  const openCtx = (e: React.MouseEvent, convo: any) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ open: true, x: e.clientX, y: e.clientY, convo, submenu: null });
  };
  const closeCtx = () => setCtx((c: any) => ({ ...c, open: false, submenu: null }));

  const [groupCtx, setGroupCtx] = useState<any>({ open: false, x: 0, y: 0, group: null });
  const openGroupCtx = (e: React.MouseEvent, group: any) => {
    e.preventDefault();
    e.stopPropagation();
    setGroupCtx({ open: true, x: e.clientX, y: e.clientY, group });
  };
  const closeGroupCtx = () => setGroupCtx((g: any) => ({ ...g, open: false }));
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);

  const renameGroup = (id: string, label: string) => setGroups(gs => gs.map((g: any) => g.id === id ? { ...g, label } : g));
  const deleteGroup = (id: string) => {
    if (id === "pinned" || id === "ungrouped") return;
    setConvos(cs => cs.map((c: any) => c.group === id ? { ...c, group: "ungrouped" } : c));
    setGroups(gs => gs.filter((g: any) => g.id !== id));
  };
  const moveGroup = (id: string, beforeId: string) => {
    setGroups(gs => {
      const item = gs.find((g: any) => g.id === id);
      if (!item || item.pinnedSection || id === "ungrouped") return gs;
      const without = gs.filter((g: any) => g.id !== id);
      if (!beforeId) {
        const ungroupedIdx = without.findIndex((g: any) => g.id === "ungrouped");
        if (ungroupedIdx >= 0) return [...without.slice(0, ungroupedIdx), item, ...without.slice(ungroupedIdx)];
        return [...without, item];
      }
      const idx = without.findIndex((g: any) => g.id === beforeId);
      if (idx < 0) return [...without, item];
      return [...without.slice(0, idx), item, ...without.slice(idx)];
    });
  };

  const [hoverId, setHoverId] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const targetId = ctx.open ? ctx.convo?.id : hoverId;
      if (!targetId) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (k === "p") { togglePin(targetId); closeCtx(); }
      else if (k === "u") { patch(targetId, { unread: !convos.find((c: any) => c.id === targetId)?.unread }); closeCtx(); }
      else if (k === "r") { setRenaming(targetId); closeCtx(); }
      else if (k === "f") { duplicate(targetId); closeCtx(); }
      else if (k === "a") { archive(targetId); closeCtx(); }
      else if (k === "d" && e.shiftKey) { remove(targetId); closeCtx(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx.open, hoverId, convos]);

  const newConvo = () => {
    const id = "c-" + Date.now();
    const titles = ["New conversation", "Untitled chat", "Fresh thread", "amazing-grothendieck-" + Math.random().toString(36).slice(2, 8), "vibrant-noether-" + Math.random().toString(36).slice(2, 8)];
    const title = titles[Math.floor(Math.random() * titles.length)];
    setConvos(cs => [{ id, title, group: "ungrouped", status: "active", env: "dev", updated: Date.now(), unread: false }, ...cs]);
    setActiveId(id);
    setRenaming(id);
  };

  return (
    <aside className="side chat-side">
      <div className="side-head">
        <div className="side-title">Conversations</div>
        <button className="side-new" title="New conversation" onClick={newConvo}><Icon name="plus" size={11}/></button>
        <button
          className={"side-filter-btn" + (filtersOpen ? " on" : "")}
          onClick={() => setFiltersOpen(o => !o)}
          title="Filters & sort"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <line x1="6" y1="4"  x2="6"  y2="11"/>
            <line x1="6" y1="15" x2="6"  y2="20"/>
            <line x1="18" y1="4" x2="18" y2="9"/>
            <line x1="18" y1="13" x2="18" y2="20"/>
            <circle cx="6" cy="13" r="2"/><circle cx="18" cy="11" r="2"/>
          </svg>
        </button>
      </div>

      {filtersOpen && <FiltersPanel filters={filters} setFilters={setFilters} groups={groups} onClose={() => setFiltersOpen(false)}/>}

      <div className="side-list scroll">
        {groupsForRender.map((g: any) => {
          const isCustom = !g.pinnedSection && g.id !== "ungrouped" && groups.some((gg: any) => gg.id === g.id);
          return (
          <div key={g.id} className={"chat-group" + (g.pinnedSection ? " pinned" : "")}
            onDragOver={(e) => onDragOverGroup(e, g.id)}
            onDrop={(e) => {
              const groupDrag = e.dataTransfer.getData("text/group");
              if (groupDrag) {
                e.preventDefault();
                moveGroup(groupDrag, g.id);
                setDraggingId(null);
                return;
              }
              onDropGroup(e, g.id);
            }}
          >
            {g.label && (
              renamingGroup === g.id ? (
                <input
                  className="chat-row-rename"
                  style={{margin:"6px 12px"}}
                  defaultValue={g.label}
                  autoFocus
                  onKeyDown={(e: any) => {
                    if (e.key === "Enter") { renameGroup(g.id, e.target.value || g.label); setRenamingGroup(null); }
                    if (e.key === "Escape") setRenamingGroup(null);
                  }}
                  onBlur={(e: any) => { renameGroup(g.id, e.target.value || g.label); setRenamingGroup(null); }}
                />
              ) : (
                <div
                  className={"chat-group-label" + (dropTarget?.groupId === g.id ? " over" : "")}
                  onContextMenu={(e) => isCustom && openGroupCtx(e, g)}
                  onDoubleClick={() => isCustom && setRenamingGroup(g.id)}
                  draggable={isCustom}
                  onDragStart={(e) => { e.dataTransfer.setData("text/group", g.id); e.dataTransfer.effectAllowed = "move"; }}
                  title={isCustom ? "Right-click for options · double-click to rename · drag to reorder" : ""}
                >
                  <span>{g.pinnedSection && <Icon name="up" size={10}/>} {g.label}</span>
                  {isCustom && <span className="chat-group-count">{g.items.length}</span>}
                </div>
              )
            )}
            {g.items.length === 0 && (
              <div className="chat-group-empty">Drop a conversation here</div>
            )}
            {g.items.map((c: any) => (
              <ChatRow
                key={c.id}
                convo={c}
                active={c.id === activeId}
                renaming={renaming === c.id}
                onPick={() => setActiveId(c.id)}
                onCtx={(e: any) => openCtx(e, c)}
                onRename={(title: string) => { patch(c.id, { title, updated: Date.now() }); setRenaming(null); }}
                onCancelRename={() => setRenaming(null)}
                onDragStart={(e: any) => onDragStart(e, c.id)}
                onDragEnd={onDragEnd}
                dragging={draggingId === c.id}
                onHover={(v: boolean) => setHoverId(v ? c.id : (hoverId === c.id ? null : hoverId))}
              />
            ))}
          </div>
          );
        })}
        <button className="chat-new-group" onClick={() => setNewGroupOpen(true)}>
          <Icon name="plus" size={11}/> New group
        </button>
      </div>

      {ctx.open && (
        <ChatContextMenu
          x={ctx.x} y={ctx.y}
          submenu={ctx.submenu}
          setSubmenu={(s: any) => setCtx((c: any) => ({ ...c, submenu: s }))}
          convo={ctx.convo}
          groups={groups}
          onClose={closeCtx}
          onPin={() => { togglePin(ctx.convo.id); closeCtx(); }}
          onUnread={() => { patch(ctx.convo.id, { unread: !ctx.convo.unread }); closeCtx(); }}
          onRename={() => { setRenaming(ctx.convo.id); closeCtx(); }}
          onDuplicate={() => { duplicate(ctx.convo.id); closeCtx(); }}
          onMove={(gid: string) => {
            if (gid === "__new") setNewGroupOpen(true);
            else moveTo(ctx.convo.id, gid);
            closeCtx();
          }}
          onArchive={() => { archive(ctx.convo.id); closeCtx(); }}
          onUnarchive={() => { unarchive(ctx.convo.id); closeCtx(); }}
          onDelete={() => { remove(ctx.convo.id); closeCtx(); }}
        />
      )}

      {groupCtx.open && (
        <>
          <div style={{position:"fixed",inset:0,zIndex:9997}} onClick={closeGroupCtx} onContextMenu={(e) => { e.preventDefault(); closeGroupCtx(); }}/>
          <div className="chat-ctx" style={{ left: Math.min(groupCtx.x, window.innerWidth - 240), top: Math.min(groupCtx.y, window.innerHeight - 220), zIndex: 9999 }}>
            <div className="chat-ctx-target">Group · {groupCtx.group?.label}</div>
            <button className="chat-ctx-item" onClick={() => { setRenamingGroup(groupCtx.group.id); closeGroupCtx(); }}>
              <span className="label">Renommer le groupe</span><span className="kbd">R</span>
            </button>
            <button className="chat-ctx-item" onClick={closeGroupCtx}>
              <span className="label">Tout marquer comme lu</span>
            </button>
            <button className="chat-ctx-item" onClick={() => { setConvos(cs => cs.map((c: any) => c.group === groupCtx.group.id ? { ...c, status: "archived" } : c)); closeGroupCtx(); }}>
              <span className="label">Archiver toutes les conversations</span>
            </button>
            <div className="chat-ctx-sep"></div>
            <button className="chat-ctx-item danger" onClick={() => { deleteGroup(groupCtx.group.id); closeGroupCtx(); }}>
              <span className="label">Supprimer le groupe</span><span className="kbd">D</span>
            </button>
          </div>
        </>
      )}

      {newGroupOpen && (
        <NewGroupDialog
          onClose={() => setNewGroupOpen(false)}
          onAdd={(label: string) => {
            const id = addGroup(label);
            if (ctx.convo) moveTo(ctx.convo.id, id);
            setNewGroupOpen(false);
            closeCtx();
          }}
        />
      )}
    </aside>
  );
}

export function ChatRow({ convo, active, renaming, onPick, onCtx, onRename, onCancelRename, onDragStart, onDragEnd, dragging, onHover }: any) {
  const [val, setVal] = useState(convo.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { if (renaming) { setVal(convo.title); inputRef.current?.select(); } }, [renaming, convo.title]);

  return (
    <>
      <div
        className={"chat-row" + (active ? " active" : "") + (dragging ? " dragging" : "") + (convo.pinned ? " pinned" : "") + (convo.unread ? " unread" : "")}
        onClick={() => !renaming && onPick()}
        onContextMenu={onCtx}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <span className="chat-row-dot"></span>
        {renaming ? (
          <input
            ref={inputRef}
            className="chat-row-rename"
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") onRename(val);
              else if (e.key === "Escape") onCancelRename();
            }}
            onBlur={() => onRename(val)}
            autoFocus
          />
        ) : (
          <span className="chat-row-label">{convo.title}</span>
        )}
        {convo.pinned && !renaming && <Icon name="up" size={10} className="chat-row-pin"/>}
        {convo.children && <span className="chat-row-count">{convo.children.length}</span>}
      </div>
      {convo.children && convo.children.map((child: any) => (
        <div key={child.id} className={"chat-row child" + (child.id === active ? " active" : "")}
          onClick={onPick}
          onContextMenu={(e) => onCtx(e, child)}
        >
          <span className="chat-row-line"></span>
          <span className="chat-row-dot"></span>
          <span className="chat-row-label">{child.title}</span>
        </div>
      ))}
    </>
  );
}

export function FiltersPanel({ filters, setFilters, groups, onClose: _onClose }: any) {
  const Row = ({ label, value, options, onChange }: any) => {
    const [open, setOpen] = useState(false);
    const cur = options.find((o: any) => o.v === value);
    return (
      <div className="filter-row">
        <span className="l">{label}</span>
        <button className="v" onClick={() => setOpen(o => !o)}>
          {cur?.l || value} <Icon name="down" size={9}/>
        </button>
        {open && (
          <>
            <div style={{position:"fixed",inset:0,zIndex:9}} onClick={() => setOpen(false)}/>
            <div className="filter-pop">
              {options.map((o: any) => (
                <button key={o.v} className={"filter-pop-item" + (o.v === value ? " on" : "")} onClick={() => { onChange(o.v); setOpen(false); }}>
                  {o.l}
                  {o.v === value && <span style={{marginLeft:"auto", color:"var(--primary)"}}>✓</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    );
  };
  return (
    <div className="filters-panel">
      <Row label="Status" value={filters.status} onChange={(v: any) => setFilters((f: any) => ({...f, status: v}))} options={[
        { v: "active",   l: "Active" },
        { v: "archived", l: "Archived" },
        { v: "all",      l: "All" },
      ]}/>
      <Row label="Project" value={filters.project} onChange={(v: any) => setFilters((f: any) => ({...f, project: v}))} options={[
        { v: "all", l: "All" },
        ...groups.filter((g: any) => !g.pinnedSection).map((g: any) => ({ v: g.id, l: g.label })),
      ]}/>
      <Row label="Environment" value={filters.env} onChange={(v: any) => setFilters((f: any) => ({...f, env: v}))} options={[
        { v: "all",  l: "All" },
        { v: "dev",  l: "Dev" },
        { v: "prod", l: "Prod" },
      ]}/>
      <Row label="Last activity" value={filters.activity} onChange={(v: any) => setFilters((f: any) => ({...f, activity: v}))} options={[
        { v: "all", l: "All" },
        { v: "24h", l: "Last 24h" },
        { v: "7d",  l: "Last 7 days" },
        { v: "30d", l: "Last 30 days" },
      ]}/>
      <div className="filter-sep"></div>
      <Row label="Group by" value={filters.groupBy} onChange={(v: any) => setFilters((f: any) => ({...f, groupBy: v}))} options={[
        { v: "custom",   l: "Custom groups" },
        { v: "none",     l: "None (flat)" },
        { v: "env",      l: "Environment" },
        { v: "activity", l: "Last activity" },
      ]}/>
      <Row label="Sort by" value={filters.sortBy} onChange={(v: any) => setFilters((f: any) => ({...f, sortBy: v}))} options={[
        { v: "recency", l: "Recency" },
        { v: "name",    l: "Name" },
        { v: "unread",  l: "Unread" },
      ]}/>
    </div>
  );
}

export function ChatContextMenu({ x, y, submenu, setSubmenu, convo, groups, onClose, onPin, onUnread, onRename, onDuplicate, onMove, onArchive, onUnarchive, onDelete }: any) {
  const W = 240;
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - 360);

  return (
    <>
      <div style={{position:"fixed",inset:0,zIndex:9998}} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}/>
      <div className="chat-ctx" style={{ left, top }}>
        <div className="chat-ctx-target">{convo.title}</div>

        <button className="chat-ctx-item submenu" onMouseEnter={() => setSubmenu("open-in")}>
          <span className="label">Ouvrir dans</span>
          <span className="submark">›</span>
          {submenu === "open-in" && (
            <div className="chat-ctx chat-ctx-sub" onMouseLeave={() => setSubmenu(null)}>
              <button className="chat-ctx-item"><span className="label">Current tab</span></button>
              <button className="chat-ctx-item"><span className="label">New tab</span></button>
              <button className="chat-ctx-item"><span className="label">New window</span></button>
              <button className="chat-ctx-item"><span className="label">Float chat</span></button>
            </div>
          )}
        </button>

        <button className="chat-ctx-item" onClick={onPin}>
          <span className="label">{convo.pinned ? "Désépingler" : "Épingler"}</span>
          <span className="kbd">P</span>
        </button>
        <button className="chat-ctx-item" onClick={onUnread}>
          <span className="label">{convo.unread ? "Marquer comme lu" : "Marquer comme non lu"}</span>
          <span className="kbd">U</span>
        </button>
        <button className="chat-ctx-item" onClick={onRename}>
          <span className="label">Renommer</span>
          <span className="kbd">R</span>
        </button>
        <button className="chat-ctx-item" onClick={onDuplicate}>
          <span className="label">Dupliquer</span>
          <span className="kbd">F</span>
        </button>

        <button className="chat-ctx-item submenu" onMouseEnter={() => setSubmenu("move")}>
          <span className="label">Déplacer vers le groupe</span>
          <span className="submark">›</span>
          {submenu === "move" && (
            <div className="chat-ctx chat-ctx-sub" onMouseLeave={() => setSubmenu(null)}>
              {groups.filter((g: any) => !g.pinnedSection).map((g: any, i: number) => (
                <button key={g.id} className={"chat-ctx-item" + (convo.group === g.id ? " on" : "")} onClick={() => onMove(g.id)}>
                  <span className="label">{g.label}</span>
                  {convo.group === g.id ? <span className="kbd" style={{color:"var(--primary)"}}>✓</span> : <span className="kbd">{i + 1}</span>}
                </button>
              ))}
              <div className="chat-ctx-sep"></div>
              <button className="chat-ctx-item primary" onClick={() => onMove("__new")}>
                <span className="label">Nouveau groupe…</span>
                <span className="kbd">{groups.length}</span>
              </button>
            </div>
          )}
        </button>

        <div className="chat-ctx-sep"></div>
        <button className="chat-ctx-item" onClick={convo.status === "archived" ? onUnarchive : onArchive}>
          <span className="label">{convo.status === "archived" ? "Désarchiver" : "Archiver"}</span>
          <span className="kbd">A</span>
        </button>
        <button className="chat-ctx-item danger" onClick={onDelete}>
          <span className="label">Supprimer</span>
          <span className="kbd">D</span>
        </button>
      </div>
    </>
  );
}

export function NewGroupDialog({ onClose, onAdd }: any) {
  const [val, setVal] = useState("");
  return (
    <div className="palette-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" style={{width: 380, padding: 0}}>
        <div style={{padding:"14px 16px", borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
          <div style={{fontFamily:"var(--font-display)", fontWeight:700, fontSize:14}}>New group</div>
          <div style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:2}}>Organize conversations by project, topic, or context.</div>
        </div>
        <div style={{padding:16}}>
          <input
            autoFocus
            className="lgi"
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && val.trim()) onAdd(val.trim()); }}
            placeholder="e.g. Client Acme · Tauri build · Veil v2…"
          />
        </div>
        <div style={{padding:"10px 16px", borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", gap:8}}>
          <button className="lgb" onClick={onClose}>Cancel</button>
          <span style={{flex:1}}></span>
          <button className="lgb lgb-primary" disabled={!val.trim()} onClick={() => onAdd(val.trim())}>Create</button>
        </div>
      </div>
    </div>
  );
}
