// Shugu Forge — file d'attente des messages de suivi pendant un run (P6.1).
//
// Helpers PURS (aucune I/O) extraits pour rester testables en Vitest, dans la
// lignée de mentions.ts / codeContext.ts. La logique live (chips, drain) vit
// dans chat-sync.ts / FollowUpChips.tsx ; les types/invokes dans lib/agents.ts.

import type { FollowUpMode } from "@/lib/agents";

/** Clé du réglage persisté (db.settings) — sélecteur à 3 modes dans Settings. */
export const FOLLOWUP_MODE_SETTING_KEY = "agents.followUpQueueMode";

/** Mode par défaut produit : le message attend la fin du run (FIFO). */
export const DEFAULT_FOLLOWUP_MODE: FollowUpMode = "queue";

/** Parse la valeur persistée en mode valide ; toute valeur inconnue/absente
 *  retombe sur le défaut (jamais de mode fantaisiste côté backend). */
export function parseFollowUpMode(raw: string | null | undefined): FollowUpMode {
  return raw === "steer" || raw === "interrupt" || raw === "queue" ? raw : DEFAULT_FOLLOWUP_MODE;
}

/** Mode INVERSE pour le one-shot Ctrl+Shift+Enter : queue ↔ steer ;
 *  interrupt reste interrupt (son contraire n'a pas de sens — c'est déjà
 *  l'action la plus brutale). */
export function inverseFollowUpMode(mode: FollowUpMode): FollowUpMode {
  if (mode === "queue") return "steer";
  if (mode === "steer") return "queue";
  return "interrupt";
}

/** Mode effectif d'un envoi : l'override one-shot (Ctrl+Shift+Enter) gagne
 *  toujours ; sinon le réglage persisté (parsé défensivement). */
export function resolveEffectiveFollowUpMode(
  settingRaw: string | null | undefined,
  override?: FollowUpMode,
): FollowUpMode {
  return override ?? parseFollowUpMode(settingRaw);
}

/** Pictogramme du mode pour les chips du composer. */
export function followUpModeIcon(mode: FollowUpMode): string {
  switch (mode) {
    case "steer":
      return "🧭";
    case "interrupt":
      return "⚡";
    case "queue":
    default:
      return "⏳";
  }
}

/** Libellé court FR du mode (chip + sélecteur Settings). */
export function followUpModeLabel(mode: FollowUpMode): string {
  switch (mode) {
    case "steer":
      return "guidage";
    case "interrupt":
      return "interruption";
    case "queue":
    default:
      return "file d'attente";
  }
}

/** Explication affichée au survol d'un chip pending. */
export function followUpModeHint(mode: FollowUpMode): string {
  switch (mode) {
    case "steer":
      return "Sera injecté entre deux étapes du run en cours pour corriger sa trajectoire.";
    case "interrupt":
      return "Arrête le run en cours et repart avec ce message.";
    case "queue":
    default:
      return "Sera traité automatiquement quand le run en cours se terminera.";
  }
}
