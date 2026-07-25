// Shugu Forge — P6.6 : modes de détail de la conversation.
//
// Trois présentations du MÊME flux d'events (zéro changement de données —
// filtré ≠ supprimé : le transcript persisté est identique, seule la
// présentation change) :
//   - "recit"     : prose — la timeline d'outils et les raisonnements sont
//                   masqués, seuls le texte narratif, les cartes d'action
//                   (HITL, fichiers modifiés, suivis) et les résultats restent ;
//   - "etapes"    : le rendu actuel (défaut) ;
//   - "execution" : tout déplié — activité, sorties de commandes, reasoning.
//
// Helpers PURS (aucune I/O) — testables en Vitest, pattern followUpQueue.ts.

import type { AgentActivityItem } from "./useMessageDisplay";

export type DetailMode = "recit" | "etapes" | "execution";

export const DETAIL_MODE_SETTING_KEY = "chat.conversationDetailMode";
export const DEFAULT_DETAIL_MODE: DetailMode = "etapes";

/** Parse la valeur persistée ; toute valeur inconnue/absente retombe sur le
 *  défaut (Étapes = rendu historique). */
export function parseDetailMode(raw: string | null | undefined): DetailMode {
  return raw === "recit" || raw === "execution" || raw === "etapes" ? raw : DEFAULT_DETAIL_MODE;
}

/** La timeline d'outils (activité + plan) est-elle visible dans ce mode ? */
export function showToolTimeline(mode: DetailMode): boolean {
  return mode !== "recit";
}

/** Tout déplier (bloc d'activité ouvert + sorties d'outils ouvertes) ? */
export function expandToolDetails(mode: DetailMode): boolean {
  return mode === "execution";
}

/** Les traces de reasoning sont-elles visibles dans ce mode ? */
export function showReasoning(mode: DetailMode): boolean {
  return mode !== "recit";
}

/** Reasoning déplié par défaut ? */
export function expandReasoning(mode: DetailMode): boolean {
  return mode === "execution";
}

/** Présentation de la liste d'activité selon le mode. CONTRAT : la liste
 *  source n'est JAMAIS mutée — "recit" renvoie une liste vide DE PRÉSENTATION
 *  (les données restent dans le transcript), "etapes"/"execution" renvoient
 *  la MÊME référence (zéro copie, zéro perte). */
export function presentActivity(
  activity: AgentActivityItem[] | undefined,
  mode: DetailMode,
): AgentActivityItem[] {
  if (mode === "recit") return [];
  return activity ?? [];
}

/** Libellés FR du sélecteur Settings. */
export function detailModeLabel(mode: DetailMode): string {
  switch (mode) {
    case "recit":
      return "Récit";
    case "execution":
      return "Exécution";
    case "etapes":
    default:
      return "Étapes";
  }
}
