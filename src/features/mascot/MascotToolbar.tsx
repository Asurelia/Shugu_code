// Shugu Forge — MascotToolbar : menu mascotte en cascade + éditeur de catégories.
//
// Menu (validé 2026-05-31) :
//   • BARRE-PILULE verticale d'ICÔNES de catégorie (façon « fenêtre de prompt »),
//     collée au côté du chibi (suit `side`).
//   • Sélectionner une catégorie DÉPLOIE ses cartes en rangée horizontale à côté.
//   • Cliquer une carte exécute l'action puis referme tout.
//
// Éditeur (étape « personnalisation ») :
//   • Renommer une catégorie, lui choisir une icône, en ajouter/supprimer.
//   • Glisser-déposer (DnD natif) une carte d'une catégorie à une autre.
//
// L'organisation (catégories : libellé, icône, items ordonnés) est persistée en
// localStorage — préférence d'UI locale à la fenêtre mascotte (même choix que
// calibration.ts) ; dérogation assumée à « TanStack par défaut ».
// `reconcileGroups` garantit qu'aucun item connu n'est perdu ni dupliqué.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/components";
import { CTX_TABS, type CtxTabId } from "@/features/context-cards/cards";
import type { FloatSide } from "@/features/floating/useFloatPosition";

// ─── Items ──────────────────────────────────────────────────────────────────
export type ToolbarItemId =
  | "chat" | "new" | "history" | "agents"
  | CtxTabId;

const NAV_ITEM_IDS: ToolbarItemId[] = ["chat", "new", "history", "agents"];
const CARD_ITEM_IDS: ToolbarItemId[] = CTX_TABS.map((t) => t.id);
const ALL_ITEM_IDS: ToolbarItemId[] = [...NAV_ITEM_IDS, ...CARD_ITEM_IDS];

const ITEM_LABEL: Record<ToolbarItemId, string> = {
  chat: "Chat", new: "Nouveau", history: "Historique", agents: "Agents",
  plan: "Plan", tasks: "Tâches", git: "Git", preview: "Prévisu", sources: "Sources", env: "Env",
};

function ItemIcon({ id }: { id: ToolbarItemId }) {
  switch (id) {
    case "chat":
      return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>);
    case "new":
      return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>);
    case "history":
      return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>);
    case "agents":
      return (<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="2" width="6" height="5" rx="1" /><rect x="2" y="17" width="6" height="5" rx="1" /><rect x="16" y="17" width="6" height="5" rx="1" /><path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" /></svg>);
    default: {
      const meta = CTX_TABS.find((t) => t.id === id);
      return meta ? <Icon name={meta.icon} size={14} /> : null;
    }
  }
}

// ─── Glyphes de catégorie (choisissables dans l'éditeur) ────────────────────
export const CATEGORY_ICON_KEYS = [
  "chat", "grid", "branch", "spark", "folder", "bolt", "heart", "star", "box",
] as const;

function CategoryGlyph({ icon, size = 15 }: { icon: string; size?: number }) {
  const p = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (icon) {
    case "chat":   return (<svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>);
    case "grid":   return (<svg {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>);
    case "branch": return (<svg {...p}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M8.4 7.2A6 6 0 0 0 18 10.5" /></svg>);
    case "spark":  return (<svg {...p}><path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" /></svg>);
    case "folder": return (<svg {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>);
    case "bolt":   return (<svg {...p}><polygon points="13 2 4 14 11 14 10 22 20 9 13 9" /></svg>);
    case "heart":  return (<svg {...p}><path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1L12 21l8.8-8.3a5 5 0 0 0 0-7.1z" /></svg>);
    case "star":   return (<svg {...p}><polygon points="12 2 15 9 22 9.3 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.3 9 9" /></svg>);
    case "box":
    default:       return (<svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /></svg>);
  }
}

// ─── Catégories (groupes) : modèle persisté ─────────────────────────────────
export interface ToolbarGroup {
  id: string;
  label: string;
  icon: string;       // clé dans CATEGORY_ICON_KEYS (repli "box" si inconnu)
  items: ToolbarItemId[];
}

const STORAGE_KEY = "shugu.mascot.toolbar.v1";

const DEFAULT_GROUPS: ToolbarGroup[] = [
  { id: "conv", label: "Conversation", icon: "chat", items: [...NAV_ITEM_IDS] },
  { id: "cards", label: "Cartes", icon: "grid", items: [...CARD_ITEM_IDS] },
];

function reconcileGroups(groups: ToolbarGroup[]): ToolbarGroup[] {
  const known = new Set<ToolbarItemId>(ALL_ITEM_IDS);
  const seen = new Set<ToolbarItemId>();
  const cleaned = groups
    .filter((g) => g && typeof g.id === "string" && Array.isArray(g.items))
    .map((g) => ({
      id: g.id,
      label: typeof g.label === "string" && g.label.trim() ? g.label : "Groupe",
      icon: typeof g.icon === "string" ? g.icon : "box",
      items: g.items.filter((id) => {
        if (!known.has(id) || seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    }));
  const missing = ALL_ITEM_IDS.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    const target = cleaned[cleaned.length - 1];
    if (target) target.items.push(...missing);
    else cleaned.push({ id: "misc", label: "Autres", icon: "box", items: missing });
  }
  return cleaned.length > 0 ? cleaned : DEFAULT_GROUPS;
}

function loadGroups(): ToolbarGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return reconcileGroups(parsed);
    }
  } catch { /* corrupted / unavailable → defaults */ }
  return DEFAULT_GROUPS;
}

function newGroupId(existing: ToolbarGroup[]): string {
  // Id stable sans collision (pas de Math.random) : incrémente jusqu'à libre.
  let n = existing.length + 1;
  while (existing.some((g) => g.id === "grp-" + n)) n++;
  return "grp-" + n;
}

// ─── Props ──────────────────────────────────────────────────────────────────
export interface MascotToolbarProps {
  open: boolean;
  onClose: () => void;
  side: FloatSide;
  activeTab: "feed" | "history" | "agents" | CtxTabId;
  onSelectTab: (tab: "feed" | "history" | "agents" | CtxTabId) => void;
  onNewConvo: () => void;
  msgsCount: number;
  historyCount: number;
  agentsCount: number;
  ctxCounts: Record<CtxTabId, number>;
}

export function MascotToolbar({
  open, onClose, side,
  activeTab, onSelectTab, onNewConvo,
  msgsCount, historyCount, agentsCount, ctxCounts,
}: MascotToolbarProps) {
  const [groups, setGroups] = useState<ToolbarGroup[]>(loadGroups);
  const [catId, setCatId] = useState<string | null>(null);   // catégorie déployée
  const [editing, setEditing] = useState(false);             // éditeur ouvert ?

  // Persiste à chaque mutation (rename / DnD / icône / add / remove).
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(groups)); } catch { /* quota */ }
  }, [groups]);

  // À l'ouverture du menu, on repart propre (rien déployé, pas en édition).
  useEffect(() => {
    if (open) { setCatId(null); setEditing(false); }
  }, [open]);

  if (!open) return null;

  // ── Actions d'item ─────────────────────────────────────────────────────────
  const itemState = (id: ToolbarItemId): { active: boolean; count: number; run: () => void } => {
    switch (id) {
      case "chat":    return { active: activeTab === "feed", count: msgsCount, run: () => onSelectTab("feed") };
      case "new":     return { active: false, count: 0, run: onNewConvo };
      case "history": return { active: activeTab === "history", count: historyCount, run: () => onSelectTab("history") };
      case "agents":  return { active: activeTab === "agents", count: agentsCount, run: () => onSelectTab("agents") };
      default:        return { active: activeTab === id, count: ctxCounts[id] ?? 0, run: () => onSelectTab(id) };
    }
  };
  const pick = (id: ToolbarItemId) => { itemState(id).run(); setCatId(null); onClose(); };

  // ── Mutations de catégories ─────────────────────────────────────────────────
  const renameGroup = (id: string, label: string) =>
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, label } : g)));
  const setGroupIcon = (id: string, icon: string) =>
    setGroups((gs) => gs.map((g) => (g.id === id ? { ...g, icon } : g)));
  const addGroup = () =>
    setGroups((gs) => [...gs, { id: newGroupId(gs), label: "Nouvelle", icon: "box", items: [] }]);
  const removeGroup = (id: string) =>
    setGroups((gs) => {
      if (gs.length <= 1) return gs;                 // garde au moins une catégorie
      const removed = gs.find((g) => g.id === id);
      const rest = gs.filter((g) => g.id !== id);
      if (removed && removed.items.length && rest[0]) {
        rest[0] = { ...rest[0], items: [...rest[0].items, ...removed.items] };
      }
      return rest;
    });
  const moveItem = (itemId: ToolbarItemId, fromId: string, toId: string) => {
    if (fromId === toId) return;
    setGroups((gs) => gs.map((g) => {
      if (g.id === fromId) return { ...g, items: g.items.filter((i) => i !== itemId) };
      if (g.id === toId && !g.items.includes(itemId)) return { ...g, items: [...g.items, itemId] };
      return g;
    }));
  };

  // ── Éditeur ─────────────────────────────────────────────────────────────────
  if (editing) {
    return (
      <div className={"mtb-menu side-" + side}>
        <button className="mtb-scrim" aria-label="Fermer l'éditeur" onClick={() => setEditing(false)} />
        <CategoryEditor
          groups={groups}
          onRename={renameGroup}
          onSetIcon={setGroupIcon}
          onAdd={addGroup}
          onRemove={removeGroup}
          onMoveItem={moveItem}
          onDone={() => setEditing(false)}
        />
      </div>
    );
  }

  // ── Menu en cascade ──────────────────────────────────────────────────────────
  return (
    <div className={"mtb-menu side-" + side}>
      <button className="mtb-scrim" aria-label="Fermer le menu" onClick={onClose} />

      <div className="mtb-cat-bar" role="menu" aria-label="Catégories">
        {groups.map((g) => {
          const deployed = catId === g.id;
          return (
            <div key={g.id} className="mtb-cat-slot">
              <button
                type="button"
                className={"mtb-cat-icon" + (deployed ? " on" : "")}
                title={g.label}
                aria-label={g.label}
                aria-expanded={deployed}
                onClick={() => setCatId(deployed ? null : g.id)}
              >
                <CategoryGlyph icon={g.icon} />
              </button>

              {deployed && (
                <div className="mtb-flyout" role="menu" aria-label={g.label}>
                  {g.items.length === 0 ? (
                    <span className="mtb-flyout-empty">vide</span>
                  ) : (
                    g.items.map((id) => {
                      const st = itemState(id);
                      return (
                        <button
                          key={id}
                          role="menuitem"
                          className={"mtb-item" + (st.active ? " on" : "")}
                          title={ITEM_LABEL[id]}
                          onClick={() => pick(id)}
                        >
                          <ItemIcon id={id} />
                          {st.count > 0 && <span className="mtb-item-count">{st.count}</span>}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Bouton ÉDITER les catégories (organiser / renommer / icône / DnD). */}
        <button
          type="button"
          className="mtb-cat-icon mtb-edit-toggle"
          title="Organiser les catégories"
          aria-label="Organiser les catégories"
          onClick={() => { setCatId(null); setEditing(true); }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Éditeur de catégories (rename / icône / add / remove / DnD) ─────────────
interface CategoryEditorProps {
  groups: ToolbarGroup[];
  onRename: (id: string, label: string) => void;
  onSetIcon: (id: string, icon: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onMoveItem: (itemId: ToolbarItemId, fromId: string, toId: string) => void;
  onDone: () => void;
}

function CategoryEditor({ groups, onRename, onSetIcon, onAdd, onRemove, onMoveItem, onDone }: CategoryEditorProps) {
  // Item en cours de glissement (dataTransfer peu fiable → ref).
  const drag = useRef<{ id: ToolbarItemId; from: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [iconPickerFor, setIconPickerFor] = useState<string | null>(null);

  return (
    <div className="mtb-editor" role="dialog" aria-label="Organiser les catégories">
      <div className="mtb-editor-head">
        <span className="mtb-editor-title">Catégories</span>
        <span className="mtb-editor-actions">
          <button className="mtb-editor-btn" title="Ajouter une catégorie" onClick={onAdd}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
          </button>
          <button className="mtb-editor-btn done" title="Terminé" onClick={onDone}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
          </button>
        </span>
      </div>

      <div className="mtb-editor-list">
        {groups.map((g) => (
          <div
            key={g.id}
            className={"mtb-edit-group" + (dropTarget === g.id ? " drop" : "")}
            onDragOver={(e) => { if (drag.current) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; } }}
            onDragEnter={() => { if (drag.current) setDropTarget(g.id); }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget((t) => (t === g.id ? null : t)); }}
            onDrop={() => {
              const d = drag.current;
              if (d) onMoveItem(d.id, d.from, g.id);
              drag.current = null;
              setDropTarget(null);
            }}
          >
            <div className="mtb-edit-head">
              <button className="mtb-edit-icon" title="Changer l'icône" onClick={() => setIconPickerFor((c) => (c === g.id ? null : g.id))}>
                <CategoryGlyph icon={g.icon} size={14} />
              </button>
              <input
                className="mtb-edit-name"
                value={g.label}
                onChange={(e) => onRename(g.id, e.target.value)}
                placeholder="Nom de la catégorie"
                aria-label="Nom de la catégorie"
              />
              <button
                className="mtb-edit-del"
                title={groups.length <= 1 ? "Au moins une catégorie requise" : "Supprimer la catégorie"}
                disabled={groups.length <= 1}
                onClick={() => onRemove(g.id)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></svg>
              </button>
            </div>

            {iconPickerFor === g.id && (
              <div className="mtb-icon-picker">
                {CATEGORY_ICON_KEYS.map((k) => (
                  <button
                    key={k}
                    className={"mtb-icon-opt" + (g.icon === k ? " on" : "")}
                    title={k}
                    onClick={() => { onSetIcon(g.id, k); setIconPickerFor(null); }}
                  >
                    <CategoryGlyph icon={k} size={14} />
                  </button>
                ))}
              </div>
            )}

            <div className="mtb-edit-chips">
              {g.items.length === 0 ? (
                <span className="mtb-edit-empty">Glisse des cartes ici</span>
              ) : (
                g.items.map((id) => (
                  <span
                    key={id}
                    className="mtb-chip"
                    draggable
                    onDragStart={(e) => { drag.current = { id, from: g.id }; e.dataTransfer.effectAllowed = "move"; }}
                    onDragEnd={() => { drag.current = null; setDropTarget(null); }}
                    title={"Glisser « " + ITEM_LABEL[id] + " » vers une autre catégorie"}
                  >
                    <ItemIcon id={id} />
                    <span className="mtb-chip-label">{ITEM_LABEL[id]}</span>
                  </span>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
