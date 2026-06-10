// Shugu Forge — Lot mascotte-avatar (2026-06-10) — la bulle de parole.
//
// Rendue UNIQUEMENT dans la fenêtre mascotte, en absolu au-dessus de la chibi
// (le wrapper anchor est position:relative dans mascot.tsx). Classe
// `.float-bubble` : déjà whitelistée par le click-through de la fenêtre
// transparente (mascot.tsx) — sans elle, les clics passeraient au bureau.
//
// Accessibilité/feel (réf. ui-ux-pro-max) : aria-live="polite" (ne vole pas le
// focus), entrée 200 ms transform/opacity (ease-out), prefers-reduced-motion
// respecté côté CSS, clic = action claire (ouvrir l'agent ou fermer).

import { revealAgent } from "@/lib/agents";
import { useMascotSpeech, clearMascotSpeech } from "./speechStore";

export function SpeechBubble() {
  const speech = useMascotSpeech();
  if (!speech) return null;

  const onClick = () => {
    if (speech.agentId) {
      // Broadcast app://reveal-agent : la fenêtre main ouvre son panneau
      // Agents, et le ChatPanel mascotte bascule sur son onglet Agents.
      void revealAgent(speech.agentId);
    }
    clearMascotSpeech();
  };

  return (
    <div
      className={`float-bubble mascot-bubble mascot-bubble--${speech.tone}`}
      role="status"
      aria-live="polite"
      title={speech.agentId ? "Cliquer pour ouvrir l'agent" : "Cliquer pour fermer"}
      onClick={onClick}
    >
      <span className="mascot-bubble-text">{speech.text}</span>
      <span className="mascot-bubble-tail" aria-hidden="true" />
    </div>
  );
}
