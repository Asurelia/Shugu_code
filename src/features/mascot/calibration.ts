// Shugu Forge — chibi-snap calibration (shared module).
//
// Single source of truth for the 4 geometric offsets that the mascot
// window's snap algorithm uses. Persisted in localStorage so the user's
// tuning survives app restarts; broadcast cross-window via the standard
// `storage` event (Tauri 2 webviews under the same origin share
// localStorage AND fire `storage` events to one another).
//
// Architecture: the settings panel in the MAIN IDE window writes to
// localStorage; the MASCOT window subscribes to changes and re-renders.
// No Tauri event needed — the browser primitive does the cross-window
// hop for us.

export interface ChibiCalibration {
  /** chibi visible LEFT pixel relative to cluster.left (CSS px) */
  left: number;
  /** chibi visible RIGHT pixel relative to cluster.left (CSS px) */
  right: number;
  /** chibi visible TOP (head) pixel relative to cluster.top (CSS px) */
  top: number;
  /** chibi visible BOTTOM (feet) pixel relative to cluster.top (CSS px) */
  bottom: number;
  /** screen-edge snap activation distance, CSS px */
  snapThreshold: number;
}

/** Defaults derived from the M2/M3-v6 alpha-scan of the chibi PNGs. */
export const DEFAULT_CALIBRATION: ChibiCalibration = {
  left: 32,
  right: 124,
  top: 19,
  bottom: 156,
  snapThreshold: 80,
};

const STORAGE_KEY = "shugu.mascot.calibration.v1";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Read from localStorage, falling back per-field to defaults on corrupt or missing entries. */
export function loadCalibration(): ChibiCalibration {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CALIBRATION };
    const parsed = JSON.parse(raw);
    return {
      left:          isFiniteNumber(parsed.left)          ? parsed.left          : DEFAULT_CALIBRATION.left,
      right:         isFiniteNumber(parsed.right)         ? parsed.right         : DEFAULT_CALIBRATION.right,
      top:           isFiniteNumber(parsed.top)           ? parsed.top           : DEFAULT_CALIBRATION.top,
      bottom:        isFiniteNumber(parsed.bottom)        ? parsed.bottom        : DEFAULT_CALIBRATION.bottom,
      snapThreshold: isFiniteNumber(parsed.snapThreshold) ? parsed.snapThreshold : DEFAULT_CALIBRATION.snapThreshold,
    };
  } catch {
    return { ...DEFAULT_CALIBRATION };
  }
}

/** Persist to localStorage. Triggers the `storage` event in OTHER same-origin windows. */
export function saveCalibration(cal: ChibiCalibration): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  } catch {
    // Storage quota or unavailable — silently ignore.
  }
}

/**
 * Listen for cross-window calibration changes. Pass `callback` and you'll
 * receive the freshly-loaded ChibiCalibration whenever ANOTHER window
 * writes to the same localStorage key. Returns an unsubscribe function.
 */
export function subscribeCalibration(callback: (cal: ChibiCalibration) => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    callback(loadCalibration());
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
