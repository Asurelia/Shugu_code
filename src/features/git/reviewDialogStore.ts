// Shugu Forge — store d'ouverture du ReviewDialog (TanStack, comme toast / idleStore).
//
// État UI PUREMENT éphémère : { open, source }. Exclu de la persistance (cf.
// main.tsx dehydrateOptions, préfixe "ai-review") — sinon un `open: true`
// rehydraté rouvrirait le dialog tout seul au reload. Centraliser l'état ici
// permet à la palette ET au bouton SideGit d'ouvrir le même dialog sans
// prop-drilling.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

/** Sources de diff supportées par l'AI review (sous-ensemble de DiffSource). */
export type ReviewSource = "index" | "head";

export interface ReviewDialogState {
  open: boolean;
  /** `"index"` = staged seulement ; `"head"` = toutes les modifs vs HEAD. */
  source: ReviewSource;
}

const REVIEW_KEY = ["ai-review", "dialog"] as const;
const INITIAL: ReviewDialogState = { open: false, source: "index" };

function getState(): ReviewDialogState {
  return queryClient.getQueryData<ReviewDialogState>(REVIEW_KEY) ?? INITIAL;
}

function setState(next: ReviewDialogState): void {
  queryClient.setQueryData<ReviewDialogState>(REVIEW_KEY, next);
}

/** Ouvre le dialog sur la source donnée (défaut : staged). */
export function openReviewDialog(source: ReviewSource = "index"): void {
  setState({ open: true, source });
}

/** Change la source affichée sans fermer le dialog. */
export function setReviewSource(source: ReviewSource): void {
  setState({ ...getState(), source });
}

/** Ferme le dialog. */
export function closeReviewDialog(): void {
  setState({ ...getState(), open: false });
}

/** Lecture réactive de l'état (le dialog est monté une seule fois). */
export function useReviewDialog(): ReviewDialogState {
  const { data = INITIAL } = useQuery<ReviewDialogState>({
    queryKey: REVIEW_KEY,
    queryFn: getState,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
