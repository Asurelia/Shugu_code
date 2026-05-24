// Shugu Forge — Design Studio draft (the assistant's in-progress inputs).
//
// Why this exists: the Studio is now a parent route with nested sub-routes
// (/studio = Créer, /studio/inspiration = catalogue). Switching to Inspiration
// UNMOUNTS the Créer view, so any wizard input held in StudioView's useState
// would be lost — breaking the core "type a brief → go pick a base → Partir de
// cette base → back to Créer" loop. The brief, discovery answers, chosen
// direction and step must survive that round-trip.
//
// Pattern: TanStack "synthetic query as global state" — identical to
// activeDesignSystem.ts. The value lives in the query cache (not a component),
// so it persists across the route transition; readable reactively in
// StudioView and writable from anywhere via setStudioDraft.
//
// Only the INPUTS live here. Generation-runtime state (status, reloadKey) stays
// local to StudioView, and the rendered preview is disk-backed (preview://), so
// it survives on its own.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { DiscoveryAnswers, Direction } from "./generationContext";

export interface StudioDraft {
  step: 1 | 2 | 3;
  brief: string;
  discovery: DiscoveryAnswers;
  /** Chosen colour direction — only meaningful when no design system is active. */
  direction: Direction | null;
}

const KEY = ["studio", "draft"] as const;
const INITIAL: StudioDraft = { step: 1, brief: "", discovery: {}, direction: null };

/** Reactive read — StudioView re-renders when any draft field changes. */
export function useStudioDraft(): StudioDraft {
  return (
    useQuery<StudioDraft>({
      queryKey: KEY,
      queryFn: () => INITIAL,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? INITIAL
  );
}

/** Merge-patch the draft (e.g. setStudioDraft({ brief })). */
export function setStudioDraft(patch: Partial<StudioDraft>): void {
  const cur = queryClient.getQueryData<StudioDraft>(KEY) ?? INITIAL;
  queryClient.setQueryData<StudioDraft>(KEY, { ...cur, ...patch });
}
