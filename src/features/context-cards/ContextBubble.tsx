// Shugu Forge — ContextBubble : mini gestionnaire de fenêtres flottantes.
//
// Trigger = bouton fixe dans la TITLEBAR (#tb-ctx-slot). Clic → ouvre un
// MENU-LANCEUR (liste des cartes). Cliquer une carte ouvre une FENÊTRE flottante
// dédiée — on peut en ouvrir PLUSIEURS en même temps (ex. Plan + Prévisu).
//
// Chaque fenêtre :
//   • se déplace en glissant son en-tête,
//   • se redimensionne en LARGEUR via la poignée du bord droit (comme une
//     fenêtre d'OS),
//   • change de HAUTEUR (mini → demi → plein) via le bouton de l'en-tête,
//   • passe au premier plan au clic (z-order).
//
// "Terminal" n'est pas une carte : il ouvre le vrai terminal du dock du bas.
// Chat view only. Les données éditeur (fichiers ouverts / actif / contenus) sont
// threadées depuis le shell parent pour la carte "Éditeur".

import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { CTX_TABS, ContextCard, useCtxCounts, type CtxTabId, type EditorBridge } from "./cards";
import { setBottomDockOpen } from "@/features/cockpit/layoutStore";

type Size = "mini" | "demi" | "plein";
const SIZE_CYCLE: Record<Size, Size> = { mini: "demi", demi: "plein", plein: "mini" };
const SIZE_LABEL: Record<Size, string> = { mini: "Mini", demi: "Demi", plein: "Plein" };
const MIN_W = 280;

interface Win {
  id: CtxTabId;
  size: Size; // hauteur
  width: number; // largeur (drag)
  x: number;
  y: number;
  z: number;
}

export function ContextBubble({
  convId,
  onOpenFile,
  editor = {},
}: {
  convId: string;
  onOpenFile: (path: string) => void;
  editor?: EditorBridge;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [wins, setWins] = useState<Win[]>([]);
  const zTop = useRef(30);
  const wmRef = useRef<HTMLDivElement>(null);
  const counts = useCtxCounts(convId);
  const totalBadge = counts.tasks + counts.git;

  const patch = (id: CtxTabId, p: Partial<Win>) =>
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, ...p } : w)));
  const raise = (id: CtxTabId) => patch(id, { z: ++zTop.current });

  const openCard = (id: CtxTabId) =>
    setWins((ws) => {
      if (ws.some((w) => w.id === id)) {
        return ws.map((w) => (w.id === id ? { ...w, z: ++zTop.current } : w));
      }
      const wmW = wmRef.current?.clientWidth ?? 900;
      const i = ws.length;
      const width = 380;
      const x = Math.max(8, wmW - width - 18 - i * 26);
      const y = 14 + i * 26;
      return [...ws, { id, size: "mini", width, x, y, z: ++zTop.current }];
    });

  const closeCard = (id: CtxTabId) => setWins((ws) => ws.filter((w) => w.id !== id));
  const cycleSize = (id: CtxTabId) =>
    setWins((ws) => ws.map((w) => (w.id === id ? { ...w, size: SIZE_CYCLE[w.size] } : w)));

  const openTerminal = () => setBottomDockOpen(true);

  // Drag the header → move the window (clamped inside the work area).
  const startMove = (w: Win, e: RPointerEvent) => {
    e.preventDefault();
    raise(w.id);
    const rect = wmRef.current?.getBoundingClientRect();
    const maxX = rect?.width ?? 9999;
    const maxY = rect?.height ?? 9999;
    const sx = e.clientX, sy = e.clientY, ox = w.x, oy = w.y;
    const onMove = (ev: PointerEvent) => {
      const nx = Math.max(0, Math.min(ox + (ev.clientX - sx), maxX - 80));
      const ny = Math.max(0, Math.min(oy + (ev.clientY - sy), maxY - 36));
      patch(w.id, { x: nx, y: ny });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Drag the right-edge handle → change WIDTH only (height stays button-driven).
  const startResize = (w: Win, e: RPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    raise(w.id);
    const maxW = wmRef.current?.clientWidth ?? 1200;
    const sx = e.clientX, ow = w.width;
    const onMove = (ev: PointerEvent) => {
      const nw = Math.max(MIN_W, Math.min(ow + (ev.clientX - sx), maxW - w.x - 8));
      patch(w.id, { width: nw });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const slot = typeof document !== "undefined" ? document.getElementById("tb-ctx-slot") : null;
  const trigger = (
    <button
      className="tb-action ctx-tb-btn"
      onClick={() => setMenuOpen((o) => !o)}
      title="Contexte"
      aria-pressed={menuOpen}
    >
      <Icon name="sparkle" size={15} />
      {totalBadge > 0 && <span className="ctx-pill-count">{totalBadge}</span>}
    </button>
  );

  return (
    <>
      {slot && createPortal(trigger, slot)}

      <div className="ctx-wm" ref={wmRef}>
        {menuOpen && (
          <div className="ctx-bubble is-menu ctx-launcher">
            <div className="ctx-bubble-head">
              <span className="ctx-bubble-title">
                <Icon name="sparkle" size={13} /> Contexte
              </span>
              <button className="ctx-bubble-close" onClick={() => setMenuOpen(false)} title="Fermer le menu">
                <Icon name="x" size={13} />
              </button>
            </div>
            <div className="ctx-launch" role="menu">
              {CTX_TABS.map((t) => {
                const isOpen = wins.some((w) => w.id === t.id);
                return (
                  <button
                    key={t.id}
                    role="menuitem"
                    className={"ctx-launch-item" + (isOpen ? " open" : "")}
                    onClick={() => openCard(t.id)}
                  >
                    <Icon name={t.icon} size={15} />
                    <span className="label">{t.label}</span>
                    {counts[t.id] > 0 && <span className="ctx-pill-count">{counts[t.id]}</span>}
                    {isOpen ? (
                      <span className="ctx-open-dot" title="Fenêtre ouverte" />
                    ) : (
                      <Icon name="chevron-right" size={14} className="chev" />
                    )}
                  </button>
                );
              })}
              <button role="menuitem" className="ctx-launch-item" onClick={openTerminal}>
                <Icon name="term" size={15} />
                <span className="label">Terminal</span>
                <span className="ctx-launch-kbd">Ctrl&nbsp;`</span>
              </button>
            </div>
          </div>
        )}

        {wins.map((w) => {
          const meta = CTX_TABS.find((t) => t.id === w.id);
          if (!meta) return null;
          return (
            <div
              key={w.id}
              className={"ctx-bubble ctx-win size-" + w.size}
              style={{ left: w.x, top: w.y, width: w.width, zIndex: w.z }}
              onPointerDown={() => raise(w.id)}
            >
              <div className="ctx-bubble-head ctx-win-head" onPointerDown={(e) => startMove(w, e)}>
                <span className="ctx-bubble-title">
                  <Icon name={meta.icon} size={13} />
                  {meta.label}
                </span>
                <button
                  className="ctx-size"
                  onClick={() => cycleSize(w.id)}
                  onPointerDown={(e) => e.stopPropagation()}
                  title={`Hauteur : ${SIZE_LABEL[w.size]} (cliquer pour agrandir)`}
                >
                  {SIZE_LABEL[w.size]}
                </button>
                <button
                  className="ctx-bubble-close"
                  onClick={() => closeCard(w.id)}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="Fermer"
                >
                  <Icon name="x" size={13} />
                </button>
              </div>

              <div className="ctx-bubble-body">
                <ContextCard tab={w.id} convId={convId} onOpenFile={onOpenFile} editor={editor} />
              </div>

              <div
                className="ctx-win-resize"
                onPointerDown={(e) => startResize(w, e)}
                title="Glisser pour la largeur"
              />
            </div>
          );
        })}
      </div>
    </>
  );
}
