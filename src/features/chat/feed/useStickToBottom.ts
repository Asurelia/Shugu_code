// Shugu Forge — useStickToBottom : auto-scroll RESPECTUEUX du fil de chat.
//
// Avant : chaque delta de streaming forçait `scrollTop = scrollHeight`, donc
// remonter lire un ancien message pendant une génération renvoyait aussitôt
// l'utilisateur en bas (scroll volé). Ce hook n'auto-scrolle QUE si
// l'utilisateur est déjà « collé » au bas (à STICK_THRESHOLD px près) ; dès
// qu'il remonte, on le laisse tranquille jusqu'à ce qu'il redescende.
//
// Partagé entre les DEUX feeds (chat cockpit `views-chat` et chat mascotte
// `ChatPanel`) — le bug existait des deux côtés, le correctif est mutualisé
// (politique « logique commune, styles divergents »), pas dupliqué une 3ᵉ fois.

import { useCallback, useEffect, useRef, useState } from "react";

/** Distance au bas (px) en-deçà de laquelle on considère l'utilisateur « collé ». */
const STICK_THRESHOLD = 80;

export interface StickToBottom {
  /** À poser sur le conteneur scrollable : `<div ref={ref} onScroll={onScroll}>`. */
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** true quand l'utilisateur a remonté (→ afficher un bouton « ↓ » optionnel). */
  isPinnedAway: boolean;
  /** Force le retour en bas + recolle (clic sur le bouton « ↓ »). */
  scrollToBottom: () => void;
}

/**
 * `deps` = les valeurs qui, en changeant, doivent (peut-être) déclencher un
 * auto-scroll : longueur des messages, texte de streaming, indicateur de saisie…
 * L'auto-scroll ne s'exécute que si l'utilisateur était collé au bas.
 */
export function useStickToBottom(deps: unknown[]): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null);
  const stuckRef = useRef(true); // collé au bas par défaut (nouvelle conversation)
  const [isPinnedAway, setIsPinnedAway] = useState(false);

  const recompute = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const stuck = distance <= STICK_THRESHOLD;
    stuckRef.current = stuck;
    setIsPinnedAway(!stuck);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setIsPinnedAway(false);
  }, []);

  // Auto-scroll UNIQUEMENT si l'utilisateur est collé au bas.
  useEffect(() => {
    if (stuckRef.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ref, onScroll: recompute, isPinnedAway, scrollToBottom };
}
