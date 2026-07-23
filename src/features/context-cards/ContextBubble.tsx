// Shugu Forge — ContextBubble : menu-lanceur des tuiles du panneau droit.
//
// Trigger = bouton fixe dans la TITLEBAR (#tb-ctx-slot). Clic → menu vertical
// (flyout). Cliquer une entrée OUVRE une TUILE dans le panneau cockpit de droite
// (cf. ContextTiles) — on peut en empiler plusieurs, elles se tuilent en grille
// redimensionnable. Le menu marque d'une pastille les tuiles déjà ouvertes
// (cliquer une 2ᵉ fois ne fait rien — la tuile est déjà là).
//
// Plus de fenêtres flottantes : le rendu des panneaux vit dans le panneau droit.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { CTX_TABS, useCtxCounts } from "./cards";
import { openTile, useOpenTiles, type TileId } from "./tilesStore";

// Entrées du menu = les cartes Contexte + Fichiers + Terminal (toutes tuilables).
const MENU: { id: TileId; label: string; icon: string }[] = [
  ...CTX_TABS.map((t) => ({ id: t.id as TileId, label: t.label, icon: t.icon })),
  { id: "files", label: "Fichiers", icon: "folderTree" },
  { id: "terminal", label: "Terminal", icon: "term" },
];

export function ContextBubble({ convId }: { convId: string }) {
  const [open, setOpen] = useState(false);
  const counts = useCtxCounts(convId);
  const tiles = useOpenTiles();
  const totalBadge = counts.tasks + counts.git;

  const slot = typeof document !== "undefined" ? document.getElementById("tb-ctx-slot") : null;
  const trigger = (
    <button
      className="tb-action ctx-tb-btn"
      onClick={() => setOpen((o) => !o)}
      title="Contexte"
      aria-label="Contexte — ouvrir le menu des panneaux (Plan, Agents, Git, Sources…)"
      aria-haspopup="menu"
      aria-expanded={open}
    >
      <Icon name="sparkle" size={15} />
      {totalBadge > 0 && <span className="ctx-pill-count">{totalBadge}</span>}
    </button>
  );

  return (
    <>
      {slot && createPortal(trigger, slot)}
      {open && (
        <div className="ctx-bubble is-menu">
          <div className="ctx-bubble-head">
            <span className="ctx-bubble-title">
              <Icon name="sparkle" size={13} /> Contexte
            </span>
            <button className="ctx-bubble-close" onClick={() => setOpen(false)} title="Fermer le menu" aria-label="Fermer le menu Contexte">
              <Icon name="x" size={13} />
            </button>
          </div>
          <div className="ctx-launch" role="menu">
            {MENU.map((m) => {
              const isOpen = tiles.includes(m.id);
              const count = (counts as Record<string, number>)[m.id] ?? 0;
              return (
                <button
                  key={m.id}
                  role="menuitem"
                  className={"ctx-launch-item" + (isOpen ? " open" : "")}
                  onClick={() => openTile(m.id)}
                >
                  <Icon name={m.icon} size={15} />
                  <span className="label">{m.label}</span>
                  {count > 0 && <span className="ctx-pill-count">{count}</span>}
                  {isOpen ? (
                    <span className="ctx-open-dot" title="Tuile ouverte" />
                  ) : (
                    <Icon name="chevron-right" size={14} className="chev" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
