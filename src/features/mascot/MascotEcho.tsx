// Shugu Forge — écho de Shugu dans la fenêtre IDE (S1b).
//
// La fenêtre mascotte rend <SpeechBubble/> ; la fenêtre IDE, elle, ne montrait
// RIEN alors que son cache TanStack contient déjà l'énoncé (useAgentEvents est
// monté dans les deux fenêtres → sayMascot alimente les deux caches). Ce
// composant AFFICHE cet énoncé sous forme d'une mini-bulle chibi près du Rail.
//
// PARTAGE (pas de duplication) : même donnée `speechStore` que SpeechBubble ;
// seuls les styles diffèrent. Densité déjà curée en amont (seuls les 6 messages
// agent/skill/leçon passent par sayMascot ; les edits ne changent que l'humeur).
//
// GARDE-FOU VOIX : ne JAMAIS appeler ttsSpeak ici. Le TTS est branché
// uniquement au rendu mascotte (voir useTts.ts en-tête) — sinon deux fenêtres
// ouvertes = double audio (QueryClient/contexte JS séparé par webview).

import { revealAgent } from "@/lib/agents";
import { Chibi } from "./Chibi";
import { useMascotSpeech, clearMascotSpeech } from "./speechStore";
import { useMoodReaction } from "./moodReactionStore";
import { effectiveMood } from "./moodReactions";

export function MascotEcho() {
  const speech = useMascotSpeech();
  const reaction = useMoodReaction();
  if (!speech) return null;

  // Base « smile » (amicale) ; une réaction agent/edit non expirée prime.
  const mood = effectiveMood("smile", reaction, Date.now());

  const onClick = () => {
    if (speech.agentId) void revealAgent(speech.agentId);
    clearMascotSpeech();
  };

  return (
    <div
      className={`mascot-echo mascot-echo--${speech.tone}`}
      role="status"
      aria-live="polite"
      title={speech.agentId ? "Cliquer pour ouvrir l'agent" : "Cliquer pour fermer"}
      onClick={onClick}
    >
      <span className="mascot-echo-avatar" aria-hidden="true">
        <Chibi size={30} mood={mood} />
      </span>
      <span className="mascot-echo-text">{speech.text}</span>
    </div>
  );
}
