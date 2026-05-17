// Shugu Forge — TanStack QueryClient singleton.
//
// Exporté comme module-level constant pour TROIS raisons :
//   1. Le QueryClientProvider de main.tsx attend une instance — il prend
//      celle-ci.
//   2. Les helpers hors-React (chat-sync.ts, lib/agents.ts, listeners
//      Tauri attachés en setup) ont besoin de faire
//      `queryClient.invalidateQueries(...)` ou `queryClient.setQueryData(...)`
//      sans accès au Context.
//   3. Garantit qu'il n'existe qu'UNE instance pour toute l'app — pas de
//      désync entre cache React et state hors-React.
//
// Tout state externe à un composant unique (data fetching, Tauri event
// listeners, flags globaux, caches) doit transiter par cette instance.
// Plus aucun Zustand store, plus aucun subscriber/publisher manuel.

import { QueryClient } from "@tanstack/react-query";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // staleTime: 30s — les queries restent "fresh" 30s avant un refetch
      // automatique sur remount. Cohérent avec l'ancien default inline de
      // main.tsx. Les features qui veulent une donnée toujours fraîche
      // (live agents, streaming messages) override avec staleTime: 0.
      staleTime: 30_000,
      // refetchOnWindowFocus: false — Tauri n'a pas de notion claire de
      // "window focus" (la mascotte est always-on-top, focus se déplace
      // constamment). Désactivé pour éviter des refetchs surprise. Les
      // invalidations explicites via Tauri events restent le mécanisme
      // principal de mise à jour.
      refetchOnWindowFocus: false,
      // retry: 1 — un seul retry sur échec. Les commands Tauri qui
      // échouent vraiment (workspace closed, model invalid) n'iront pas
      // mieux au 2ᵉ essai ; le 1 retry couvre juste les races/flaps.
      retry: 1,
      // gcTime: 24h — TanStack garde les queries inactives en cache 24h
      // avant de les GC. Nécessaire pour que le PersistQueryClientProvider
      // puisse rehydrater le cache au prochain boot avec des données
      // potentiellement vieilles (la query elle-même refetch si stale).
      gcTime: 24 * 60 * 60 * 1000,
    },
  },
});

// Persister LocalStorage — remplace Zustand `persist` middleware sans
// store custom. PersistQueryClientProvider sauvegarde le cache complet
// du QueryClient en localStorage sous une clé unique, et le restaure au
// prochain boot. Les queries qui veulent être persistées (ex. discovery
// results) ont juste à exister dans le cache ; aucune annotation requise.
// Les queries qui ne doivent PAS être persistées (sensibles, volatiles)
// peuvent être filtrées via `dehydrateOptions.shouldDehydrateQuery`.
export const queryPersister = createSyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
  key: "shugu.tanstack-cache.v1",
  throttleTime: 1000,
});
