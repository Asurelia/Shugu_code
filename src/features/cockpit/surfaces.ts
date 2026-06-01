// src/features/cockpit/surfaces.ts
// Right-panel surface registry. C4 ships all five surfaces as real.
// `icon` is set where the shared <Icon/> set has a matching name.
import type { SurfaceId } from "./layout";

export interface SurfaceMeta {
  id: SurfaceId;
  label: string;
  icon?: string;
  /** True until the surface becomes functional. */
  comingSoon?: boolean;
}

export const SURFACE_META: Record<SurfaceId, SurfaceMeta> = {
  editor:   { id: "editor",   label: "Éditeur",    icon: "code" },
  review:   { id: "review",   label: "Révision",   icon: "git" },
  terminal: { id: "terminal", label: "Terminal" },
  files:    { id: "files",    label: "Fichiers" },
  browser:  { id: "browser",  label: "Navigateur" },
};

/** Ordered list for the "+"-menu. */
export const SURFACE_MENU: SurfaceMeta[] = [
  SURFACE_META.editor,
  SURFACE_META.review,
  SURFACE_META.terminal,
  SURFACE_META.files,
  SURFACE_META.browser,
];

export function surfaceLabel(id: SurfaceId): string {
  return SURFACE_META[id].label;
}
