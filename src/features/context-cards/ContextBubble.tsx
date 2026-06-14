// Shugu Forge — ContextBubble.
//
// The trigger is a small icon-button in the TITLEBAR (portaled to #tb-ctx-slot),
// grouped with History/Bell/Settings — fixed icon + "Contexte" tooltip (it's the
// category, it never mirrors a tab).
//
// Click → a vertical MENU opens (icon + label per row, à la VS Code flyout).
// Click a card row → that card's content replaces the menu (with a "‹" back to
// the menu). The "Terminal" row is special: it doesn't open a card — it opens
// the REAL bottom-dock terminal of the cockpit (like the IDE), then closes the
// bubble. Chat view only.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { CTX_TABS, ContextCard, useCtxCounts, type CtxTabId } from "./cards";
import { setBottomDockOpen } from "@/features/cockpit/layoutStore";

type View = "menu" | CtxTabId;

export function ContextBubble({
  convId,
  onOpenFile,
}: {
  convId: string;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("menu");
  const counts = useCtxCounts(convId);

  // Aggregate, tab-INDEPENDENT badge on the trigger: the live "attention"
  // signals (running agents + uncommitted changes).
  const totalBadge = counts.tasks + counts.git;

  // Opening always lands on the menu (the user's mental model: "click Contexte
  // → the menu opens"). Toggling closed keeps nothing.
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
        <div className="ctx-bubble">
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

                {/* Terminal — opens the real bottom-dock terminal, not a card. */}
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
                <button className="ctx-bubble-close" onClick={() => setOpen(false)} title="Replier">
                  <Icon name="x" size={13} />
                </button>
              </div>

              <div className="ctx-bubble-body">
                <ContextCard tab={view} convId={convId} onOpenFile={onOpenFile} />
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
