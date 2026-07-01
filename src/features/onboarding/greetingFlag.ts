// Shugu Forge — flag « rencontre avec Shugu » (S3), partagé greeting ↔ onboarding.
//
// Isolé dans son propre module pour éviter un import circulaire entre
// ShuguGreeting (qui pose le flag) et Onboarding (qui attend qu'il soit posé).
// Persisté dans db.settings, comme onboarding.dismissed.v1.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { db } from "@/lib/db";

export const GREETING_KEY = "onboarding.greeting.v1";
const GREETING_QUERY_KEY = ["onboarding", "greeting"] as const;

/**
 * État de la rencontre : `true` = déjà faite, `false` = à afficher, `null` =
 * encore en chargement (on ne rend rien pour éviter un flash).
 */
export function useGreetingDone(): boolean | null {
  const { data, isLoading } = useQuery({
    queryKey: GREETING_QUERY_KEY,
    queryFn: async () =>
      (await db.settings.get(GREETING_KEY).catch(() => null)) === "true",
    staleTime: Infinity,
  });
  return isLoading ? null : (data ?? false);
}

/** Marque la rencontre comme faite (persistant + cache TanStack immédiat). */
export async function markGreetingDone(): Promise<void> {
  try {
    await db.settings.set(GREETING_KEY, "true");
  } catch {
    // Best-effort : même si la persistance échoue, on ferme pour la session.
  }
  queryClient.setQueryData(GREETING_QUERY_KEY, true);
}
