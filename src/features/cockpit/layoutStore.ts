// src/features/cockpit/layoutStore.ts
// Cockpit layout store — React Query as the reactive container (project idiom,
// cf. editorSelectionStore.ts). Live mutations update the cache immediately;
// SQLite persistence is debounced via saveLayout.
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { DEFAULT_LAYOUT, type CockpitLayout, type SurfaceId } from "./layout";
import { saveLayout } from "./layoutPersistence";

const KEY = ["cockpit", "layout"] as const;

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function read(): CockpitLayout {
  return queryClient.getQueryData<CockpitLayout>([...KEY]) ?? { ...DEFAULT_LAYOUT };
}

function write(next: CockpitLayout): void {
  queryClient.setQueryData<CockpitLayout>([...KEY], next);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveLayout(next), 400);
}

/** Push an initial (persisted) layout into the store. Call once at mount. */
export function hydrateLayout(layout: CockpitLayout): void {
  queryClient.setQueryData<CockpitLayout>([...KEY], layout);
}

/**
 * True once the layout has been put in the store this session. Lets the shell
 * skip its loading spinner on subsequent navigations into the cockpit (the
 * cache survives unmount/remount within a session), so the flash only ever
 * shows on the very first mount.
 */
export function isLayoutHydrated(): boolean {
  return queryClient.getQueryData<CockpitLayout>([...KEY]) !== undefined;
}

/** Non-hook read (for imperative callers). */
export function getLayout(): CockpitLayout {
  return read();
}

export function setRightPanelOpen(open: boolean): void {
  write({ ...read(), rightPanelOpen: open });
}

/** Open the right panel AND focus a surface. Adds `id` to openedSurfaces if
 *  not already present (used by the "+"-menu, titlebar toggle, and file-pick). */
export function openSurface(id: SurfaceId): void {
  const current = read();
  const opened = current.openedSurfaces.includes(id)
    ? current.openedSurfaces
    : [...current.openedSurfaces, id];
  write({ ...current, rightPanelOpen: true, activeSurface: id, openedSurfaces: opened });
}

/** Remove `id` from openedSurfaces. If it was active, move to the last
 *  remaining opened surface. Never allows openedSurfaces to become empty. */
export function closeSurface(id: SurfaceId): void {
  const current = read();
  const remaining = current.openedSurfaces.filter((s) => s !== id);
  if (remaining.length === 0) return; // Guard: keep at least 1 tab.
  const activeSurface =
    current.activeSurface === id
      ? remaining[remaining.length - 1]
      : current.activeSurface;
  write({ ...current, openedSurfaces: remaining, activeSurface });
}

/** Make `id` the active surface. Adds it to openedSurfaces if missing
 *  (e.g. file-pick in the Files surface triggers setActiveSurface("editor")). */
export function setActiveSurface(id: SurfaceId): void {
  const current = read();
  const opened = current.openedSurfaces.includes(id)
    ? current.openedSurfaces
    : [...current.openedSurfaces, id];
  write({ ...current, activeSurface: id, openedSurfaces: opened });
}

export function setSizes(sizes: [number, number]): void {
  write({ ...read(), sizes });
}

export function setBottomDockOpen(open: boolean): void {
  write({ ...read(), bottomDockOpen: open });
}

export function setBottomDockSize(n: number): void {
  write({ ...read(), bottomDockSize: n });
}

/** Reactive hook for the shell components. */
export function useCockpitLayout(): CockpitLayout {
  const { data = { ...DEFAULT_LAYOUT } } = useQuery<CockpitLayout>({
    queryKey: [...KEY],
    queryFn: () => read(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
