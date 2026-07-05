// Shugu Forge — account dropdown (titlebar avatar popover).
//
// Fully operational: identity (name / email / avatar) is read live from the
// local SQLite profile (db.settings via useProfileFields) and edited in
// Settings → Profile; the "usage" block shows REAL local activity counts
// (db.stats), and the tier line reflects the actually-active model. There is
// no cloud account or subscription, so the two buttons that would require one
// (Billing, Sign out) are visibly disabled with a tooltip explaining why —
// they are greyed, never removed. Rendered by RootLayout above the window
// chrome and triggered by the avatar in the title bar.

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/components";
import { useActiveModel } from "@/features/chat/chat-sync";
import {
  useProfileFields,
  useLocalStats,
  initialsOf,
  detectPlatform,
  modelLabel,
} from "@/features/profile/profileQueries";

interface AccountDropdownProps {
  open: boolean;
  onClose: () => void;
  onView: (view: string) => void;
}

// prefers-reduced-motion, live. Gates the count-up so motion-sensitive users
// get instant numbers instead of an animated tally.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
    catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia("(prefers-reduced-motion: reduce)"); }
    catch { return; }
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

// Animated integer tally (0 → value, easeOutCubic ~650ms). Remounts — and so
// re-animates — every time the card opens, because the parent returns null
// while closed. Instant when reduced-motion is requested.
function CountUp({ value, reduced }: { value: number; reduced: boolean }) {
  const [n, setN] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) { setN(value); return; }
    let raf = 0;
    let start = 0;
    const dur = 650;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced]);
  return <>{n.toLocaleString()}</>;
}

export function AccountDropdown({ open, onClose, onView }: AccountDropdownProps) {
  // Hooks first — must run unconditionally, before the early return below.
  const { data: profile } = useProfileFields();
  const { data: stats } = useLocalStats();
  const [activeModel] = useActiveModel();
  const reduced = useReducedMotion();
  const popRef = useRef<HTMLDivElement | null>(null);

  // Focus the popover on open (a11y) and wire Escape-to-close.
  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const name = profile?.name?.trim() ?? "";
  const email = profile?.email?.trim() ?? "";
  const initials = initialsOf(name);
  const platform = detectPlatform();

  const go = (view: string) => { onView(view); onClose(); };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={onClose} />
      <div
        className="account-pop"
        role="dialog"
        aria-label="Compte et profil"
        tabIndex={-1}
        ref={popRef}
      >
        {/* Header — the whole row opens Settings → Profile for editing. */}
        <button className="account-head" onClick={() => go("profile")} title="Modifier le profil">
          <div className="avatar" aria-hidden={!initials}>
            {initials || <Icon name="agent" size={20} />}
          </div>
          <div className="who">
            <div className={"name" + (name ? "" : " placeholder")}>
              {name || "Définis ton profil"}
            </div>
            <div className={"email" + (email ? "" : " placeholder")}>
              {email || "Ajoute nom et e-mail"}
            </div>
          </div>
          <span className="account-edit" aria-hidden="true"><Icon name="gear" size={13} /></span>
        </button>

        {/* Tier — honest: local edition, no fake plan. Shows the active model. */}
        <div className="account-tier">
          <span className="badge">Local</span>
          <div className="info">
            <div className="l">Édition</div>
            <div className="v">Shugu Forge · <small>{platform}</small></div>
          </div>
        </div>

        {/* Active model — real, from useActiveModel (the chat's default). */}
        <button className="account-model" onClick={() => go("interface")} title="Changer l'apparence / les réglages">
          <span className="ico"><Icon name="sparkle" size={12} /></span>
          <span className="ml-label">Modèle par défaut</span>
          <span className="ml-value">{modelLabel(activeModel)}</span>
        </button>

        {/* Usage → real local activity, not a fabricated quota. */}
        <div className="account-usage">
          <div className="usage-head">Activité locale</div>
          <div className="stat-grid">
            <div className="stat">
              <div className="n"><CountUp value={stats?.conversations ?? 0} reduced={reduced} /></div>
              <div className="k">Conversations</div>
            </div>
            <div className="stat">
              <div className="n"><CountUp value={stats?.messages ?? 0} reduced={reduced} /></div>
              <div className="k">Messages</div>
            </div>
            <div className="stat">
              <div className="n"><CountUp value={stats?.images ?? 0} reduced={reduced} /></div>
              <div className="k">Images</div>
            </div>
          </div>
        </div>

        <div className="account-menu">
          <button className="account-item" onClick={() => go("profile")}>
            <span className="ico"><Icon name="agent" size={13} /></span>Account &amp; Profile
          </button>
          <button className="account-item" onClick={() => go("connections")}>
            <span className="ico"><Icon name="folder" size={13} /></span>Connections &amp; API keys
          </button>
          <button className="account-item" onClick={() => go("privacy")}>
            <span className="ico"><Icon name="shield" size={13} /></span>Privacy &amp; data
          </button>

          {/* Disabled: no billing backend exists (100% local). Greyed, kept. */}
          <button
            className="account-item is-disabled"
            aria-disabled="true"
            title="Aucune facturation — Shugu fonctionne 100 % en local, sans abonnement."
          >
            <span className="ico"><Icon name="copy" size={13} /></span>Billing &amp; invoices
            <span className="acc-lock"><Icon name="lock" size={11} /></span>
          </button>

          <button className="account-item" onClick={() => go("interface")}>
            <span className="ico"><Icon name="palette" size={13} /></span>Switch theme
          </button>

          <div className="ctx-divider"></div>

          <button className="account-item" onClick={() => go("about")}>
            <span className="ico"><Icon name="search" size={13} /></span>Help &amp; support
          </button>

          {/* Disabled: no account/login system — nothing to sign out of. */}
          <button
            className="account-item is-disabled"
            aria-disabled="true"
            title="Aucun compte — Shugu est 100 % local, il n'y a pas de session à fermer."
          >
            <span className="ico"><Icon name="x" size={13} /></span>Sign out
            <span className="acc-lock"><Icon name="lock" size={11} /></span>
          </button>
        </div>
      </div>
    </>
  );
}
