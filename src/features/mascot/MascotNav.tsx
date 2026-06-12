// Shugu Forge — MascotNav : barre d'onglets unifiée + hub « Cartes ».
//
// Lot nav-mascotte (2026-06-13) — remplace le menu cascade MascotToolbar
// (supprimé le même round, politique cleanup). Décision utilisateur sur
// maquettes comparatives (« Mix A+C ») :
//   • MascotTabBar : 4 onglets PERSISTANTS en tête de panneau
//     (Chat · Historique · Agents · Cartes), icône + libellé (jamais icône
//     seule), onglet actif souligné mauve, badges live (agents actifs,
//     activité des cartes).
//   • CardsHub : l'onglet « Cartes » ouvre une GRILLE de tuiles étiquetées
//     (Plan / Tâches / Git / Prévisu / Sources / Env) — façon hub, pas de
//     menu déroulant. Une carte ouverte affiche un breadcrumb « ← Cartes »
//     dans son en-tête (rendu par ChatPanel).
//
// Composants présentationnels purs : l'état `tab` vit dans ChatPanel, les
// données (counts) arrivent par props depuis les hooks TanStack existants
// (useActiveAgents, useCtxCounts) — aucune logique data dupliquée ici.

import { Icon } from "@/components/components";
import { CTX_TABS, type CtxTabId } from "@/features/context-cards/cards";

// L'onglet actif du panneau mascotte : un des 3 onglets de conversation, le
// hub Cartes, ou une carte contextuelle ouverte (l'onglet « Cartes » reste
// visuellement actif dans ce dernier cas).
export type MascotTab = "feed" | "history" | "agents" | "hub" | CtxTabId;

export function isCardTab(t: MascotTab): t is CtxTabId {
  return CTX_TABS.some((c) => c.id === t);
}

const TABS = [
  { id: "feed", label: "Chat", icon: "chat" },
  { id: "history", label: "Historique", icon: "history" },
  { id: "agents", label: "Agents", icon: "agent" },
  { id: "hub", label: "Cartes", icon: "gallery" },
] as const;

export interface MascotTabBarProps {
  tab: MascotTab;
  onSelect: (t: MascotTab) => void;
  onNewConvo: () => void;
  agentsCount: number;
  cardsCount: number;
}

export function MascotTabBar({ tab, onSelect, onNewConvo, agentsCount, cardsCount }: MascotTabBarProps) {
  // Une carte ouverte garde l'onglet « Cartes » actif — l'utilisateur sait
  // toujours où il est dans la hiérarchie (barre → hub → carte).
  const activeId = isCardTab(tab) ? "hub" : tab;
  return (
    <div className="mascot-tabbar" role="tablist" aria-label="Navigation mascotte">
      {TABS.map((t) => {
        const on = activeId === t.id;
        const count = t.id === "agents" ? agentsCount : t.id === "hub" ? cardsCount : 0;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={"mascot-tab" + (on ? " on" : "")}
            onClick={() => onSelect(t.id)}
          >
            <Icon name={t.icon} size={13} />
            <span>{t.label}</span>
            {count > 0 && <span className="mascot-tab-badge">{count}</span>}
          </button>
        );
      })}
      <button
        type="button"
        className="mascot-tab mascot-tab-new"
        title="Nouvelle conversation"
        aria-label="Nouvelle conversation"
        onClick={onNewConvo}
      >
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}

export interface CardsHubProps {
  counts: Record<CtxTabId, number>;
  onOpen: (id: CtxTabId) => void;
}

export function CardsHub({ counts, onOpen }: CardsHubProps) {
  return (
    <div className="cards-hub" role="menu" aria-label="Cartes contextuelles">
      {CTX_TABS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="menuitem"
          className="cards-hub-tile"
          onClick={() => onOpen(c.id)}
        >
          <Icon name={c.icon} size={16} />
          <span className="cards-hub-label">{c.label}</span>
          {counts[c.id] > 0 && <span className="mascot-tab-badge">{counts[c.id]}</span>}
        </button>
      ))}
    </div>
  );
}
