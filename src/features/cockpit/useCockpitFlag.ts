// src/features/cockpit/useCockpitFlag.ts
// Feature flag `ui.cockpit` — défaut ON depuis le 2026-06-10 (lots C1-C4
// livrés, bascule par défaut décidée par l'utilisateur). Même db.settings +
// React Query pattern que les chat tool toggles : OFF seulement quand la
// valeur stockée est exactement "false" (le toggle Réglages → Interface
// permet de revenir à l'ancien shell).
import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/db";

export const COCKPIT_FLAG_KEY = "ui.cockpit";
const QK = ["settings", COCKPIT_FLAG_KEY] as const;

/** Reactive read (default ON — absent = ON, OFF only when stored "false"). */
export function useCockpitFlag(): boolean {
  const { data = true } = useQuery({
    queryKey: [...QK],
    queryFn: async () => (await db.settings.get(COCKPIT_FLAG_KEY)) !== "false",
    staleTime: 30_000,
  });
  return data;
}
