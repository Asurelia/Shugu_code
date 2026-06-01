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

/** Non-hook read (for imperative callers). */
export function getLayout(): CockpitLayout {
  return read();
}

export function setRightPanelOpen(open: boolean): void {
  write({ ...read(), rightPanelOpen: open });
}

/** Open the right panel AND focus a surface (used by the "+"-menu / toggle). */
export function openSurface(id: SurfaceId): void {
  write({ ...read(), rightPanelOpen: true, activeSurface: id });
}

export function setActiveSurface(id: SurfaceId): void {
  write({ ...read(), activeSurface: id });
}

export function setSizes(sizes: [number, number]): void {
  write({ ...read(), sizes });
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
