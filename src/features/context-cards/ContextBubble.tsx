// Shugu Forge — ContextBubble.
//
// The trigger is a small icon-button that lives in the TITLEBAR, grouped with
// History/Bell/Settings — it is portaled there (#tb-ctx-slot) so it sits as
// chrome with the other action icons, even though this component is mounted in
// ChatView (which owns convId + the split-on-open onOpenFile). Clicking it
// toggles a ~360px panel that floats top-right of the chat surface, whose
// header opens a dropdown menu of the 6 tabs. Chat view only.

import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { CTX_TABS, ContextCard, useCtxCounts, type CtxTabId } from "./cards";

export function ContextBubble({
  convId,
  onOpenFile,
}: {
  convId: string;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CtxTabId>("plan");
  const [menuOpen, setMenuOpen] = useState(false);
  const headRef = useRef<HTMLDivElement | null>(null);
  const counts = useCtxCounts(convId);

  const active = CTX_TABS.find((t) => t.id === tab)!;

  // Close the tab dropdown when clicking outside the bubble header. A CSS scrim
  // can't do this: .ctx-bubble's backdrop-filter makes it the containing block
  // for position:fixed (so inset:0 covers the bubble, not the viewport) and its
  // overflow:hidden clips any full-screen overlay.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!headRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  // The trigger button — rendered into the titlebar slot so it sits with the
  // other action icons. The slot is a static child of the always-mounted
  // Titlebar, so getElementById resolves synchronously on first render (no
  // effect/flicker needed).
  const slot = typeof document !== "undefined" ? document.getElementById("tb-ctx-slot") : null;
  const trigger = (
    <button
      className="tb-action ctx-tb-btn"
      onClick={() => setOpen((o) => !o)}
      title={"Contexte · " + active.label}
      aria-pressed={open}
    >
      <Icon name={active.icon} size={15} />
      {counts[tab] > 0 && <span className="ctx-pill-count">{counts[tab]}</span>}
    </button>
  );

  return (
    <>
      {slot && createPortal(trigger, slot)}
      {open && (
        <div className="ctx-bubble">
          <div className="ctx-bubble-head" ref={headRef}>
            <button className="ctx-trigger" onClick={() => setMenuOpen((m) => !m)}>
              <Icon name={active.icon} size={13} />
              <span className="ctx-trigger-label">{active.label}</span>
              {counts[tab] > 0 && <span className="ctx-pill-count">{counts[tab]}</span>}
              <Icon name="down" size={11} />
            </button>
            <button className="ctx-bubble-close" onClick={() => setOpen(false)} title="Replier">
              <Icon name="x" size={13} />
            </button>

            {menuOpen && (
              <div className="ctx-menu">
                {CTX_TABS.map((t) => (
                  <button
                    key={t.id}
                    className={"ctx-menu-item" + (t.id === tab ? " on" : "")}
                    onClick={() => { setTab(t.id); setMenuOpen(false); }}
                  >
                    <Icon name={t.icon} size={13} />
                    <span className="label">{t.label}</span>
                    {counts[t.id] > 0 && <span className="ctx-pill-count">{counts[t.id]}</span>}
                    {t.id === tab && <span className="check">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ctx-bubble-body">
            <ContextCard tab={tab} convId={convId} onOpenFile={onOpenFile} />
          </div>
        </div>
      )}
    </>
  );
}
