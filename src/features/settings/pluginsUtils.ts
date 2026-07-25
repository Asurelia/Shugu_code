// Shugu Forge — P6.7 plugins : helpers PURS (aucune I/O) pour le gestionnaire
// Settings, l'autocomplete du composer et les badges MCP. Testables en Vitest,
// pattern followUpQueue.ts / hooksUtils.ts.

import type { PluginSummary, PluginMcpServerInfo, FileSkill } from "@/lib/plugins";

/** Résumé des contributions d'un plugin pour le gestionnaire :
 *  « 2 commandes · 1 agent · 1 skill · 1 hook · 1 MCP en attente ».
 *  Les compteurs à zéro sont omis (un plugin désactivé affiche « aucune
 *  contribution » plutôt que des zéros). */
export function pluginContributionsSummary(p: PluginSummary): string {
  const parts: string[] = [];
  const push = (n: number, singular: string, plural: string) => {
    if (n > 0) parts.push(`${n} ${n > 1 ? plural : singular}`);
  };
  push(p.commands, "commande", "commandes");
  push(p.agents, "agent", "agents");
  push(p.skills, "skill", "skills");
  push(p.hooks, "hook", "hooks");
  push(p.mcpPending, "MCP en attente", "MCP en attente");
  return parts.length > 0 ? parts.join(" · ") : "aucune contribution";
}

/** Libellé FR de la source d'un plugin. */
export function pluginSourceLabel(source: string): string {
  switch (source) {
    case "project":
      return "projet";
    case "claude-cache":
      return "cache Claude (lecture seule)";
    case "user":
    default:
      return "utilisateur";
  }
}

/** Nom effectif d'une slash command de plugin dans l'autocomplete : le nom nu
 *  sauf collision avec un nom déjà pris (agent défini ou autre plugin) →
 *  forme namespacée `plugin:command`. */
export function effectiveSlashName(
  cmd: { plugin: string; name: string; namespacedName: string },
  takenNames: ReadonlySet<string>,
): string {
  return takenNames.has(cmd.name) ? cmd.namespacedName : cmd.name;
}

/** Tous les noms « pris » pour la détection de collision : noms des agents
 *  définis + noms des commandes des AUTRES plugins. */
export function buildTakenNames(
  agentNames: string[],
  commands: { plugin: string; name: string }[],
  forPlugin: string,
): Set<string> {
  const taken = new Set(agentNames);
  for (const c of commands) {
    if (c.plugin !== forPlugin) taken.add(c.name);
  }
  return taken;
}

/** Libellé FR du statut d'approbation d'un serveur MCP de plugin. */
export function mcpApprovalLabel(status: PluginMcpServerInfo["status"]): string {
  switch (status) {
    case "approved":
      return "approuvé";
    case "rejected":
      return "rejeté";
    case "pending":
    default:
      return "en attente d'approbation";
  }
}

/** Badge de source d'une skill fichier (P6.8). */
export function fileSkillSourceLabel(source: FileSkill["source"]): string {
  if (source.startsWith("plugin:")) return `plugin ${source.slice("plugin:".length)}`;
  switch (source) {
    case "projet":
      return "projet";
    case "claude":
      return "claude (lecture seule)";
    case "shugu":
    default:
      return "shugu";
  }
}
