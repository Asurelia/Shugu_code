// Shugu Forge — ContextBubble.
//
// The trigger is a small icon-button that lives in the TITLEBAR, grouped with
// History/Bell/Settings — it is portaled there (#tb-ctx-slot). It represents the
// "Contexte" category as a WHOLE: its icon/label are FIXED (they no longer
// mirror the active tab). Clicking it toggles a panel that floats top-right of
// the chat surface. The panel opens DIRECTLY onto the active tab's content; tab
// switching is a one-click tab bar at the top (no nested dropdown). The last
// selected tab is remembered across opens. Chat view only.

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { CTX_TABS, ContextCard, useCtxCounts, type CtxTabId } from "./cards";

const TAB_STORE_KEY = "shugu.ctx.tab.v1";

function loadInitialTab(): CtxTabId {
  if (typeof localStorage === "undefined") return "plan";
  const saved = localStorage.getItem(TAB_STORE_KEY);
  return CTX_TABS.some((t) => t.id === saved) ? (saved as CtxTabId) : "plan";
}

export function ContextBubble({
  convId,
  onOpenFile,
}: {
  convId: string;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<CtxTabId>(loadInitialTab);
  const counts = useCtxCounts(convId);

  // Persist the last selected tab so reopening the panel lands where the user
  // left off (the trigger itself is category-fixed, so this is the only memory).
  useEffect(() => {
    try { localStorage.setItem(TAB_STORE_KEY, tab); } catch { /* ignore */ }
  }, [tab]);

  // Aggregate, tab-INDEPENDENT badge: the live "attention" signals (running
  // agents + uncommitted changes). The trigger no longer reflects the open tab.
  const totalBadge = counts.tasks + counts.git;

  // The trigger button — rendered into the titlebar slot so it sits with the
  // other action icons. Fixed icon + tooltip: it's the "Contexte" category.
  const slot = typeof document !== "undefined" ? document.getElementById("tb-ctx-slot") : null;
  const trigger = (
    <button
      className="tb-action ctx-tb-btn"
      onClick={() => setOpen((o) => !o)}
      title="Contexte"
      aria-pressed={open}
    >
      <Icon name="sparkle" size={15} />
      {totalBadge > 0 && <span className="ctx-pill-count">{totalBadge}</span>}
    </button>
  );

  return (
    <>
      {slot && createPortal(trigger, slot)}
      {open && (
        <div className="ctx-bubble">
          <div className="ctx-bubble-head">
            <div className="ctx-tabs" role="tablist">
              {CTX_TABS.map((t) => (
                <button
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === tab}
                  className={"ctx-tab" + (t.id === tab ? " on" : "")}
                  onClick={() => setTab(t.id)}
                  title={t.label}
                >
                  <Icon name={t.icon} size={13} />
                  <span className="label">{t.label}</span>
                  {counts[t.id] > 0 && <span className="ctx-pill-count">{counts[t.id]}</span>}
                </button>
              ))}
            </div>
            <button className="ctx-bubble-close" onClick={() => setOpen(false)} title="Replier">
              <Icon name="x" size={13} />
            </button>
          </div>

          <div className="ctx-bubble-body">
            <ContextCard tab={tab} convId={convId} onOpenFile={onOpenFile} />
          </div>
        </div>
      )}
    </>
  );
}
