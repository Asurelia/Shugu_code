// Shugu Forge — Lot 6 — réactions d'humeur transitoires de la mascotte.
//
// useChibiMood DÉRIVE déjà une humeur d'états continus (busy→joy, !hasKey→cry,
// idle→sad…). Ce module ajoute des réactions ÉVÉNEMENTIELLES transitoires : un
// agent qui finit, un edit accepté, une erreur → l'humeur saute brièvement vers
// une expression puis revient à la dérivée après un TTL. Logique pure + testée ;
// le store (moodReactionStore) gère la diffusion + l'auto-expiration.

import type { ChibiMood } from "./Chibi";

/** Événements qui déclenchent une réaction d'humeur transitoire. */
export type MoodEvent =
  | "agent-start"
  | "agent-complete"
  | "agent-error"
  | "edit-accept"
  | "edit-reject"
  | "edit-error"
  | "chat-error";

export interface MoodReaction {
  mood: ChibiMood;
  ttlMs: number;
}

// Mapping événement → (humeur, durée). Les célébrations sont brèves, les
// erreurs durent un peu plus (l'utilisateur doit remarquer la détresse).
const REACTIONS: Record<MoodEvent, MoodReaction> = {
  "agent-start": { mood: "joy", ttlMs: 2500 },
  "agent-complete": { mood: "joy", ttlMs: 4000 },
  "agent-error": { mood: "cry", ttlMs: 5000 },
  "edit-accept": { mood: "smile", ttlMs: 3000 },
  "edit-reject": { mood: "neutral", ttlMs: 1500 },
  "edit-error": { mood: "cry", ttlMs: 4000 },
  "chat-error": { mood: "cry", ttlMs: 4000 },
};

/** Réaction associée à un événement (pure, table figée). */
export function reactionFor(event: MoodEvent): MoodReaction {
  return REACTIONS[event];
}

/** Une réaction active : humeur + instant de déclenchement + durée. */
export interface ActiveReaction {
  mood: ChibiMood;
  firedAt: number;
  ttlMs: number;
}

/** Vrai tant que la réaction n'a pas expiré à l'instant `now`. */
export function isReactionActive(reaction: ActiveReaction | null, now: number): boolean {
  return reaction != null && now - reaction.firedAt < reaction.ttlMs;
}

/**
 * Humeur effective : une réaction non expirée prime sur l'humeur de base
 * (dérivée). Sinon on retombe sur la base. Pur — c'est le cœur testable.
 */
export function effectiveMood(
  base: ChibiMood,
  reaction: ActiveReaction | null,
  now: number,
): ChibiMood {
  return isReactionActive(reaction, now) ? (reaction as ActiveReaction).mood : base;
}
