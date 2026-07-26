// Shugu Forge — rich chat sidebar with groups, drag, context menu, filters.
// Ported from chat-sidebar.jsx.

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/components";
import { db, convoToRow, ensureInitialConversation } from "@/lib/db";
import { vecSearch } from "@/lib/vector";
import { fsSetWorkspaceRoot } from "@/lib/fs";
import {
  useCurrentProject,
  useProjects,
  useProjectCounts,
} from "@/features/projects/projectsQueries";
import { ProjectSwitcher, type ProjectViewMode } from "@/features/projects/ProjectSwitcher";
import { projectKeys } from "@/features/projects/keys";
import { useModalFocusTrap } from "@/lib/modalFocus";
import {
  findConversation,
  flattenConversations,
  groupConversationsByActivity,
  nextUnreadConversationId,
  patchConversationTree,
  removeConversationTree,
} from "./chatSidebarModel";

export const DEFAULT_GROUPS = [
  { id: "pinned", label: "Épinglées", pinnedSection: true },
  { id: "ungrouped", label: "Conversations" },
];

export const FMT_RELATIVE = (ts: number) => {
  const d = Math.max(0, (Date.now() - ts) / 1000);
  if (d < 60)        return Math.floor(d) + "s";
  if (d < 3600)      return Math.floor(d / 60) + "m";
  if (d < 86400)     return Math.floor(d / 3600) + "h";
  if (d < 7 * 86400) return Math.floor(d / 86400) + "d";
  return new Date(ts).toLocaleDateString();
};

// ─────────────────────────────────────────────────────────────────────────
// Module-level cache of the last hydrated groups/convos.
//
// WHY: collapsing the left panel makes SidePanel return null (components.tsx),
// which UNMOUNTS ChatSidebar entirely. Reopening REMOUNTS it from scratch.
// The cache survives the unmount/remount cycle so a reopen paints the real
// last-known SQLite list instantly instead of flashing an empty panel.
//
// It is per-window (each webview has its own module instance) and is refreshed
// from SQLite — the source of truth — by the hydrate effect on every mount.
// ─────────────────────────────────────────────────────────────────────────
let convosCache: any[] | null = null;
let groupsCache: any[] | null = null;

export function ChatSidebar({ activeId, setActiveId, onActiveTitle }: any) {
  // Initial state comes from the module cache (real data, survives remounts).
  // On a genuine cold start the cache is empty and the hydrate effect fills the
  // conversation list from SQLite. Group labels are presentation-only.
  const [groups, setGroups]   = useState<any[]>(() => groupsCache ?? DEFAULT_GROUPS);
  const [convos, setConvos]   = useState<any[]>(() => convosCache ?? []);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ─── Project scope (V18) ─────────────────────────────────────────────
  // A project = the opened folder. The sidebar shows one scope at a time:
  //   "project" → the current folder's conversations (default)
  //   "all"     → every conversation, all projects
  //   "global"  → conversations with no project (incl. pre-V18 history)
  const queryClient = useQueryClient();
  const { data: currentProject } = useCurrentProject();
  const { data: projectList = [] } = useProjects();
  const { data: projectCounts = {} } = useProjectCounts();
  const [viewMode, setViewMode] = useState<ProjectViewMode>("project");
  const scope =
    viewMode === "all" ? undefined
    : viewMode === "global" ? null
    : (currentProject?.id ?? null);

  // ─────────────────────────────────────────────────────────────────
  // NOT TanStack because:
  //   1. searchQuery is ephemeral local UI state (input value for a single
  //      component), not shared across windows or routes.
  //   2. searchOpen toggles the vector-search bar (loupe in the header) —
  //      purely local presentation state.
  // SI un jour searchQuery doit être synced cross-window ou persisted,
  // on basculerait vers une synthetic query + setQueryData pattern.
  // ─────────────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [filters, setFilters] = useState({
    status: "active",
    project: "all",
    env: "all",
    activity: "all",
    groupBy: "activity",
    sortBy: "recency",
  });
  const [ctx, setCtx]         = useState<any>({ open: false, x: 0, y: 0, convo: null, submenu: null });
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<any>(null);
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const patch = useCallback(
    (id: string, values: any) =>
      setConvos((current) =>
        patchConversationTree(current, id, {
          ...values,
          updated:
            values.updated ??
            findConversation(current, id)?.updated ??
            Date.now(),
        }),
      ),
    [],
  );

  const activateConversation = useCallback(
    (id: string) => {
      const conversation = findConversation(convos, id);
      if (conversation?.unread) {
        patch(id, { unread: false });
        void db.conversations.setUnread(id, false);
      }
      setActiveId(id);
    },
    [convos, patch, setActiveId],
  );

  useEffect(() => {
    if (!onActiveTitle) return;
    const c = findConversation(convos, activeId);
    onActiveTitle(c?.title || null);
  }, [activeId, convos, onActiveTitle]);

  // Active conversation changes can originate from the unified palette or
  // from the mascot window. Opening is authoritative: it clears unread in the
  // sidebar and SQLite even when the click did not originate here.
  useEffect(() => {
    const active = findConversation(convos, activeId);
    if (!active?.unread) return;
    patch(activeId, { unread: false });
    void db.conversations.setUnread(activeId, false);
  }, [activeId, convos, patch]);

  // Keep the module cache in sync with the live state so the next remount
  // (panel reopen) starts from the real data, not a stale snapshot.
  useEffect(() => { convosCache = convos; }, [convos]);
  useEffect(() => { groupsCache = groups; }, [groups]);

  // Hydrate from SQLite on mount.
  // listNested() reconstructs the parent→children tree from parent_id so that
  // sub-conversations (e.g. c6a/c6b under c6) are properly nested instead of
  // appearing as flat top-level rows after a SQLite round-trip.
  //
  // We always apply the result (no `length > 0` guard): SQLite is the source of
  // truth, so an empty list MUST be honoured — otherwise deleting every
  // conversation would leave the stale in-memory list on screen. A fresh DB
  // receives exactly one honest empty conversation, never a demo transcript.
  // Reset to the current-project view whenever the open folder changes, so
  // opening a project surfaces its conversations (not a stale "all"/"global").
  const prevProjectId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = currentProject?.id ?? null;
    if (prevProjectId.current !== undefined && prevProjectId.current !== id) {
      setViewMode("project");
    }
    prevProjectId.current = id;
  }, [currentProject?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensureInitialConversation();
      const nested = await db.conversations.listNested(scope);
      if (!cancelled) {
        setConvos(nested);
      }
    })();
    return () => { cancelled = true; };
  }, [scope]);

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

  // VEC2 — TanStack vector search over message embeddings (fastembed
  // AllMiniLM-L6-v2, see src-tauri/src/commands/vector.rs). Driven entirely by
  // the searchQuery key — staleTime Infinity, no background refetch.
  const trimmedQuery = searchQuery.trim();
  const SEARCH_K = 12;
  const { data: semanticHits = [] } = useQuery<{ convId: string }[]>({
    queryKey: ["chat-sidebar", "semantic-search", trimmedQuery],
    queryFn: async () => {
      if (!trimmedQuery) return [];
      const hits = await vecSearch("messages", trimmedQuery, SEARCH_K);
      const results: { convId: string }[] = [];
      for (const hit of hits) {
        const row = await db.messages.get(hit.id);
        if (row?.conversation_id) results.push({ convId: row.conversation_id });
      }
      return results;
    },
    enabled: searchOpen && trimmedQuery.length > 0,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  // Build a set of convId matches from semantic hits for fast lookup.
  const semanticConvIds = useMemo(
    () => new Set(semanticHits.map((h) => h.convId)),
    [semanticHits],
  );

  // Conversation set after applying the active search: a title text match OR a
  // semantic (vector) hit on the conversation's messages. Empty query → the
  // unfiltered `visible` list. Single source of truth for both the grouped
  // render and the result-count hint.
  const searchedSource = useMemo(() => {
    if (!searchOpen || !trimmedQuery) return visible;
    const q = trimmedQuery.toLowerCase();
    return visible.filter(
      (c: any) => c.title?.toLowerCase().includes(q) || semanticConvIds.has(c.id),
    );
  }, [visible, searchOpen, trimmedQuery, semanticConvIds]);

  const unreadCount = useMemo(
    () =>
      flattenConversations(searchedSource).filter(
        (conversation: any) => conversation.unread,
      ).length,
    [searchedSource],
  );

  const navigateUnread = useCallback(
    (direction: 1 | -1) => {
      const id = nextUnreadConversationId(
        searchedSource,
        activeId,
        direction,
      );
      if (id) activateConversation(id);
    },
    [activateConversation, activeId, searchedSource],
  );

  const groupsForRender = useMemo(() => {
    // searchedSource already applied the active search (or is `visible` when
    // the search bar is closed / empty).
    const source = searchedSource;

    if (filters.groupBy === "none") return [{ id: "_all", label: null, items: source } as any];
    if (filters.groupBy === "env") {
      const m = new Map<string, any[]>();
      source.forEach((c: any) => {
        const k = c.env || "—";
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(c);
      });
      return [...m.entries()].map(([k, items]) => ({ id: k, label: k.toUpperCase(), items }));
    }
    if (filters.groupBy === "activity") {
      return groupConversationsByActivity(source);
    }
    return groups.map((g: any) => ({
      id: g.id, label: g.label, pinnedSection: g.pinnedSection,
      items: source.filter((c: any) => g.pinnedSection ? c.pinned : (!c.pinned && c.group === g.id))
    })).filter((g: any) => g.items.length || !g.pinnedSection);
  }, [searchedSource, filters.groupBy, groups]);

  const remove = (id: string) => {
    setConvos((current) => removeConversationTree(current, id));
    void db.conversations.remove(id);
  };
  const togglePin = useCallback((id: string) => {
    const cur = findConversation(convos, id);
    const next = !cur?.pinned;
    patch(id, { pinned: next });
    void db.conversations.setPinned(id, next);
  }, [convos, patch]);
  const archive = useCallback((id: string) => {
    patch(id, { status: "archived" });
    void db.conversations.setArchived(id, true);
  }, [patch]);
  const unarchive = (id: string) => {
    patch(id, { status: "active" });
    void db.conversations.setArchived(id, false);
  };
  const duplicate = useCallback((id: string) => {
    const c = findConversation(convos, id);
    if (!c) return;
    const newConvoData = { ...c, id: c.id + "-copy-" + Date.now(), title: c.title + " (copy)", updated: Date.now() };
    setConvos(cs => [newConvoData, ...cs]);
    void db.conversations.create(convoToRow(newConvoData));
    void queryClient.invalidateQueries({ queryKey: projectKeys.counts() });
  }, [convos, queryClient]);
  // Sidebar groups are in-session organizers only (V18: decoupled from the
  // persisted project scope) — this no longer writes to the DB.
  const moveTo   = (id: string, groupId: string) => {
    patch(id, { group: groupId, updated: Date.now() });
  };
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
  const markGroupRead = (groupId: string) => {
    const ids = flattenConversations(
      convos.filter((conversation: any) => conversation.group === groupId),
    )
      .filter((conversation: any) => conversation.unread)
      .map((conversation: any) => conversation.id);
    if (ids.length === 0) {
      closeGroupCtx();
      return;
    }
    setConvos((current) =>
      ids.reduce(
        (next, id) => patchConversationTree(next, id, { unread: false }),
        current,
      ),
    );
    ids.forEach((id) => void db.conversations.setUnread(id, false));
    closeGroupCtx();
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
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable ||
        target?.getAttribute("role") === "textbox"
      ) {
        return;
      }
      if (
        e.altKey &&
        e.shiftKey &&
        (e.key === "ArrowDown" || e.key === "ArrowUp")
      ) {
        e.preventDefault();
        navigateUnread(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      const targetId = ctx.open ? ctx.convo?.id : hoverId;
      if (!targetId) return;
      const k = e.key.toLowerCase();
      if (k === "p") { togglePin(targetId); closeCtx(); }
      else if (k === "u") { const cur2 = findConversation(convos, targetId); const nu = !cur2?.unread; patch(targetId, { unread: nu }); void db.conversations.setUnread(targetId, nu); closeCtx(); }
      else if (k === "r") { setRenaming(targetId); closeCtx(); }
      else if (k === "f") { duplicate(targetId); closeCtx(); }
      else if (k === "a") { archive(targetId); closeCtx(); }
      else if (k === "d" && e.shiftKey) { remove(targetId); closeCtx(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx.open, ctx.convo?.id, hoverId, convos, patch, togglePin, duplicate, archive, navigateUnread]);

  const newConvo = () => {
    const id = "c-" + Date.now();
    const title = "Nouvelle conversation";
    // Stamp the new conversation with the current project (open folder), and
    // snap the view to it so the fresh conversation is visible.
    const projectId = currentProject?.id ?? null;
    const newConvoData = { id, title, project_id: projectId, group: "ungrouped", status: "active" as const, env: "dev", updated: Date.now(), unread: false };
    setViewMode("project");
    setConvos(cs => [newConvoData, ...cs]);
    void db.conversations.create(convoToRow(newConvoData));
    void queryClient.invalidateQueries({ queryKey: projectKeys.counts() });
    setActiveId(id);
    setRenaming(id);
  };

  const customGrouping = filters.groupBy === "custom";

  return (
    <aside className="side chat-side">
      <div className="side-head">
        <div className="side-title">Conversations</div>
        {unreadCount > 0 && (
          <button
            className="side-unread-nav"
            onClick={() => navigateUnread(1)}
            title="Conversation non lue suivante (Alt+Shift+↓ · précédente ↑)"
            aria-label={`${unreadCount} conversation${unreadCount > 1 ? "s" : ""} non lue${unreadCount > 1 ? "s" : ""}. Ouvrir la suivante`}
          >
            <span className="dot" aria-hidden="true" />
            <span>{unreadCount}</span>
          </button>
        )}
        <button
          className={"side-filter-btn" + (searchOpen ? " on" : "")}
          onClick={() => { setSearchOpen(o => !o); setTimeout(() => searchInputRef.current?.focus(), 60); }}
          title="Recherche vectorielle"
        >
          <Icon name="search" size={12}/>
        </button>
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

      {/* VEC2 — vector search bar, revealed by the header loupe. Real semantic
          search over message embeddings; the meta-row shows the actual model
          and top-k (no mock values). Esc clears + closes. */}
      {searchOpen && (
        <div className="side-search">
          <div className="side-search-row">
            <span className="ico"><Icon name="sparkle" size={11}/></span>
            <input
              ref={searchInputRef}
              type="text"
              className="side-search-input"
              placeholder="Recherche sémantique…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { setSearchQuery(""); setSearchOpen(false); } }}
              aria-label="Recherche sémantique des conversations"
            />
            {searchQuery && (
              <button className="side-search-clear" title="Effacer" onClick={() => setSearchQuery("")}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            )}
          </div>
          <div className="side-search-meta">
            <span className="chip-mode">vector</span>
            <span className="chip-mode subtle">all-MiniLM-L6</span>
            <span style={{ flex: 1 }} />
            <span className="hint">{trimmedQuery ? `${searchedSource.length} résultat${searchedSource.length > 1 ? "s" : ""}` : `top-k ${SEARCH_K}`}</span>
          </div>
        </div>
      )}

      {filtersOpen && <FiltersPanel filters={filters} setFilters={setFilters} groups={groups} onClose={() => setFiltersOpen(false)}/>}

      <ProjectSwitcher
        projects={projectList}
        counts={projectCounts}
        currentProjectId={currentProject?.id ?? null}
        viewMode={viewMode}
        onOpenProject={async (root) => {
          setViewMode("project");
          try {
            await fsSetWorkspaceRoot(root);
          } catch (e) {
            console.warn("[projects] open folder failed (stale path?):", e);
          }
        }}
        onSetMode={setViewMode}
      />

      {/* Action primaire de la vue, en pleine largeur (pattern Codex/Claude
          Desktop « New chat ») — remplace le micro-« + » du header, trop
          discret pour LE geste le plus fréquent. */}
      <button className="chat-new-cta" onClick={newConvo}>
        <Icon name="plus" size={12}/> Nouvelle conversation
      </button>

      <div className="side-list scroll">
        {groupsForRender.map((g: any) => {
          const isCustom = !g.pinnedSection && g.id !== "ungrouped" && groups.some((gg: any) => gg.id === g.id);
          return (
          <div key={g.id} className={"chat-group" + (g.pinnedSection ? " pinned" : "")}
            onDragOver={(e) => {
              if (customGrouping) onDragOverGroup(e, g.id);
            }}
            onDrop={(e) => {
              if (!customGrouping) return;
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
                  {!isCustom && g.unreadCount > 0 && (
                    <span className="chat-group-unread" title={`${g.unreadCount} non lue${g.unreadCount > 1 ? "s" : ""}`}>
                      {g.unreadCount}
                    </span>
                  )}
                </div>
              )
            )}
            {/* Zone de drop visible SEULEMENT pendant un drag — affichée en
                permanence, elle encombrait la sidebar de placeholders
                (3 groupes vides = 3 « Drop a conversation here »). */}
            {g.items.length === 0 && draggingId && (
              <div className="chat-group-empty">Déposer la conversation ici</div>
            )}
            {g.items.map((c: any) => (
              <ChatRow
                key={c.id}
                convo={c}
                activeId={activeId}
                renamingId={renaming}
                onPick={activateConversation}
                onCtx={openCtx}
                onRename={(id: string, title: string) => { patch(id, { title, updated: Date.now() }); void db.conversations.rename(id, title); setRenaming(null); }}
                onCancelRename={() => setRenaming(null)}
                onDragStart={(e: any) => onDragStart(e, c.id)}
                onDragEnd={onDragEnd}
                dragging={draggingId === c.id}
                dragEnabled={customGrouping}
                onHover={setHoverId}
              />
            ))}
          </div>
          );
        })}
        <button
          className="chat-new-group"
          onClick={() => {
            setFilters((current: any) => ({ ...current, groupBy: "custom" }));
            setNewGroupOpen(true);
          }}
        >
          <Icon name="plus" size={11}/> Nouveau groupe
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
          onActivate={(id: string) => { activateConversation(id); closeCtx(); }}
          onPin={() => { togglePin(ctx.convo.id); closeCtx(); }}
          onUnread={() => { const nu = !ctx.convo.unread; patch(ctx.convo.id, { unread: nu }); void db.conversations.setUnread(ctx.convo.id, nu); closeCtx(); }}
          onRename={() => { setRenaming(ctx.convo.id); closeCtx(); }}
          onDuplicate={() => { duplicate(ctx.convo.id); closeCtx(); }}
          onMove={(gid: string) => {
            setFilters((current: any) => ({ ...current, groupBy: "custom" }));
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
            <button className="chat-ctx-item" onClick={() => markGroupRead(groupCtx.group.id)}>
              <span className="label">Tout marquer comme lu</span>
            </button>
            <button className="chat-ctx-item" onClick={() => { setConvos(cs => cs.map((c: any) => { if (c.group === groupCtx.group.id) { void db.conversations.setArchived(c.id, true); return { ...c, status: "archived" }; } return c; })); closeGroupCtx(); }}>
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

export function ChatRow({
  convo,
  activeId,
  renamingId,
  onPick,
  onCtx,
  onRename,
  onCancelRename,
  onDragStart,
  onDragEnd,
  dragging,
  dragEnabled = true,
  onHover,
  child = false,
}: any) {
  const [val, setVal] = useState(convo.title);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const active = convo.id === activeId;
  const renaming = convo.id === renamingId;
  const updatedAt = Number.isFinite(convo.updated)
    ? new Date(convo.updated)
    : null;
  useEffect(() => { if (renaming) { setVal(convo.title); inputRef.current?.select(); } }, [renaming, convo.title]);

  return (
    <>
      <div
        className={"chat-row" + (child ? " child" : "") + (active ? " active" : "") + (dragging ? " dragging" : "") + (convo.pinned ? " pinned" : "") + (convo.unread ? " unread" : "")}
        onClick={() => !renaming && onPick(convo.id)}
        onContextMenu={(event) => onCtx(event, convo)}
        onMouseEnter={() => onHover(convo.id)}
        onMouseLeave={() => onHover(null)}
        draggable={!child && dragEnabled && !renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {child && <span className="chat-row-line"></span>}
        <span className="chat-row-dot"></span>
        {renaming ? (
          <input
            ref={inputRef}
            className="chat-row-rename"
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") onRename(convo.id, val);
              else if (e.key === "Escape") onCancelRename();
            }}
            onBlur={() => onRename(convo.id, val)}
            autoFocus
          />
        ) : (
          <span className="chat-row-label">{convo.title}</span>
        )}
        {updatedAt && !renaming && (
          <time
            className="chat-row-time"
            dateTime={updatedAt.toISOString()}
            title={updatedAt.toLocaleString("fr-FR")}
          >
            {FMT_RELATIVE(convo.updated)}
          </time>
        )}
        {convo.pinned && !renaming && <Icon name="up" size={10} className="chat-row-pin"/>}
        {convo.children?.length > 0 && <span className="chat-row-count">{convo.children.length}</span>}
      </div>
      {convo.children?.map((nested: any) => (
        <ChatRow
          key={nested.id}
          convo={nested}
          activeId={activeId}
          renamingId={renamingId}
          onPick={onPick}
          onCtx={onCtx}
          onRename={onRename}
          onCancelRename={onCancelRename}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          dragging={false}
          dragEnabled={false}
          onHover={onHover}
          child
        />
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

export function ChatContextMenu({ x, y, submenu, setSubmenu, convo, groups, onClose, onActivate, onPin, onUnread, onRename, onDuplicate, onMove, onArchive, onUnarchive, onDelete }: any) {
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
              <button
                className="chat-ctx-item"
                onClick={() => onActivate(convo.id)}
              >
                <span className="label">Current tab</span>
              </button>
              <button
                className="chat-ctx-item"
                disabled
                title="bientôt"
                style={{ opacity: 0.45, cursor: "not-allowed" }}
              >
                <span className="label">New tab</span>
              </button>
              <button
                className="chat-ctx-item"
                disabled
                title="bientôt"
                style={{ opacity: 0.45, cursor: "not-allowed" }}
              >
                <span className="label">New window</span>
              </button>
              <button
                className="chat-ctx-item"
                onClick={async () => {
                  // Reveal the mascot window and focus it so the conversation
                  // can be picked up in the floating chat. Best-effort: if the
                  // mascot label doesn't exist (e.g. the window was closed),
                  // we just close the menu.
                  try {
                    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                    const mascot = await WebviewWindow.getByLabel("mascot");
                    if (mascot) {
                      await mascot.show();
                      await mascot.unminimize();
                      await mascot.setFocus();
                    }
                  } catch (err) {
                    console.warn("[ChatContextMenu] float chat reveal failed:", err);
                  }
                  onClose();
                }}
              >
                <span className="label">Float chat</span>
              </button>
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
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useModalFocusTrap({ open: true, containerRef: dialogRef, initialFocusRef: inputRef, onEscape: onClose });
  return (
    <div className="palette-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Créer un groupe de conversations"
        tabIndex={-1}
        style={{width: 380, padding: 0}}
      >
        <div style={{padding:"14px 16px", borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
          <div style={{fontFamily:"var(--font-display)", fontWeight:700, fontSize:14}}>Nouveau groupe</div>
          <div style={{fontSize:12, color:"var(--on-surface-variant)", marginTop:2}}>Organise les conversations par projet, sujet ou contexte.</div>
        </div>
        <div style={{padding:16}}>
          <input
            ref={inputRef}
            className="lgi"
            name="group-name"
            autoComplete="off"
            aria-label="Nom du groupe"
            value={val}
            onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && val.trim()) onAdd(val.trim()); }}
            placeholder="Ex. Client Acme · Build Tauri · Veil v2…"
          />
        </div>
        <div style={{padding:"10px 16px", borderTop:"1px solid rgba(255,255,255,0.05)", display:"flex", gap:8}}>
          <button className="lgb" onClick={onClose}>Annuler</button>
          <span style={{flex:1}}></span>
          <button className="lgb lgb-primary" disabled={!val.trim()} onClick={() => onAdd(val.trim())}>Créer</button>
        </div>
      </div>
    </div>
  );
}
