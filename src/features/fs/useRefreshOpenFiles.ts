// Shugu Forge — Auto-refresh des fichiers ouverts sur fs://changed.
//
// Smoke test fix : avant ce hook, modifier un fichier depuis un éditeur
// externe (VS Code, vim, etc.) pendant que Shugu l'avait ouvert ne mettait
// PAS à jour le contenu de l'éditeur — il fallait Ctrl+R pour voir les
// modifications. Le watcher Rust émettait bien fs://changed, useFsEvents
// invalidait fsKeys.tree(), mais le tree (liste de fichiers) ne contenait
// rien de nouveau et fileContents (state local RootLayout, pas TanStack)
// gardait l'ancien texte.
//
// Ce hook attache son propre listener fs://changed et re-read chaque open
// file (qui n'est PAS dirty) pour le synchroniser avec le disque. Si le
// fichier est dirty (modifications non sauvegardées dans Shugu), on
// préserve le travail de l'utilisateur — last-write-wins est ce qu'on veut.
//
// IMPORTANT : ce hook PREND ses paramètres en arguments (pas via useShell).
// Pourquoi : il est appelé DEPUIS RootLayout, qui EST le composant qui
// fournit `ShellContext.Provider`. À ce moment du render de RootLayout,
// le Provider n'est pas encore dans l'arbre React, donc useShell() throw
// "useShell must be used inside RootLayout". Le pattern correct est de
// laisser RootLayout passer les valeurs directes.

import { useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listen } from "@/lib/tauri";
import { fsReadFile } from "@/lib/fs";
import { diag } from "@/lib/diag";

interface FileContent {
  text: string;
  dirty?: boolean;
  lang?: string;
  [k: string]: unknown;
}

export function useRefreshOpenFiles(
  openFiles: string[],
  fileContents: Record<string, FileContent>,
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>,
): void {
  // Refs pour lire la dernière valeur dans le handler sans re-attacher
  // le listener à chaque change (un re-attach par keystroke serait
  // catastrophique en perf et causerait des doublons d'écoute briefs).
  const openFilesRef = useRef(openFiles);
  const fileContentsRef = useRef(fileContents);
  openFilesRef.current = openFiles;
  fileContentsRef.current = fileContents;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        // Capture-then-check pattern (fix listener orphan reviewer LOT 3
        // smoke) : si le component démonte AVANT que listen() résolve
        // (cas HMR Vite ou error boundary), le cleanup return du useEffect
        // a déjà run avec unlisten=null ; on doit donc unsubscribe
        // immédiatement le listener qu'on vient d'attacher.
        const u = await listen<void>("fs://changed", async () => {
          if (cancelled) return;
          // Snapshot pour éviter de courir après des modifs concurrentes.
          const paths = [...openFilesRef.current];
          const contents = fileContentsRef.current;
          for (const path of paths) {
            const current = contents[path];
            if (!current || current.dirty) continue; // dirty = ne pas écraser
            try {
              const fresh = await fsReadFile(path);
              if (fresh.text === current.text) continue; // pas de change
              // Update : préserve les autres champs (lang, dirty=false…).
              // Re-vérifie via setState functional form que le fichier
              // n'est pas devenu dirty entre le read et l'update (race
              // si user édite pendant le re-read).
              setFileContents((c) => {
                const latest = c[path];
                if (!latest || latest.dirty) return c; // skip
                return { ...c, [path]: { ...latest, text: fresh.text } };
              });
              diag("fs-refresh", `reloaded ${path} (external edit detected)`);
            } catch (err) {
              // Fichier supprimé/renommé depuis : on garde l'ancien
              // contenu côté UI ; le prochain Ctrl+S de l'utilisateur
              // re-créera le fichier (ou échouera avec un message clair).
              diag("fs-refresh", `read failed for ${path}: ${String(err)}`);
            }
          }
        });
        if (cancelled) {
          // Démontage survenu avant que listen() ait résolu — on détache
          // le listener qu'on vient d'attacher pour éviter le leak.
          u();
        } else {
          unlisten = u;
        }
      } catch (err) {
        diag("fs-refresh", `attach failed: ${String(err)}`);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // setFileContents est stable (setter useState) — dépendance unique pour
    // éviter le re-attach à chaque change de openFiles/fileContents (qui
    // sont lus via refs).
  }, [setFileContents]);
}
