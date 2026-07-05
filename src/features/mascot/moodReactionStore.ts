// Shugu Forge — Lot 6 — store de réaction d'humeur (TanStack, comme idleStore).
//
// fireMoodReaction(event) pose une ActiveReaction dans le cache + programme son
// auto-effacement après le TTL (pas de tick périodique : l'effacement notifie
// les subscribers → l'humeur revient à la dérivée). useMoodReaction lit la
// réaction courante de façon réactive (re-render sur fire ET sur expire).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { reactionFor, type MoodEvent, type ActiveReaction } from "./moodReactions";
import type { ChibiMood } from "./Chibi";

const REACTION_KEY = ["mascot", "reaction"] as const;

/**
 * Pose une expression DIRECTE (hors table d'événements) avec auto-effacement.
 * Utilisé par la couche affective de la voix : l'émotion effective (dérivée en
 * Palier 1, choisie par le LLM en Palier 2) pilote la MÊME ActiveReaction que
 * les événements, donc voix et visage restent synchronisés. TTL par défaut
 * calé sur la durée d'une lecture vocale courte.
 */
export function fireMoodDirect(mood: ChibiMood, ttlMs = 4000): void {
  const firedAt = Date.now();
  queryClient.setQueryData<ActiveReaction>(REACTION_KEY, { mood, firedAt, ttlMs });
  // Auto-efface après le TTL — mais SEULEMENT si aucune réaction plus récente
  // n'a pris la place entre-temps (comparaison par firedAt). Ainsi un nouvel
  // événement n'est pas effacé par le timer d'un ancien.
  setTimeout(() => {
    const cur = getMoodReaction();
    if (cur && cur.firedAt === firedAt) {
      queryClient.setQueryData<ActiveReaction | null>(REACTION_KEY, null);
    }
  }, ttlMs);
}

/** Déclenche une réaction d'humeur transitoire depuis un événement (fire-and-forget). */
export function fireMoodReaction(event: MoodEvent): void {
  const r = reactionFor(event);
  fireMoodDirect(r.mood, r.ttlMs);
}

/** Lecture non-réactive (snapshot ponctuel). */
export function getMoodReaction(): ActiveReaction | null {
  return queryClient.getQueryData<ActiveReaction>(REACTION_KEY) ?? null;
}

/** Hook réactif : la réaction courante (ou null). Re-render au fire + à l'expire. */
export function useMoodReaction(): ActiveReaction | null {
  const { data = null } = useQuery<ActiveReaction | null>({
    queryKey: REACTION_KEY,
    queryFn: () => getMoodReaction(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
