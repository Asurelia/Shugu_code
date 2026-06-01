// src/features/cockpit/useCockpitFlag.ts
// Feature flag `ui.cockpit` (default OFF). Same db.settings + React Query
// pattern as the chat tool toggles, but ON only when the stored value is
// exactly "true" (a new feature defaults off).
import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/db";

export const COCKPIT_FLAG_KEY = "ui.cockpit";
const QK = ["settings", COCKPIT_FLAG_KEY] as const;

/** Reactive read (default OFF). */
export function useCockpitFlag(): boolean {
  const { data = false } = useQuery({
    queryKey: [...QK],
    queryFn: async () => (await db.settings.get(COCKPIT_FLAG_KEY)) === "true",
    staleTime: 30_000,
  });
  return data;
}
