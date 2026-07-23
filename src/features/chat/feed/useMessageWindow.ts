// Shugu Forge — useMessageWindow : rendu incrémental des longues listes.
//
// Une conversation de 500 messages rendait 500 nœuds DOM d'un coup (markdown,
// images, blocs outils) → montée mémoire + jank à l'ouverture. Plutôt qu'une
// virtualisation (inadaptée : hauteurs variables markdown/images), on ne rend
// que les N DERNIERS éléments + un bouton « afficher les précédents » qui
// agrandit la fenêtre par paliers. Partagé entre le chat cockpit, le chat
// mascotte et l'historique des conversations (politique « logique commune »).
//
// Préservation du scroll : charger des éléments PLUS ANCIENS en tête pousse le
// contenu visible vers le bas. On mesure `scrollHeight` avant l'agrandissement
// et on réajuste `scrollTop` juste après (useLayoutEffect) pour que l'élément
// que l'utilisateur regardait ne bouge pas d'un pixel. `scrollRef` est optionnel
// (l'historique, court et en lecture, n'en a pas besoin).

import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface MessageWindow<T> {
  /** Les éléments à rendre (les `limit` derniers de `items`). */
  windowed: T[];
  /** Combien d'éléments plus anciens restent masqués. */
  hiddenCount: number;
  /** Agrandit la fenêtre d'un palier (ancre le scroll si `scrollRef` fourni). */
  showMore: () => void;
}

export function useMessageWindow<T>(
  items: T[],
  opts?: {
    /** Réinitialise la fenêtre quand cette clé change (ex. convId). */
    resetKey?: string | null;
    /** Taille initiale de la fenêtre (défaut 60). */
    initial?: number;
    /** Palier d'agrandissement (défaut 40). */
    page?: number;
    /** Conteneur scrollable — pour préserver la position à l'agrandissement. */
    scrollRef?: React.RefObject<HTMLElement | null>;
  },
): MessageWindow<T> {
  const initial = opts?.initial ?? 60;
  const page = opts?.page ?? 40;
  const [limit, setLimit] = useState(initial);

  // Reset à l'initial quand on change de conversation.
  const prevKey = useRef(opts?.resetKey);
  if (prevKey.current !== opts?.resetKey) {
    prevKey.current = opts?.resetKey;
    // setState pendant le render est autorisé par React quand il est gardé
    // (ici : uniquement au changement de clé) — évite un flash de la 2ᵉ frame.
    if (limit !== initial) setLimit(initial);
  }

  // Ancre mémorisée entre le clic « afficher plus » et le re-render suivant.
  const anchorRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = opts?.scrollRef?.current;
    if (el && anchorRef.current != null) {
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
    }
  }, [limit, opts?.scrollRef]);

  const showMore = useCallback(() => {
    const el = opts?.scrollRef?.current;
    if (el) anchorRef.current = el.scrollHeight;
    setLimit((l) => l + page);
  }, [page, opts?.scrollRef]);

  const start = Math.max(0, items.length - limit);
  return {
    windowed: start > 0 ? items.slice(start) : items,
    hiddenCount: start,
    showMore,
  };
}
