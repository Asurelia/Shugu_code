// Shugu Forge — Phase 7 #3 — règles de commandes apprises (« mode fluide »).
//
// Wrappers Tauri + helpers PURS pour le système de règles auto-allow/deny.
// Le backend classe chaque commande (CommandRisk) et, pour une commande Danger,
// PRÉFIXE sa sortie par « [RISK: <reason>] <detail> ». Une règle « allow »
// silencie ce flag pour un motif simple ; une règle « deny » bloque réellement
// la commande avant son démarrage. Persistées globalement.

import { invoke } from "@/lib/tauri";

// P6.10 — moteur de règles de permission allow / ask / deny (table
// `agent_permission_rules`, V28). Les anciennes règles allow/deny sont
// migrées ; le `ask` produit une question HITL en profil mutant.

export type RuleDecision = "allow" | "ask" | "deny";

/** Une règle telle que stockée/affichée (trois décisions + scope). */
export interface PermissionRuleRow {
  pattern: string;
  decision: RuleDecision;
  /** "" = global, sinon chemin du workspace. */
  scope: string;
  detail?: string;
  createdAt: number;
}

/** Liste toutes les règles, plus récentes d'abord. */
export async function permissionRuleList(): Promise<PermissionRuleRow[]> {
  return invoke<PermissionRuleRow[]>("permission_rule_list");
}

/** Enregistre (ou raffine) une règle. Le backend valide la forme du motif
 *  (grammaire unique : `git push *`, `run_command(...)`, `web_fetch(domain:)`,
 *  `mcp__<serveur>__<outil|*>`, `<outil>(path:...)`) et rejette un motif vide,
 *  invalide ou `*` nu. `scope` vide = global. */
export async function permissionRuleSave(
  pattern: string,
  decision: RuleDecision,
  scope?: string,
  detail?: string,
): Promise<void> {
  await invoke("permission_rule_save", { pattern, decision, scope, detail });
}

/** Supprime une règle par (motif, scope) — la PK exacte. */
export async function permissionRuleDelete(pattern: string, scope?: string): Promise<void> {
  await invoke("permission_rule_delete", { pattern, scope });
}

/** Verdict du testeur live (Settings). */
export interface PermissionEvaluation {
  /** "allow" | "ask" | "deny" | "noRule". */
  outcome: "allow" | "ask" | "deny" | "noRule";
  matchedPattern: string | null;
  reason: string | null;
}

/** Évalue un appel d'outil d'exemple contre les règles actuelles. */
export async function permissionRuleEvaluate(
  tool: string,
  args: Record<string, unknown>,
): Promise<PermissionEvaluation> {
  return invoke<PermissionEvaluation>("permission_rule_evaluate", { tool, args });
}

/** @deprecated utilise PermissionRuleRow (P6.10). */
export type CommandRuleRow = PermissionRuleRow;

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
