// Shugu Forge — Tauri event listener pour la feature fs.
//
// Une seule responsabilité : listen `fs://changed` (broadcast par le
// watcher Rust avec debounce 200ms) → invalidate le cache tree pour
// déclencher un refetch via `useFileTree`.
//
// Mount ce hook UNE FOIS au root (RootLayout). La mascotte n'a pas
// besoin du file tree.

import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import { diag } from "@/lib/diag";
import { invalidateDirChildren } from "./queries";
import { invalidateGrep } from "@/features/code/grep/queries";
import { invalidateAllGit } from "@/features/git/queries";

// Trailing debounce des invalidations. Le watcher Rust débounce déjà à
// 200 ms par RAFALE d'écritures, mais un agent qui écrit en continu émet
// donc un event toutes les ~200 ms → refetch dir + grep + git 5×/s pendant
// toute la durée du run. Le trailing 500 ms collapse la tempête en ≤2
// invalidations/s ; la fraîcheur de l'explorateur est retardée d'au plus
// ~700 ms après la DERNIÈRE écriture — imperceptible, aucun consommateur
// ne dépend du timing exact de l'event (tout passe par le cache TanStack).
const INVALIDATE_DEBOUNCE_MS = 500;

export function useFsEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    diag("fs-events", "HOOK MOUNTED");

    const invalidateAll = () => {
      timer = null;
      if (cancelled) return;
      diag("fs-events", "fs://changed (debounced) → invalidate dir + scoped + grep + git");
      // Niveaux lazy de l'explorateur (`fsKeys.dir`) + sous-arbres scoped
      // Studio (`fsKeys.scoped`) — refetch des dossiers/preview ouverts
      // seulement ; l'état d'expansion vit dans SideFiles. (L'ancien
      // `fsKeys.tree()` complet a disparu avec le lazy-load.)
      invalidateDirChildren();
      // LOT 2 — les résultats grep sont caches par (query, opts) avec
      // staleTime 30s ; un changement fs les rend obsolètes (path
      // ajouté, ligne déplacée). Invalidate explicite après tree.
      invalidateGrep();
      // LOT 3 — un checkout, reset, ou commit externe change le contenu
      // HEAD. Over-invalidation acceptable (R12 du plan) : mieux
      // re-fetcher que d'afficher des décorations périmées.
      invalidateAllGit();
    };

    void (async () => {
      try {
        unlisten = await listen<void>("fs://changed", () => {
          if (cancelled) return;
          if (timer !== null) clearTimeout(timer);
          timer = setTimeout(invalidateAll, INVALIDATE_DEBOUNCE_MS);
        });
        diag("fs-events", "LISTEN ATTACHED");
      } catch (err) {
        diag("fs-events", `LISTEN ATTACH FAILED: ${String(err)}`);
      }
      if (cancelled) {
        unlisten?.();
        unlisten = null;
      }
    })();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unlisten?.();
    };
  }, []);
}
