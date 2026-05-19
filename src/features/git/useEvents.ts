// Shugu Forge — Tauri event listener pour la feature git.
//
// Une seule responsabilité : listen `git://changed` (broadcast par
// `commands/git_watcher.rs` avec debounce 300ms sur `.git/HEAD`,
// `.git/index`, `.git/refs/heads/*`, `.git/refs/remotes/*`,
// `.git/MERGE_HEAD`, `.git/ORIG_HEAD`) → invalidate l'ensemble du cache
// git (status, branches, log, blame, stashes, remotes, head).
//
// Sur `fs://changed`, `useFsEvents` invalide DÉJÀ tout le git (cf.
// `src/features/fs/useEvents.ts:38`). Le présent hook capture les
// opérations git pures qui n'écrivent dans aucun fichier surveillé par
// `fs://changed` (e.g. `git fetch` qui ne touche que `.git/refs/remotes/`,
// que le fs watcher est configuré pour ignorer).
//
// Mount ce hook UNE FOIS au root (RootLayout). La mascotte n'a pas
// besoin d'observer le repo git.

import { useEffect } from "react";
import { listen } from "@/lib/tauri";
import { diag } from "@/lib/diag";
import { invalidateAllGit } from "./queries";

export function useGitEvents(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    diag("git-events", "HOOK MOUNTED");

    void (async () => {
      try {
        unlisten = await listen<void>("git://changed", () => {
          if (cancelled) return;
          diag("git-events", "git://changed → invalidateAllGit");
          invalidateAllGit();
        });
        diag("git-events", "LISTEN ATTACHED");
      } catch (err) {
        diag("git-events", `LISTEN ATTACH FAILED: ${String(err)}`);
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
