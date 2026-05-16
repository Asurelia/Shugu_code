// Shugu Forge — useFloatMode hook
//
// Tiny state machine for the float panel's visibility:
//   - "closed"   → only the chibi is visible (no panel, no speech)
//   - "compact"  → chibi + composer (no history)
//   - "full"     → chibi + history + tabs + composer
//
// Extracted from FloatChat as a separate concern so future shells (TaskPanel,
// AgentLog, ...) can reuse the same closed/compact/full vocabulary without
// duplicating the toggles.

import { useState, useCallback } from "react";

export type FloatMode = "closed" | "compact" | "full";

export interface UseFloatModeResult {
  mode: FloatMode;
  setMode: (m: FloatMode | ((prev: FloatMode) => FloatMode)) => void;
  /** Single-click toggle: closed <-> compact. No-op on full (matches FloatChat behavior). */
  toggleClosed: () => void;
  /** Double-click toggle: compact <-> full. */
  toggleFull: () => void;
}

export function useFloatMode(initial: FloatMode = "compact"): UseFloatModeResult {
  const [mode, setMode] = useState<FloatMode>(initial);

  const toggleClosed = useCallback(() => {
    setMode(m => (m === "closed" ? "compact" : "closed"));
  }, []);

  const toggleFull = useCallback(() => {
    setMode(m => (m === "full" ? "compact" : "full"));
  }, []);

  return { mode, setMode, toggleClosed, toggleFull };
}
