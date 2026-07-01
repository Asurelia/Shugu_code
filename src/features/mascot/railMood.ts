// Shugu Forge — logique pure de la mini-chibi du Rail (S1a), isolée pour les tests.
//
// railMood réutilise effectiveMood (déjà éprouvé) : base = joy si un agent
// tourne, sinon neutral ; une réaction transitoire non expirée prime.

import { effectiveMood, type ActiveReaction } from "./moodReactions";
import type { ChibiMood } from "./Chibi";

/** Humeur de la mini-chibi du Rail (pure ; `now` injectable pour les tests). */
export function railMood(
  reaction: ActiveReaction | null,
  busy: boolean,
  now: number = Date.now(),
): ChibiMood {
  return effectiveMood(busy ? "joy" : "neutral", reaction, now);
}

/** Libellé de statut (tooltip + aria) dérivé du nombre d'agents actifs. */
export function railStatus(activeCount: number): string {
  if (activeCount <= 0) return "Shugu";
  return `${activeCount} agent${activeCount > 1 ? "s" : ""} actif${activeCount > 1 ? "s" : ""}`;
}
