// Shugu Forge — Phase 7 #3 — règles de commandes apprises (« mode fluide »).
//
// Wrappers Tauri + helpers PURS pour le système de règles auto-allow/deny.
// Le backend classe chaque commande (CommandRisk) et, pour une commande Danger,
// PRÉFIXE sa sortie par « [RISK: <reason>] <detail> » (non-bloquant — la
// fluidité prime, cf. policy.rs / tools.rs). Une règle « allow » silencie ce
// flag pour un motif de commande ; une règle « deny » flagge un motif que le
// classifieur statique rate. Persistées globalement (table agent_command_rules).

import { invoke } from "@/lib/tauri";

/** Une règle telle que stockée/affichée. `verdict` est la forme string Rust. */
export interface CommandRuleRow {
  pattern: string;
  verdict: "allow" | "deny";
  detail?: string;
}

/** Liste toutes les règles apprises, plus récentes d'abord. */
export async function commandRuleList(): Promise<CommandRuleRow[]> {
  return invoke<CommandRuleRow[]>("command_rule_list");
}

/** Enregistre (ou raffine) une règle. Le backend rejette un motif vide ou `*`
 *  nu. `detail` est une note optionnelle affichée pour une règle `deny`. */
export async function commandRuleSave(
  pattern: string,
  verdict: "allow" | "deny",
  detail?: string,
): Promise<void> {
  await invoke("command_rule_save", { pattern, verdict, detail });
}

/** Supprime une règle par son motif exact. */
export async function commandRuleDelete(pattern: string): Promise<void> {
  await invoke("command_rule_delete", { pattern });
}

/** Un flag de risque extrait de la sortie d'une commande. */
export interface RiskFlag {
  /** Code stable (recursiveDelete, forcePush…). */
  reason: string;
  /** Détail humain (« commande à risque », etc.). */
  detail: string;
}

/**
 * Parse le préfixe « [RISK: <reason>] <detail> » que le backend met en TÊTE de
 * la sortie d'une commande Danger (tools.rs). Pur. Retourne `undefined` si la
 * sortie ne commence pas par ce marqueur. Ne lit QUE la première ligne.
 */
export function parseRiskFlag(result: string | undefined): RiskFlag | undefined {
  if (!result) return undefined;
  // `[ \t]*` (PAS `\s*`) après `]` : ne consomme QUE l'espace horizontal, sinon
  // `\s` traverserait le `\n` et `(.*)` capturerait la 2e ligne (la sortie de la
  // commande) comme detail quand le detail de la 1re ligne est vide.
  const m = result.match(/^\[RISK:\s*([^\]]+)\][ \t]*(.*)/);
  if (!m) return undefined;
  return { reason: m[1].trim(), detail: m[2].trim() };
}

/**
 * Dérive un motif de règle PROPOSÉ depuis une commande (modèle prefix-rule type
 * Codex) : premier token significatif + ` *` quand il y a des arguments. Pur.
 *   « git push origin main » → « git * »
 *   « pnpm »                 → « pnpm »
 * NOTE : un premier token large (del, rm, Remove-Item…) donne un motif large —
 * c'est pourquoi l'UI montre ce motif ÉDITABLE avant l'enregistrement, pour que
 * l'utilisateur le restreigne (ex. « del C:\\temp\\* ») s'il le souhaite.
 */
export function deriveCommandPattern(command?: string): string {
  const tokens = (command ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.length > 1 ? `${tokens[0]} *` : tokens[0];
}
