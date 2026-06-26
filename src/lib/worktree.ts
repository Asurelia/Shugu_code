// Shugu Forge — wrappers IPC typés pour le merge-back / discard d'un run isolé
// (Phase 7 #4 — l'isolation worktree devient le défaut en mode Agent).
//
// Même patron que `src/lib/git.ts` : une fonction fine par commande Rust
// (`src-tauri/src/commands/worktree.rs`), aucun state, aucun React. Les
// commandes portent `#[command(rename_all = "camelCase")]` côté Rust, donc on
// passe `{ branch }` en camelCase. `MergeReport` reflète le struct Rust
// (`#[serde(rename_all = "camelCase")]`, champs optionnels omis si absents).
//
// Contrat backend (déjà mergé/compilé — NE PAS modifier) :
//   - worktree_merge_back({ branch }) -> MergeReport
//       outcome "merged"/"no-changes" → le worktree est nettoyé côté backend.
//       outcome "conflict"/"dirty"    → le worktree est GARDÉ (l'utilisateur
//                                        résout puis réessaie).
//       Peut throw (Err string) : HEAD détachée sur le dépôt, ou panne git.
//   - worktree_discard({ branch }) -> void
//       Supprime le worktree + sa branche sans merger. Idempotent.

import { invoke } from "@/lib/tauri";
import type { AgentEvent } from "@/lib/agents";

// ────────────────────────────────────────────────────────────────────
// Types (miroir des structs Rust sérialisés camelCase)
// ────────────────────────────────────────────────────────────────────

/** Rapport d'un merge-back déclenché par l'utilisateur (bouton « Merger »). */
export interface MergeReport {
  /** "merged" | "no-changes" | "conflict" | "dirty". */
  outcome: "merged" | "no-changes" | "conflict" | "dirty" | (string & {});
  /** Présent sur "merged" : l'OID du commit de merge landé dans l'arbre user. */
  commit?: string;
  /** Présent sur "conflict" : les chemins en conflit (à résoudre puis réessayer). */
  files?: string[];
}

// ────────────────────────────────────────────────────────────────────
// Command wrappers
// ────────────────────────────────────────────────────────────────────

/**
 * Merge la branche d'un run isolé dans l'arbre de l'utilisateur. Sur
 * `merged`/`no-changes` le worktree est nettoyé côté backend ; sur
 * `conflict`/`dirty` il est GARDÉ pour que l'utilisateur résolve puis réessaie.
 * Rejette (Err string) si la HEAD du dépôt est détachée ou sur panne git.
 */
export async function worktreeMergeBack(branch: string): Promise<MergeReport> {
  return invoke<MergeReport>("worktree_merge_back", { branch });
}

/**
 * Rejette un run isolé : supprime le worktree + sa branche SANS merger (le
 * checkout principal n'a jamais été touché). Idempotent — un worktree déjà
 * nettoyé renvoie sans erreur.
 */
export async function worktreeDiscard(branch: string): Promise<void> {
  await invoke<void>("worktree_discard", { branch });
}

// ────────────────────────────────────────────────────────────────────
// Extraction du statut d'isolation depuis le transcript (pur, testable)
// ────────────────────────────────────────────────────────────────────

/** L'état d'isolation worktree dérivé du transcript d'un agent.
 *  « Dernier de chaque type gagne » : un run peut émettre plusieurs events au
 *  fil de sa vie (started → finalized), on ne garde que le plus récent. */
export interface WorktreeStatus {
  /** Dernier `worktreeStarted` du transcript (run lancé dans un worktree isolé). */
  started?: Extract<AgentEvent, { kind: "worktreeStarted" }>;
  /** Dernier `worktreeFinalized` (résultat : merged / no-changes / discarded / diff). */
  finalized?: Extract<AgentEvent, { kind: "worktreeFinalized" }>;
  /** Dernier `worktreeSkipped` (l'isolation demandée a échoué → run in-place). */
  skipped?: Extract<AgentEvent, { kind: "worktreeSkipped" }>;
}

/**
 * Extrait le statut d'isolation worktree d'une liste d'events de transcript.
 * Pour chaque type d'event worktree, le DERNIER rencontré (ordre chronologique)
 * gagne — un run finalisé écrase son `started`, un re-merge après conflit écrase
 * un finalize précédent, etc. Retourne un objet vide quand aucun event worktree
 * n'est présent (run in-place classique non isolé).
 */
export function extractWorktreeStatus(events: AgentEvent[]): WorktreeStatus {
  const status: WorktreeStatus = {};
  for (const ev of events) {
    if (ev.kind === "worktreeStarted") status.started = ev;
    else if (ev.kind === "worktreeFinalized") status.finalized = ev;
    else if (ev.kind === "worktreeSkipped") status.skipped = ev;
  }
  return status;
}

/**
 * `true` quand un run est ACTUELLEMENT isolé : il a démarré dans un worktree et
 * n'a pas encore été finalisé. Sert au badge « 🔒 isolé » près du composer et à
 * la carte « run en cours » du panneau Agents.
 */
export function isWorktreeRunActive(status: WorktreeStatus): boolean {
  return status.started !== undefined && status.finalized === undefined;
}
