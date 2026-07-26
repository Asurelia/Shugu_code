// Shugu Forge — P6.7 plugins + P6.8 skills fichiers : bindings IPC
// (mirrors Rust commands::agents::plugins / file_skills). Types camelCase
// alignés sur PluginSummary / PluginCommand / PluginMcpServerInfo / FileSkill.

import { invoke } from "@/lib/tauri";

/** Résumé d'un plugin pour le gestionnaire Settings. */
export interface PluginSummary {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  author: string | null;
  /** "user" | "project" | "claude-cache". */
  source: string;
  enabled: boolean;
  /** Contribution projet détectée mais neutralisée par le gate de confiance. */
  blockedByTrust: boolean;
  commands: number;
  agents: number;
  skills: number;
  hooks: number;
  mcpPending: number;
}

export async function pluginsList(): Promise<PluginSummary[]> {
  return invoke<PluginSummary[]>("plugins_list");
}

/** Persisté en SQLite settings (jamais dans les fichiers de l'utilisateur). */
export async function pluginsSetEnabled(id: string, enabled: boolean): Promise<string[]> {
  return invoke<string[]>("plugins_set_enabled", { id, enabled });
}

/** Une slash command fournie par un plugin (`commands/*.md`). */
export interface PluginCommand {
  plugin: string;
  name: string;
  /** Nom effectif (`plugin:command`) — à utiliser en cas de collision. */
  namespacedName: string;
  description: string;
  allowedTools: string[];
  body: string;
}

export async function pluginsCommands(): Promise<PluginCommand[]> {
  return invoke<PluginCommand[]>("plugins_commands");
}

/** Serveur MCP déclaré par un plugin, avec son statut d'approbation. */
export interface PluginMcpServerInfo {
  plugin: string;
  server: string;
  transport: string;
  commandPreview: string;
  commandHash: string;
  /** "pending" | "approved" | "rejected". */
  status: string;
}

export async function pluginsMcpList(): Promise<PluginMcpServerInfo[]> {
  return invoke<PluginMcpServerInfo[]>("plugins_mcp_list");
}

/** Approuve un serveur MCP de plugin (démarrage réel au prochain run via le
 *  pipeline MCP normal — jamais de démarrage à l'approbation elle-même). */
export async function pluginsMcpApprove(plugin: string, server: string): Promise<void> {
  return invoke<void>("plugins_mcp_approve", { plugin, server });
}

export async function pluginsMcpReject(plugin: string, server: string): Promise<void> {
  return invoke<void>("plugins_mcp_reject", { plugin, server });
}

/** Une skill fichier SKILL.md découverte (listing paresseux, P6.8). */
export interface FileSkill {
  name: string;
  description: string;
  /** "claude" | "shugu" | "projet" | "plugin:<name>". */
  source: string;
  path: string;
}

export async function fileSkillsList(): Promise<FileSkill[]> {
  return invoke<FileSkill[]>("file_skills_list");
}

/** Corps complet d'une skill fichier (prévisualisation lecture seule). */
export async function fileSkillsBody(name: string): Promise<string> {
  return invoke<string>("file_skills_body", { name });
}
