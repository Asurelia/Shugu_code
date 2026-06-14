// Shugu Forge — Mode selector (Chat / Plan / Agent).
//
// Remplace l'ancienne pastille décorative « Accès complet » du composer. C'est
// un VRAI sélecteur de mode, façon Claude Code, mais adapté au pivot Shugu
// « exec directe + filet git » (pas de système de permissions) :
//
//   • Chat  💬 — conversation pure : un appel LLM, AUCUN outil (rapide).
//   • Plan  📋 — lecture seule : l'agent explore + propose un plan, sans rien
//                modifier ni exécuter (enforcement read_only côté runner Rust).
//   • Agent ⚡ — défaut : l'agent complet lit / écrit / lance / vérifie.
//
// L'état vit dans `useChatMode` (localStorage + event cross-fenêtre), partagé
// entre le cockpit et la mascotte. Le popover réutilise la charte `.model-pop`.

import { useEffect, useRef, useState, useCallback } from "react";
import { Icon } from "@/components/components";
import { useChatMode, type ChatMode } from "./chat-sync";

interface ModeDef {
  id: ChatMode;
  icon: string;
  label: string;
  desc: string;
}

// Ordre d'affichage = du plus léger au plus puissant (Chat → Plan → Agent),
// pour que la « montée en capacité » se lise de haut en bas dans le popover.
const MODES: ModeDef[] = [
  { id: "chat", icon: "chat", label: "Chat", desc: "Conversation pure — aucun outil, réponses rapides." },
  { id: "plan", icon: "list", label: "Plan", desc: "Lecture seule — explore et propose un plan, sans rien modifier." },
  { id: "agent", icon: "agent", label: "Agent", desc: "Exécution directe — lit, écrit, lance, vérifie (git = filet)." },
];

export function ModeSelector({ className = "" }: { className?: string }) {
  const [mode, setMode] = useChatMode();
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
        <span className="mode-label">{active.label}</span>
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
                <span className="name">{m.label}</span>
                <span className="mode-item-desc">{m.desc}</span>
              </span>
              {m.id === mode && <span className="check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
