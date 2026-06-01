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
  /** Ordered list of surfaces the user has opened (shown as tabs). The "+"
   *  menu adds surfaces not yet present. Always has ≥ 1 element. */
  openedSurfaces: SurfaceId[];
}

export const DEFAULT_LAYOUT: CockpitLayout = {
  rightPanelOpen: false,
  activeSurface: "editor",
  sizes: [55, 45],
  openedSurfaces: ["editor", "review"],
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

function normalizeOpenedSurfaces(raw: unknown): SurfaceId[] {
  if (!Array.isArray(raw)) return [...DEFAULT_LAYOUT.openedSurfaces];
  // Keep only valid SurfaceIds, dedupe preserving first-seen order.
  const seen = new Set<SurfaceId>();
  const result: SurfaceId[] = [];
  for (const item of raw) {
    if (isSurface(item) && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result.length > 0 ? result : [...DEFAULT_LAYOUT.openedSurfaces];
}

/** Coerce any persisted/unknown value into a valid CockpitLayout. */
export function normalizeLayout(raw: unknown): CockpitLayout {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LAYOUT };
  const o = raw as Record<string, unknown>;

  // Normalize openedSurfaces first — needed to coerce activeSurface below.
  const openedSurfaces = normalizeOpenedSurfaces(o.openedSurfaces);

  // activeSurface must be a valid SurfaceId AND be within openedSurfaces.
  let activeSurface: SurfaceId = isSurface(o.activeSurface)
    ? o.activeSurface
    : DEFAULT_LAYOUT.activeSurface;
  if (!openedSurfaces.includes(activeSurface)) {
    activeSurface = openedSurfaces[0];
  }

  return {
    rightPanelOpen:
      typeof o.rightPanelOpen === "boolean" ? o.rightPanelOpen : DEFAULT_LAYOUT.rightPanelOpen,
    activeSurface,
    sizes: isSizes(o.sizes) ? o.sizes : DEFAULT_LAYOUT.sizes,
    openedSurfaces,
  };
}
