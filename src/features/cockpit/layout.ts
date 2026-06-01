// src/features/cockpit/layout.ts
// Cockpit layout — pure types + tolerant normalizer. NO imports (testable in
// isolation; db access lives in layoutPersistence.ts).

export type SurfaceId = "editor" | "review" | "terminal" | "files" | "browser";

export const SURFACES: SurfaceId[] = ["editor", "review", "terminal", "files", "browser"];

export interface CockpitLayout {
  /** Right panel expanded (true) or collapsed/keep-warm (false). */
  rightPanelOpen: boolean;
  /** Which surface occupies the right panel. */
  activeSurface: SurfaceId;
  /** [chatPct, panelPct] — react-resizable-panels sizes (each in (0,100)). */
  sizes: [number, number];
}

export const DEFAULT_LAYOUT: CockpitLayout = {
  rightPanelOpen: false,
  activeSurface: "editor",
  sizes: [55, 45],
};

function isSurface(v: unknown): v is SurfaceId {
  return typeof v === "string" && (SURFACES as string[]).includes(v);
}

function isSizes(v: unknown): v is [number, number] {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    v.every((n) => typeof n === "number" && n > 0 && n < 100)
  );
}

/** Coerce any persisted/unknown value into a valid CockpitLayout. */
export function normalizeLayout(raw: unknown): CockpitLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
  const o = raw as Record<string, unknown>;
  return {
    rightPanelOpen:
      typeof o.rightPanelOpen === "boolean" ? o.rightPanelOpen : DEFAULT_LAYOUT.rightPanelOpen,
    activeSurface: isSurface(o.activeSurface) ? o.activeSurface : DEFAULT_LAYOUT.activeSurface,
    sizes: isSizes(o.sizes) ? o.sizes : DEFAULT_LAYOUT.sizes,
  };
}
