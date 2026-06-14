// Shugu Forge — ContextBubble.
//
// Trigger = a fixed icon-button in the TITLEBAR (#tb-ctx-slot), "Contexte"
// tooltip. Click → a compact vertical MENU (icon + label per row, flyout-style).
// Click a card row → that card's content replaces the menu (with a "‹" back).
// The bubble is a MINI panel by default and can grow (mini → demi → plein) via
// the size button, so big content (plan, diff, editor preview) gets room — the
// full cockpit right panel stays for the heavy lifting.
//
// "Terminal" is special: it opens the REAL bottom-dock terminal of the cockpit,
// not a card. Chat view only. Editor data (open files / active file / contents)
// is threaded from the parent shell so the "Éditeur" card can preview them;
// absent that bridge (e.g. mascot) the card shows an empty state.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { CTX_TABS, ContextCard, useCtxCounts, type CtxTabId, type EditorBridge } from "./cards";
import { setBottomDockOpen } from "@/features/cockpit/layoutStore";

type View = "menu" | CtxTabId;
type Size = "mini" | "demi" | "plein";
const SIZE_CYCLE: Record<Size, Size> = { mini: "demi", demi: "plein", plein: "mini" };
const SIZE_LABEL: Record<Size, string> = { mini: "Mini", demi: "Demi", plein: "Plein" };

export function ContextBubble({
  convId,
  onOpenFile,
  editor = {},
}: {
  convId: string;
  onOpenFile: (path: string) => void;
  editor?: EditorBridge;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [size, setSize] = useState<Size>("mini");
  const counts = useCtxCounts(convId);

  const totalBadge = counts.tasks + counts.git;

  // Opening always lands on the menu ("click Contexte → the menu opens").
  const toggle = () => {
    if (!open) setView("menu");
    setOpen((o) => !o);
  };

  // "Terminal" routes to the real bottom-dock terminal (cockpit), not a card.
  const openTerminal = () => {
    setBottomDockOpen(true);
    setOpen(false);
  };

  const activeMeta = view !== "menu" ? CTX_TABS.find((t) => t.id === view) ?? null : null;

  const cls =
    "ctx-bubble" + (view === "menu" ? " is-menu" : " size-" + size);

  const slot = typeof document !== "undefined" ? document.getElementById("tb-ctx-slot") : null;
  const trigger = (
    <button className="tb-action ctx-tb-btn" onClick={toggle} title="Contexte" aria-pressed={open}>
      <Icon name="sparkle" size={15} />
      {totalBadge > 0 && <span className="ctx-pill-count">{totalBadge}</span>}
    </button>
  );

  return (
    <>
      {slot && createPortal(trigger, slot)}
      {open && (
        <div className={cls}>
          {view === "menu" ? (
            <>
              <div className="ctx-bubble-head">
                <span className="ctx-bubble-title">
                  <Icon name="sparkle" size={13} /> Contexte
                </span>
                <button className="ctx-bubble-close" onClick={() => setOpen(false)} title="Replier">
                  <Icon name="x" size={13} />
                </button>
              </div>

              <div className="ctx-launch" role="menu">
                {CTX_TABS.map((t) => (
                  <button
                    key={t.id}
                    role="menuitem"
                    className="ctx-launch-item"
                    onClick={() => setView(t.id)}
                  >
                    <Icon name={t.icon} size={15} />
                    <span className="label">{t.label}</span>
                    {counts[t.id] > 0 && <span className="ctx-pill-count">{counts[t.id]}</span>}
                    <Icon name="chevron-right" size={14} className="chev" />
                  </button>
                ))}

                <button role="menuitem" className="ctx-launch-item" onClick={openTerminal}>
                  <Icon name="term" size={15} />
                  <span className="label">Terminal</span>
                  <span className="ctx-launch-kbd">Ctrl&nbsp;`</span>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="ctx-bubble-head">
                <button className="ctx-back" onClick={() => setView("menu")} title="Retour au menu">
                  <Icon name="chevron-left" size={15} />
                </button>
                <span className="ctx-bubble-title">
                  {activeMeta && <Icon name={activeMeta.icon} size={13} />}
                  {activeMeta?.label}
                </span>
                <button
                  className="ctx-size"
                  onClick={() => setSize((s) => SIZE_CYCLE[s])}
                  title={`Taille : ${SIZE_LABEL[size]} (cliquer pour agrandir)`}
                >
                  {SIZE_LABEL[size]}
                </button>
                <button className="ctx-bubble-close" onClick={() => setOpen(false)} title="Replier">
                  <Icon name="x" size={13} />
                </button>
              </div>

              <div className="ctx-bubble-body">
                <ContextCard tab={view} convId={convId} onOpenFile={onOpenFile} editor={editor} />
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
