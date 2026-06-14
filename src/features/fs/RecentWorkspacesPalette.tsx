// Shugu Forge — Lot projets-récents (2026-06-10) — picker « Open Recent ».
//
// Modal minimal listant les 8 derniers workspaces (recentWorkspaces.ts),
// style palette réutilisé (.palette-scrim/.palette/.palette-item — cohérence
// visuelle gratuite avec CommandPalette et QuickOpenPalette). Pas de champ de
// recherche : ≤ 8 entrées, le filtre serait du bruit. Navigation ↑/↓ + Entrée,
// Échap/scrim pour fermer.

import { useEffect, useState } from "react";
import { Icon } from "@/components/components";
import { listRecentWorkspaces } from "./recentWorkspaces";

export function RecentWorkspacesPalette({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  /** Reçoit le chemin absolu choisi ; le host fait le switch + cleanup. */
  onPick: (path: string) => void;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!open) return;
    setIdx(0);
    void listRecentWorkspaces().then(setPaths);
  }, [open]);

  // Clavier global du modal (pas d'input à focus — on écoute window tant
  // qu'ouvert, cleanup systématique).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, Math.max(paths.length - 1, 0)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const p = paths[idx];
        if (p) {
          onPick(p);
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, paths, idx, onPick, onClose]);

  if (!open) return null;

  return (
    <div
      className="palette-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette">
        <div className="palette-search">
          <Icon name="folder" size={16} />
          <span style={{ flex: 1, fontSize: 13, color: "var(--on-surface)" }}>
            Projets récents
          </span>
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list scroll">
          {paths.map((p, me) => {
            const slash = p.lastIndexOf("/");
            const base = slash >= 0 ? p.slice(slash + 1) : p;
            return (
              <div
                key={p}
                className={"palette-item" + (me === idx ? " active" : "")}
                onMouseEnter={() => setIdx(me)}
                onClick={() => {
                  onPick(p);
                  onClose();
                }}
              >
                <div className="ico">
                  <Icon name="folderTree" size={13} />
                </div>
                <div className="body">
                  <div className="name">{base}</div>
                  <div className="hint">{p}</div>
                </div>
              </div>
            );
          })}
          {paths.length === 0 && (
            <div
              style={{
                padding: "30px 16px",
                textAlign: "center",
                color: "var(--on-surface-muted)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              Aucun projet récent — ouvre un dossier (Ctrl+Shift+O) pour
              démarrer l'historique.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
