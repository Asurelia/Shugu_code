// Shugu Forge — mascot idle tracker (TanStack-backed).
//
// Tracks the timestamp of the user's most recent interaction so the chibi's
// mood can transition to `sad` (long idle) or `smile` (fresh interaction).
//
// Multiple sites call bumpInteract():
//   - FloatShell on avatar click / drag (panel-agnostic interactions)
//   - ChatPanel on send / loadConvo / newConvo (chat-flavored interactions)
//   - Future panels (TaskPanel, AgentLog, ...) on their own actions
//
// Refactor 2026-05-17 : ancien store custom (subscribers manuel + setInterval
// dans useIdleMs) → TanStack Query avec setQueryData + refetchInterval. Le
// "tick 5s" devient un refetchInterval natif, qui re-évalue la query toutes
// les 5s et déclenche les consumers à se rafraîchir.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

const LAST_INTERACT_KEY = ["mascot", "lastInteract"] as const;

// Initialise au boot — utile pour la première lecture avant tout bump.
queryClient.setQueryData<number>(LAST_INTERACT_KEY, Date.now());

/** Marque une interaction utilisateur. Met à jour la timestamp et
 *  notifie tous les useIdleMs consumers. */
export function bumpInteract(): void {
  queryClient.setQueryData<number>(LAST_INTERACT_KEY, Date.now());
}

/** Lecture non-réactive (utilisée par les helpers hors-React, e.g. les
 *  mood derivations qui font un snapshot ponctuel). */
export function getLastInteract(): number {
  return queryClient.getQueryData<number>(LAST_INTERACT_KEY) ?? Date.now();
}

/** Hook réactif retournant les ms depuis la dernière interaction.
 *
 *  Tick toutes les 5s via `refetchInterval` — quand la query "refetch",
 *  son queryFn retourne `Date.now()` (le "now" courant) et la diff est
 *  recalculée dans le composant qui consomme.
 *
 *  L'astuce : on stocke `lastInteract` via setQueryData, mais le hook
 *  expose `useIdleMs()` qui re-évalue à chaque tick. Le tick est interne
 *  à TanStack — pas de setInterval à clean dans un useEffect, pas de
 *  subscriber custom. */
export function useIdleMs(): number {
  // Cette query trace `Date.now()` mais on l'utilise juste comme un timer
  // qui force le composant à re-rendre toutes les 5s. La valeur retournée
  // sert juste de "frame number" — la vraie info vient de getLastInteract().
  useQuery<number>({
    queryKey: ["mascot", "tick"],
    queryFn: () => Date.now(),
    refetchInterval: 5_000,
    staleTime: 0,
  });
  // Lis lastInteract en réactif aussi pour que bumpInteract() trigger un
  // refresh immédiat (sans attendre le prochain tick 5s).
  const { data: last } = useQuery<number>({
    queryKey: LAST_INTERACT_KEY,
    queryFn: () => getLastInteract(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return Date.now() - (last ?? Date.now());
}
