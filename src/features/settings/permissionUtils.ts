// Shugu Forge — P6.10 : helpers PURS pour la section « Règles de permission »
// et la carte « ask ». Testables en Vitest, pattern hooksUtils/pluginsUtils.

import type { RuleDecision, PermissionEvaluation } from "@/lib/commandRules";

/** Libellé FR d'une décision de règle. */
export function decisionLabel(decision: RuleDecision): string {
  switch (decision) {
    case "allow":
      return "Autoriser";
    case "ask":
      return "Demander";
    case "deny":
      return "Refuser";
  }
}

/** Construit l'objet args JSON attendu par `permission_rule_evaluate` pour un
 *  outil + un argument libre saisi dans le testeur (même mapping que le
 *  dispatch : command / url / path). */
export function buildTestArgs(tool: string, arg: string): Record<string, unknown> {
  switch (tool) {
    case "run_command":
      return { command: arg };
    case "web_fetch":
      return { url: arg };
    default:
      // fs_write_file / fs_edit / fs_read_file et autres outils à arg `path`.
      return { path: arg };
  }
}

/** Présentation du verdict du testeur live : décision + règle matchée +
 *  raison éventuelle. `noRule` est dit honnêtement (classifieur statique). */
export function describeEvaluation(ev: PermissionEvaluation): string {
  if (ev.outcome === "noRule") {
    return "Aucune règle ne matche → classifieur statique (comportement par défaut).";
  }
  const reason = ev.reason ? ` (${ev.reason})` : "";
  return `${decisionLabel(ev.outcome)} — règle « ${ev.matchedPattern} »${reason}`;
}

/** Libellé d'affichage du scope d'une règle ("" = global). */
export function scopeLabel(scope: string, currentWorkspace: string | null): string {
  if (!scope) return "global";
  if (currentWorkspace && scope === currentWorkspace) return "projet";
  return scope;
}

/** Préfixe de réponse enregistrée par la carte « ask » — CONTRAT avec le
 *  backend (permission::answered_permission_on_conn lit ce préfixe à la
 *  relance pour trancher le verdict « une fois »). */
export function permissionAnswerText(allow: boolean, tool: string, argsSummary: string): string {
  return allow
    ? `AUTORISÉ par l'utilisateur : exécute « ${argsSummary} » avec l'outil ${tool}, puis continue la tâche.`
    : `REFUSÉ par l'utilisateur : n'exécute PAS « ${argsSummary} » — poursuis la tâche sans cet appel d'outil.`;
}
