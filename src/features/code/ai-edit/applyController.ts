// Shugu Forge — Lot 2 (Apply-to-file) — requête d'apply + runner view-level.
//
// applyCodeToFile (RootLayout) pose une ApplyRequest dans le cache TanStack
// après avoir ouvert + activé le fichier cible. useApplyRunner (monté dans
// CodeView) attend que la view CodeMirror du fichier cible soit prête, puis
// démarre le diff via startApply. Découplage volontaire : l'ouverture de
// fichier est cross-route (RootLayout, a openFile + navigate), le démarrage
// du diff est view-level (CodeView, a la view montée).

import { useEffect, useRef, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { AI_APPLY_KEY, type ApplyRequest } from "./types";
import { startApply, useAiEditSession } from "./aiEditController";
import type { CodeMirrorEditorHandle } from "@/features/code/CodeMirrorEditor";
import type { FileContent } from "@/lib/types";

/** Pose (ou efface avec null) la requête d'apply dans le cache. */
export function setApplyRequest(req: ApplyRequest | null): void {
  queryClient.setQueryData<ApplyRequest | null>(AI_APPLY_KEY, req ?? null);
}

function getApplyRequest(): ApplyRequest | null {
  return queryClient.getQueryData<ApplyRequest | null>(AI_APPLY_KEY) ?? null;
}

/** Lecture réactive de la requête (pour le runner). */
export function useApplyRequest(): ApplyRequest | null {
  const { data = null } = useQuery<ApplyRequest | null>({
    queryKey: AI_APPLY_KEY,
    queryFn: () => getApplyRequest(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

// Combien de frames on attend la view du fichier cible avant d'abandonner.
// ~2s à 60fps : couvre openFile (lecture disque) + mount CodeMirror sans
// risquer une boucle infinie si quelque chose tourne mal.
const MAX_WAIT_FRAMES = 120;

export interface ApplyRunnerArgs {
  activeFile: string | null;
  editorViewRef?: RefObject<CodeMirrorEditorHandle>;
  fileContents: Record<string, FileContent | undefined>;
}

/**
 * Surveille la requête d'apply. Quand le fichier cible est devenu actif et que
 * sa view CodeMirror porte bien son contenu, démarre le diff (startApply) puis
 * vide la requête. Poll borné en rAF pour attendre le mount de la view (la
 * view est recréée via key={activeFile} au changement de fichier).
 */
export function useApplyRunner({ activeFile, editorViewRef, fileContents }: ApplyRunnerArgs): void {
  const request = useApplyRequest();
  const session = useAiEditSession();
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!request) return;
    // On n'agit que lorsque le fichier cible est devenu actif (RootLayout l'a
    // ouvert + activé). Sinon on attend le prochain render (activeFile change).
    if (request.path !== activeFile) return;
    // Une session d'édition inline (Cmd+K / refactor / fix / apply précédent)
    // est en cours : on NE clobbe PAS. La requête reste en attente ; cet effet
    // est ré-exécuté quand session.status redevient "idle" (dépendance) → l'apply
    // se déclenche dès que l'édit courant est accepté/rejeté. Pas de drop muet.
    if (session.status !== "idle") return;

    let frames = 0;
    const tick = () => {
      rafRef.current = null;
      // La requête a pu être annulée / remplacée entre deux frames.
      if (getApplyRequest() !== request) return;
      const view = editorViewRef?.current?.getView() ?? null;
      const loaded = fileContents[request.path];
      // Prête = view montée ET portant le contenu du fichier cible (pas une
      // view stale d'un fichier précédent ni un fichier pas encore chargé).
      // ⚠ Égalité exacte de chaînes : si un jour fsReadFile normalise les fins
      // de ligne (CRLF→LF) alors que la view garde CRLF (ou l'inverse), ce
      // test ne matcherait jamais → timeout silencieux. La stack Lot 1 ne
      // normalise pas aujourd'hui, donc OK ; à revoir si ça change.
      const ready = view != null && loaded != null && view.state.doc.toString() === loaded.text;
      if (ready && view) {
        const started = startApply(view, {
          path: request.path,
          proposedText: request.text,
          lang: request.lang,
          wasDirty: loaded?.dirty ?? false,
        });
        // started === false → une session est apparue entre le gate et ce tick
        // (course rare). On garde la requête : l'effet ré-exécutera à la
        // prochaine transition de session.status.
        if (started) setApplyRequest(null);
        return;
      }
      if (frames++ < MAX_WAIT_FRAMES) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        console.warn("[useApplyRunner] view for", request.path, "never became ready — dropping apply");
        setApplyRequest(null);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [request, activeFile, session.status, editorViewRef, fileContents]);
}
