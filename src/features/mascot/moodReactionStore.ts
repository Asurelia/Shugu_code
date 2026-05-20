// Shugu Forge — Lot 6 — store de réaction d'humeur (TanStack, comme idleStore).
//
// fireMoodReaction(event) pose une ActiveReaction dans le cache + programme son
// auto-effacement après le TTL (pas de tick périodique : l'effacement notifie
// les subscribers → l'humeur revient à la dérivée). useMoodReaction lit la
// réaction courante de façon réactive (re-render sur fire ET sur expire).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { reactionFor, type MoodEvent, type ActiveReaction } from "./moodReactions";

const REACTION_KEY = ["mascot", "reaction"] as const;

/** Déclenche une réaction d'humeur transitoire (fire-and-forget). */
export function fireMoodReaction(event: MoodEvent): void {
  const r = reactionFor(event);
  const firedAt = Date.now();
  queryClient.setQueryData<ActiveReaction>(REACTION_KEY, {
    mood: r.mood,
    firedAt,
    ttlMs: r.ttlMs,
  });
  // Auto-efface après le TTL — mais SEULEMENT si aucune réaction plus récente
  // n'a pris la place entre-temps (comparaison par firedAt). Ainsi un nouvel
  // événement n'est pas effacé par le timer d'un ancien.
  setTimeout(() => {
    const cur = getMoodReaction();
    if (cur && cur.firedAt === firedAt) {
      queryClient.setQueryData<ActiveReaction | null>(REACTION_KEY, null);
    }
  }, r.ttlMs);
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
