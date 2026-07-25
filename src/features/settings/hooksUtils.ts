// Shugu Forge — P6.4 hooks : helpers PURS (aucune I/O) pour la section
// Settings « Hooks » et les badges d'events. Testables en Vitest, dans la
// lignée de followUpQueue.ts / tokenUsage.ts.

import type { HookOutcomeName } from "@/lib/hooks";

/** Toggle d'un id dans la liste des hooks désactivés (persistée côté Rust
 *  dans `settings.hooks.disabled`). Pure : nouvelle liste, pas de mutation. */
export function toggleDisabledId(ids: string[], id: string, disabled: boolean): string[] {
  if (disabled) return ids.includes(id) ? ids : [...ids, id];
  return ids.filter((x) => x !== id);
}

/** Libellé FR d'un outcome de hook (badges + résultat du « tester »). */
export function hookOutcomeLabel(outcome: HookOutcomeName): string {
  switch (outcome) {
    case "ok":
      return "exécuté";
    case "context":
      return "contexte injecté";
    case "block":
      return "bloqué";
    case "timeout":
      return "timeout (fail-open)";
    case "error":
      return "erreur (fail-open)";
    case "block-ignored":
      return "bloc ignoré (borne Stop)";
    default:
      return String(outcome);
  }
}

/** Teinte d'un outcome pour les chips/badges. */
export function hookOutcomeTone(outcome: HookOutcomeName): "success" | "warn" | "danger" | "muted" {
  switch (outcome) {
    case "ok":
    case "context":
      return "success";
    case "timeout":
    case "error":
    case "block-ignored":
      return "warn";
    case "block":
      return "danger";
    default:
      return "muted";
  }
}

/** Libellé FR court d'un event de hook. */
export function hookEventLabel(event: string): string {
  switch (event) {
    case "SessionStart":
      return "début de run";
    case "UserPromptSubmit":
      return "soumission du prompt";
    case "PreToolUse":
      return "avant outil";
    case "PostToolUse":
      return "après outil";
    case "PreCompact":
      return "avant compaction";
    case "Stop":
      return "fin de run";
    default:
      return event;
  }
}

/** Badge de source d'un hook (quel hooks.json l'a déclaré). */
export function hookSourceLabel(source: string): string {
  return source === "project" ? "projet" : "utilisateur";
}

/** Résumé une ligne du résultat d'un « tester » (honesté : timeout/error
 *  dits tels quels, jamais maquillés en succès). */
export function describeHookTest(result: {
  outcome: HookOutcomeName;
  exitCode: number;
  durationMs: number;
}): string {
  return `${hookOutcomeLabel(result.outcome)} · exit ${result.exitCode} · ${result.durationMs} ms`;
}
