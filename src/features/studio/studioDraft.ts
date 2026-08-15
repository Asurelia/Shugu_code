// Shugu Forge — Design Studio draft (the assistant's in-progress inputs).
//
// Why this exists: Studio draft (brief, direction, convId) must survive dock
// remounts and project switches. Synthetic query as global state — same pattern
// as brandBoard / canvas doc.
//
// Pattern: TanStack "synthetic query as global state" — identical to
// brandBoard / canvas store. Readable from StudioWorkspace; writable via
// setStudioDraft. Generation-runtime state (reloadKey) stays local; preview
// files are disk-backed.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { DiscoveryAnswers, Direction } from "./generationContext";

export interface StudioDraft {
  step: 1 | 2 | 3;
  brief: string;
  discovery: DiscoveryAnswers;
  /** Chosen colour direction — only meaningful when no design system is active. */
  direction: Direction | null;
  /**
   * "Create a new project" intent. Persisted here (not local component state) so
   * it survives the Créer ⇄ Inspiration round-trip: picking a base sets it, so
   * we land on the wizard even when an old project sits on disk. Reset on
   * generate; the disk-reset of this store means an app reload falls back to
   * iteration (conversation) over the existing project.
   */
  startingNew: boolean;
  /**
   * The current Studio session's conversation id — DEDICATED to the Studio, not
   * the main chat's active conv (which `getActiveConv()` reads). Minted lazily on
   * the first generation of a session so each project = its own conversation
   * (clean history reconstruction from agents/agent_events, and Studio agents
   * don't pollute the chat reconciler). Set when reopening a saved project;
   * cleared by "Nouveau".
   */
  convId: string | null;
}

const KEY = ["studio", "draft"] as const;
const INITIAL: StudioDraft = {
  step: 1,
  brief: "",
  discovery: {},
  direction: null,
  startingNew: false,
  convId: null,
};

/** Reactive read — StudioWorkspace re-renders when any draft field changes. */
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
