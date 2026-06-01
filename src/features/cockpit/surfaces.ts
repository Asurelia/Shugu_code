// src/features/cockpit/surfaces.ts
// Right-panel surface registry. C1 ships "editor" + "review" as real; the rest
// are listed but disabled (comingSoon) until Lot C4. `icon` is only set for the
// two confirmed icons in the shared <Icon/> set ("code", "git") to avoid
// depending on icon names that may not exist yet.
import type { SurfaceId } from "./layout";

export interface SurfaceMeta {
  id: SurfaceId;
  label: string;
  icon?: string;
  /** True until the surface becomes functional (Lot C4). */
  comingSoon?: boolean;
}

export const SURFACE_META: Record<SurfaceId, SurfaceMeta> = {
  editor:   { id: "editor",   label: "Éditeur",    icon: "code" },
  review:   { id: "review",   label: "Révision",   icon: "git" },
  terminal: { id: "terminal", label: "Terminal",   comingSoon: true },
  files:    { id: "files",    label: "Fichiers",   comingSoon: true },
  browser:  { id: "browser",  label: "Navigateur", comingSoon: true },
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
