// Shugu Forge — MascotToolbar : menu de la mascotte (colonne + déploiement).
//
// Mécanique validée (2026-05-31), d'après le croquis annoté de l'utilisateur :
//   • COLONNE VERTICALE des catégories, collée au chibi (côté mascotte) — le
//     « blanc » du croquis. Apparaît quand on ouvre le menu (bouton du composer).
//   • Sélectionner une catégorie DÉPLOIE ses cartes en RANGÉE HORIZONTALE (la
//     « bulle en longueur ») à côté, à la hauteur de cette catégorie, qui
//     s'étend vers le chat (à l'opposé du chibi) — le « rouge / bleu ».
//   • Cliquer une carte exécute l'action puis TOUT se referme : il reste la
//     carte + la barre de prompt.
//
// Bulles façon « fenêtre de prompt », ancrées DU CÔTÉ de la mascotte (suivent
// `side`). Composant contrôlé : `open` + `onClose` pilotés par ChatPanel.
//
// Le modèle de GROUPES (catégories nommées, items ordonnés) est persisté en
// localStorage — préférence d'UI locale à la fenêtre mascotte (même choix que
// calibration.ts) ; dérogation assumée à « TanStack par défaut ». Déjà prêt
// pour l'étape suivante (drag-and-drop entre catégories + renommage).

import { useEffect, useState } from "react";
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
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "new":
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      );
    case "history":
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
        </svg>
      );
    case "agents":
      return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="2" width="6" height="5" rx="1" />
          <rect x="2" y="17" width="6" height="5" rx="1" />
          <rect x="16" y="17" width="6" height="5" rx="1" />
          <path d="M12 7v4M5 17v-2a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2" />
        </svg>
      );
    default: {
      const meta = CTX_TABS.find((t) => t.id === id);
      return meta ? <Icon name={meta.icon} size={14} /> : null;
    }
  }
}

// Icône d'une CATÉGORIE (la colonne verticale ne montre QUE des icônes, le
// libellé passe en tooltip). Icônes par défaut pour les catégories d'origine ;
// repli générique (carré) pour toute catégorie future / renommée.
function CategoryIcon({ groupId }: { groupId: string }) {
  switch (groupId) {
    case "conv":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "cards":
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    default:
      return (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="3" />
        </svg>
      );
  }
}

// ─── Catégories (groupes) : modèle persisté ─────────────────────────────────
export interface ToolbarGroup {
  id: string;
  label: string;
  items: ToolbarItemId[];
}

const STORAGE_KEY = "shugu.mascot.toolbar.v1";

const DEFAULT_GROUPS: ToolbarGroup[] = [
  { id: "conv", label: "Conversation", items: [...NAV_ITEM_IDS] },
  { id: "cards", label: "Cartes", items: [...CARD_ITEM_IDS] },
];

// Garantit que chaque item connu apparaît exactement une fois (les nouveaux
// items — futures fonctionnalités — atterrissent dans la dernière catégorie,
// jamais perdus). Retire inconnus + doublons.
function reconcileGroups(groups: ToolbarGroup[]): ToolbarGroup[] {
  const known = new Set<ToolbarItemId>(ALL_ITEM_IDS);
  const seen = new Set<ToolbarItemId>();
  const cleaned = groups
    .filter((g) => g && typeof g.id === "string" && Array.isArray(g.items))
    .map((g) => ({
      id: g.id,
      label: typeof g.label === "string" && g.label.trim() ? g.label : "Groupe",
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
    else cleaned.push({ id: "misc", label: "Autres", items: missing });
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
  } catch {
    /* corrupted / unavailable → defaults */
  }
  return DEFAULT_GROUPS;
}

// ─── Props ──────────────────────────────────────────────────────────────────
export interface MascotToolbarProps {
  /** Le menu est-il ouvert ? (piloté par le bouton-menu du composer.) */
  open: boolean;
  /** Referme le menu (sélection ou clic extérieur). */
  onClose: () => void;
  /** Côté du chibi — ancre la colonne du bon côté. */
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
  open,
  onClose,
  side,
  activeTab,
  onSelectTab,
  onNewConvo,
  msgsCount,
  historyCount,
  agentsCount,
  ctxCounts,
}: MascotToolbarProps) {
  const [groups] = useState<ToolbarGroup[]>(loadGroups);
  // Catégorie dont les cartes sont déployées (null = aucune déployée).
  const [catId, setCatId] = useState<string | null>(null);

  // À chaque ouverture du menu, on repart colonne seule (rien de déployé).
  useEffect(() => {
    if (open) setCatId(null);
  }, [open]);

  if (!open) return null;

  const itemState = (id: ToolbarItemId): { active: boolean; count: number; run: () => void } => {
    switch (id) {
      case "chat":    return { active: activeTab === "feed", count: msgsCount, run: () => onSelectTab("feed") };
      case "new":     return { active: false, count: 0, run: onNewConvo };
      case "history": return { active: activeTab === "history", count: historyCount, run: () => onSelectTab("history") };
      case "agents":  return { active: activeTab === "agents", count: agentsCount, run: () => onSelectTab("agents") };
      default:        return { active: activeTab === id, count: ctxCounts[id] ?? 0, run: () => onSelectTab(id) };
    }
  };

  // Sélection d'une carte → exécute l'action puis TOUT se referme.
  const pick = (id: ToolbarItemId) => {
    itemState(id).run();
    setCatId(null);
    onClose();
  };

  return (
    <div className={"mtb-menu side-" + side}>
      {/* Scrim transparent : un clic à côté referme le menu. */}
      <button className="mtb-scrim" aria-label="Fermer le menu" onClick={onClose} />

      {/* Barre-pilule verticale façon « prompt » : UNE barre, des ICÔNES de
          catégorie (le libellé est en tooltip, pas de mots dans des bulles). */}
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
                <CategoryIcon groupId={g.id} />
              </button>

              {/* Déploiement horizontal des cartes, à côté de l'icône active. */}
              {deployed && (
                <div className="mtb-flyout" role="menu" aria-label={g.label}>
                  {g.items.map((id) => {
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
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
