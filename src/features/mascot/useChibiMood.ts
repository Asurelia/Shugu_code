// Shugu Forge — useChibiMood hook
//
// Encapsulates the mascot's facial-expression logic so the host component
// (FloatChat today, future swappable panels tomorrow) doesn't have to carry
// the mood state machine itself.
//
// Mood derivation priority (highest first):
//   1. edge-tucked    → peek_open  (unread reply waiting) | peek_closed (idle)
//   2. busy           → joy        (the model is generating)
//   3. !hasKey        → cry        (no provider configured)
//   4. pinnedAnno     → smile      (the user pinned a target for the chibi)
//   5. idleMs > 60s   → sad        (long idle, the chibi feels lonely)
//   6. idleMs < 10s
//      && hasMessages → smile      (fresh interaction)
//   7. default        → neutral
//
// Manual override (alt+click cycles through {neutral, smile, joy, sad, cry})
// wins over the derived value EXCEPT when edge-tucked — the peek pose is
// geometry, not expression, and must always reflect the panel position.
//
// Idle tracking lives in `@/features/mascot/idleStore` (module-scope) so any
// number of bump-sites (FloatShell, ChatPanel, future panels) share a single
// clock without prop drilling. `bumpInteract` exposed by this hook is just
// a re-export of the store's function — kept on the result for backwards-
// compatibility with the original API.

import { useMemo, useState, useCallback } from "react";
import type { ChibiMood } from "@/features/mascot/Chibi";
import { bumpInteract as bumpInteractStore, useIdleMs } from "@/features/mascot/idleStore";

const MOOD_CYCLE: ChibiMood[] = ["neutral", "smile", "joy", "sad", "cry"];
const LONELY_MS = 60_000;
const FRESH_MS = 10_000;

export interface UseChibiMoodInput {
  /** Edge identifier when the panel is tucked against a screen edge, otherwise null. */
  edge: string | null;
  /** A reply landed while the panel was tucked or closed. */
  hasUnread: boolean;
  /** The model is currently generating. */
  busy: boolean;
  /** At least one provider is configured (we can actually chat). */
  hasKey: boolean;
  /** A target is pinned for the chibi. Any truthy value triggers the smile mood. */
  pinnedAnno: unknown;
  /** Whether the active conversation contains at least one message. */
  hasMessages: boolean;
}

export interface UseChibiMoodResult {
  /** The mood to render — already accounts for override + edge precedence. */
  mood: ChibiMood;
  /** Cycles through MOOD_CYCLE on each call; reaches end → back to null (auto). */
  cycleMood: () => void;
  /** Forces the override back to null (auto-derived mood resumes). */
  resetMood: () => void;
  /** Call this from any user interaction handler to refresh the idle clock. */
  bumpInteract: () => void;
}

export function useChibiMood(input: UseChibiMoodInput): UseChibiMoodResult {
  const [override, setOverride] = useState<ChibiMood | null>(null);
  const idleMs = useIdleMs();

  const derivedMood: ChibiMood = useMemo(() => {
    if (input.edge) return input.hasUnread ? "peek_open" : "peek_closed";
    if (input.busy) return "joy";
    if (!input.hasKey) return "cry";
    if (input.pinnedAnno) return "smile";
    if (idleMs > LONELY_MS) return "sad";
    if (idleMs < FRESH_MS && input.hasMessages) return "smile";
    return "neutral";
  }, [input.edge, input.hasUnread, input.busy, input.hasKey, input.pinnedAnno, input.hasMessages, idleMs]);

  // Override is ignored while tucked — peek pose is geometry, not expression.
  const mood: ChibiMood = input.edge ? derivedMood : (override ?? derivedMood);

  const cycleMood = useCallback(() => {
    setOverride((curr) => {
      if (curr === null) return MOOD_CYCLE[0];
      const i = MOOD_CYCLE.indexOf(curr);
      if (i === MOOD_CYCLE.length - 1) return null;
      return MOOD_CYCLE[i + 1];
    });
  }, []);

  const resetMood = useCallback(() => setOverride(null), []);

  return { mood, cycleMood, resetMood, bumpInteract: bumpInteractStore };
}
