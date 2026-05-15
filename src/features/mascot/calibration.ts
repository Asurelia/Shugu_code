// Shugu Forge — chibi-snap calibration (shared module).
//
// Single source of truth for the 4 geometric offsets + threshold that
// the mascot window's snap algorithm uses. Persistence is localStorage
// (survives restart); cross-window sync uses TWO mechanisms layered
// together:
//
//   1. `storage` browser event — fires when two same-origin documents
//      share localStorage AND the browser propagates events between
//      them. NOT reliable across Tauri 2 WebviewWindows in every
//      configuration, so we treat it as best-effort.
//
//   2. Tauri custom event `mascot://calibration-changed` — explicitly
//      emitted by saveCalibration() and listened to in the mascot
//      window. This is the GUARANTEED path: Tauri's event bus crosses
//      WebviewWindow boundaries by design.
//
// The settings panel in the MAIN IDE window writes via saveCalibration;
// the MASCOT window receives via subscribeCalibration which wires both
// channels. Whichever fires first wins; the second is harmless because
// loadCalibration() reads the same localStorage value either way.

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

/**
 * Defaults — visual preference rather than raw alpha-scan geometry.
 *
 * The original M3-v6 values (32 / 124 / 19 / 156, threshold 80) were
 * derived strictly from a canvas alpha scan of the chibi PNGs: they
 * make the alpha-non-zero pixel of the sprite land exactly on the
 * monitor edge. In practice the user judged that "too tight" and
 * tuned via the Settings → Mascot sliders to these values, which:
 *
 *   - leave a small visual breathing margin so anti-aliased pixels
 *     and the drop-shadow halo don't feel clipped against the edge
 *   - keep top/bottom roughly symmetric to match the visible centre
 *     of mass of the chibi (which is in its body, not its feet)
 *   - tighten the snap threshold so the magnetism only kicks in when
 *     the user has clearly committed to an edge, not on every near-pass
 *
 * Reset in Settings → Mascot restores these. Keep them in sync with
 * what feels right on a typical 1080p/4K display at standard DPI.
 */
export const DEFAULT_CALIBRATION: ChibiCalibration = {
  left: 73,
  right: 85,
  top: 73,
  bottom: 85,
  snapThreshold: 35,
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

const TAURI_EVENT = "mascot://calibration-changed";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Persist to localStorage AND broadcast via the Tauri event bus so the
 * mascot window picks up the change even when the `storage` event
 * doesn't propagate between WebviewWindows. Fire-and-forget — callers
 * don't need to await.
 */
export function saveCalibration(cal: ChibiCalibration): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cal));
  } catch {
    // Storage quota or unavailable — silently ignore.
  }
  if (isTauri()) {
    // Async import + emit; we don't await — the receiver is on the other
    // window's event loop, latency is irrelevant for a calibration slider.
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        await mod.emit(TAURI_EVENT, cal);
      } catch (err) {
        console.warn("[calibration] emit failed:", err);
      }
    })();
  }
}

/**
 * Subscribe to cross-window calibration changes. Wires BOTH the
 * `storage` browser event (best-effort) and the Tauri custom event
 * (guaranteed). The callback receives the freshly-loaded
 * ChibiCalibration whenever the values change anywhere in the app.
 * Returns a single unsubscribe function that detaches both channels.
 */
export function subscribeCalibration(callback: (cal: ChibiCalibration) => void): () => void {
  // Channel 1: storage event (free, sometimes works).
  const onStorage = (e: StorageEvent) => {
    if (e.key !== STORAGE_KEY) return;
    callback(loadCalibration());
  };
  window.addEventListener("storage", onStorage);

  // Channel 2: Tauri custom event (reliable cross-window).
  let unlistenTauri: (() => void) | null = null;
  if (isTauri()) {
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlistenTauri = await mod.listen<ChibiCalibration>(TAURI_EVENT, (e) => {
          // Trust the payload (sender just computed it); fall back to a
          // localStorage re-read only if the payload looks invalid.
          if (
            e.payload &&
            typeof e.payload.left === "number" &&
            typeof e.payload.right === "number"
          ) {
            callback(e.payload);
          } else {
            callback(loadCalibration());
          }
        });
      } catch (err) {
        console.warn("[calibration] listen failed:", err);
      }
    })();
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    unlistenTauri?.();
  };
}
