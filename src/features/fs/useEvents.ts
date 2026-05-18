// Shugu Forge — Tauri event listener pour la feature fs.
//
// Une seule responsabilité : listen `fs://changed` (broadcast par le
// watcher Rust avec debounce 200ms) → invalidate le cache tree pour
// déclencher un refetch via `useFileTree`.
//
// Mount ce hook UNE FOIS au root (RootLayout). La mascotte n'a pas
// besoin du file tree.

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@/lib/tauri";
import { diag } from "@/lib/diag";
import { fsKeys } from "./keys";
import { invalidateGrep } from "@/features/code/grep/queries";

export function useFsEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    diag("fs-events", "HOOK MOUNTED");

    void (async () => {
      try {
        unlisten = await listen<void>("fs://changed", () => {
          if (cancelled) return;
          diag("fs-events", "fs://changed → invalidate tree + grep");
          void qc.invalidateQueries({ queryKey: fsKeys.tree() });
          // LOT 2 — les résultats grep sont caches par (query, opts) avec
          // staleTime 30s ; un changement fs les rend obsolètes (path
          // ajouté, ligne déplacée). Invalidate explicite après tree.
          invalidateGrep();
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
  }, [qc]);
}
