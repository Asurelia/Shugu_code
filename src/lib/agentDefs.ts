// Shugu Forge — wrappers Tauri pour les définitions d'agents portables
// (format Claude Code : `.md` avec frontmatter YAML).
//
// Source de vérité = fichiers sur disque :
//   - global    : `~/.claude/agents/*.md`
//   - workspace : `<workspace>/.claude/agents/*.md`
//
// Côté Shugu, `~/.shugu/agents` est une junction NTFS (Windows) / symlink
// (Unix) vers `~/.claude/agents`, idem au niveau projet. Édition unique,
// portable d'un outil à l'autre (Claude Code / Codex / Pi / Shugu).
//
// Voir le module Rust `src-tauri/src/commands/agent_defs.rs` pour le parsing
// (gray_matter + serde_yaml) et la gestion du lien/seed.

import { invoke } from "@/lib/tauri";

/** Périmètre d'un agent : global = `~/.claude/agents`, workspace =
 *  `<ws>/.claude/agents`. "all" agrège les deux (workspace silencieusement
 *  skippé si aucun workspace n'est ouvert). */
export type AgentDefScope = "global" | "workspace" | "all";

/** Origine d'un agent — drive l'affichage du badge dans la grille. */
export type AgentDefOrigin = "builtin" | "user" | "model";

/** Vue Frontend d'un agent. `path` et `scope` sont calculés par le backend
 *  (jamais inscrits dans le frontmatter écrit sur disque). */
export interface AgentDef {
  name: string;
  description: string;
  model?: string;
  tools: string[];
  icon?: string;
  color?: string;
  origin: AgentDefOrigin;
  enabled: boolean;
  baseRole: string;
  /** Chemin absolu du `.md` côté `.claude/agents/` (jamais via le lien Shugu). */
  path: string;
  /** "workspace" | "global" — déduit du chemin par le backend. */
  scope: "workspace" | "global";
  /** System prompt = body du `.md` après le frontmatter. */
  body: string;
}

/** Liste les agents d'un scope. `agent_def_list` côté Rust s'assure que les
 *  dossiers et le lien Shugu existent (idempotent à chaque appel). */
export async function listAgentDefs(scope: AgentDefScope = "all"): Promise<AgentDef[]> {
  return invoke<AgentDef[]>("agent_def_list", { scope });
}

/** Recharge un agent depuis son path absolu — utile après édition externe
 *  (Claude Code, vim) si on veut un read ciblé plutôt qu'un refetch complet. */
export async function readAgentDef(path: string): Promise<AgentDef> {
  return invoke<AgentDef>("agent_def_read", { path });
}

/** Écrit/met à jour un agent. Si `def.path` est vide, le path est dérivé du
 *  scope + nom (sanitization alphanumérique côté Rust). Atomique (tmp+rename)
 *  pour qu'un crash n'expose jamais un frontmatter tronqué à Claude Code. */
export async function writeAgentDef(def: AgentDef): Promise<string> {
  return invoke<string>("agent_def_write", { def });
}

/** Supprime un agent (par chemin absolu). Garde-fou côté Rust : refus si le
 *  parent n'est pas un dossier `agents/`. */
export async function deleteAgentDef(path: string): Promise<void> {
  return invoke<void>("agent_def_delete", { path });
}
