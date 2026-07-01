// Shugu Forge — mini-chibi vivante dans le Rail de l'IDE (S1a).
//
// Remonte la mascotte dans le chrome principal : l'avatar générique « SH » est
// remplacé par la chibi, dont l'humeur SUIT les mêmes réactions que la fenêtre
// flottante (useMoodReaction — cache TanStack alimenté par useAgentEvents, monté
// dans les DEUX fenêtres). Aucune nouvelle donnée cross-fenêtre : on AFFICHE
// simplement un état déjà présent dans le cache de la fenêtre IDE.
//
// Clic → ouvre « Profil de Shugu » (Réglages). Le bouton compte reste sur la
// Titlebar, donc rien n'est perdu.

import { Chibi } from "./Chibi";
import { useMoodReaction } from "./moodReactionStore";
import { useActiveAgents } from "@/features/agents/queries";
import { railMood, railStatus } from "./railMood";

export function RailChibi({ onClick }: { onClick?: () => void }) {
  const reaction = useMoodReaction();
  const { data: agents = [] } = useActiveAgents();
  const busy = agents.length > 0;
  const mood = railMood(reaction, busy);
  const status = railStatus(agents.length);

  return (
    <button
      type="button"
      className="rail-avatar rail-chibi"
      aria-label={`Profil de Shugu — ${status}`}
      title={status}
      onClick={onClick}
    >
      <Chibi size={26} mood={mood} />
      {busy && <span className="rail-chibi-badge" aria-hidden="true" />}
    </button>
  );
}
