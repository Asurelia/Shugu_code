// Shugu Forge — Mode selector (Chat / Plan / Agent).
//
// Remplace l'ancienne pastille décorative « Accès complet » du composer. C'est
// un VRAI sélecteur de mode :
//
//   • Chat  💬 — lecture + recherche : web_search / web_fetch / code_search +
//                lecture fs, JAMAIS d'écriture ni d'exécution (rapide, sûr).
//   • Plan  📋 — lecture seule : l'agent explore + propose un plan, sans rien
//                modifier ni exécuter (enforcement read_only côté runner Rust).
//   • Agent ⚡ — cycle complet. Auto confine les écritures au workspace ;
//                Full Access exige un grant natif sessionnel.
//
// L'état vit dans `useChatMode` (localStorage + event cross-fenêtre), partagé
// entre le cockpit et la mascotte. Le popover réutilise la charte `.model-pop`.

import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "@/components/components";
import {
  useAgentAccessProfile,
  useChatMode,
  type AgentAccessProfile,
  type ChatMode,
} from "./chat-sync";
import { RiskBadge, modeToRisk, toTrustMode } from "@/components/trust";
import { pushToast } from "@/components/toast";

interface ModeDef {
  id: ChatMode;
  icon: string;
  label: string;
  desc: string;
}

// Ordre d'affichage = du plus léger au plus puissant (Chat → Plan → Agent),
// pour que la « montée en capacité » se lise de haut en bas dans le popover.
const MODES: ModeDef[] = [
  { id: "chat", icon: "chat", label: "Chat", desc: "Conversation avec outils de lecture configurés. Aucune écriture ni commande." },
  { id: "plan", icon: "list", label: "Plan", desc: "Lecture seule — explore et propose un plan, sans rien modifier." },
  { id: "agent", icon: "agent", label: "Agent", desc: "Cycle complet — lit, planifie, modifie, exécute et vérifie." },
];

const ACCESS: { id: AgentAccessProfile; label: string; desc: string }[] = [
  {
    id: "auto",
    label: "Auto",
    desc: "Recommandé — écrit uniquement dans le workspace et ses caches dédiés. Lecture machine et réseau restent actifs.",
  },
  {
    id: "fullAccess",
    label: "Full Access",
    desc: "Accès direct à la machine après une confirmation native unique ; aucune confirmation par commande. Réinitialisé au redémarrage.",
  },
];

export function ModeSelector({ className = "" }: { className?: string }) {
  const [mode, setMode] = useChatMode();
  const [access, setAccess] = useAgentAccessProfile();
  const [accessBusy, setAccessBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  const active = MODES.find((m) => m.id === mode) ?? MODES[2];

  // Fermeture au clic-extérieur + Échap (mêmes garanties que ModelPicker).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback(
    (id: ChatMode) => {
      setMode(id);
      setOpen(false);
    },
    [setMode],
  );

  const pickAccess = useCallback(async (profile: AgentAccessProfile) => {
    if (accessBusy || profile === access) return;
    setAccessBusy(true);
    try {
      const selected = await setAccess(profile);
      if (selected) setOpen(false);
    } catch (err) {
      pushToast(`Changement d’accès impossible : ${String(err)}`, "error", 7000);
    } finally {
      setAccessBusy(false);
    }
  }, [access, accessBusy, setAccess]);

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={`cx-chip mode mode-${active.id} ${className}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Mode : ${active.label} — ${active.desc}\nClique pour changer.`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dot" />
        <Icon name={active.icon} size={12} />
        <span className="mode-label">
          {active.label}{mode === "agent" ? ` · ${access === "auto" ? "Auto" : "Full"}` : ""}
        </span>
        <Icon name="down" size={9} />
      </button>
      {open && (
        <div className="model-pop mode-pop" role="menu" aria-label="Mode de l'agent">
          <div className="model-pop-group">Mode de l'agent</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitemradio"
              aria-checked={m.id === mode}
              className={`model-pop-item mode-item mode-${m.id}` + (m.id === mode ? " on" : "")}
              onClick={() => pick(m.id)}
            >
              <Icon name={m.icon} size={15} />
              <span className="mode-item-text">
                <span
                  className="name"
                  style={{ display: "inline-flex", alignItems: "center", gap: 7 }}
                >
                  {m.label}
                  {/* Trust-UX (Lane 5) — tier de risque explicite par mode : la
                      couleur (lecture=cyan, exécution=rouge) dit la portée réelle
                      avant même de lire la description. */}
                  <RiskBadge level={modeToRisk(toTrustMode(m.id))} size="sm" />
                </span>
                <span className="mode-item-desc">{m.desc}</span>
              </span>
              {m.id === mode && <span className="check">✓</span>}
            </button>
          ))}
          {mode === "agent" && (
            <>
              <div className="model-pop-group">Accès d’exécution</div>
              {ACCESS.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={profile.id === access}
                  disabled={accessBusy}
                  className={`model-pop-item mode-item mode-agent${profile.id === access ? " on" : ""}`}
                  onClick={() => { void pickAccess(profile.id); }}
                >
                  <Icon name={profile.id === "auto" ? "shield" : "bolt"} size={15} />
                  <span className="mode-item-text">
                    <span className="name">{profile.label}</span>
                    <span className="mode-item-desc">{profile.desc}</span>
                  </span>
                  {profile.id === access && <span className="check">✓</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </span>
  );
}
