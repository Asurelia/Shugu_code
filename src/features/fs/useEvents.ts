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

export function useFsEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    diag("fs-events", "HOOK MOUNTED");

    void (async () => {
      try {
        unlisten = await listen<void>("fs://changed", () => {
          if (cancelled) return;
          diag("fs-events", "fs://changed → invalidate dir + scoped + grep + git");
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
      unlisten?.();
    };
  }, []);
}
