// Shugu Forge — P6.3 rewind par tour : bindings IPC (mirrors Rust).
//
//   - conversation_fork_at   → commands::conversations::conversation_fork_at
//   - shugu_snapshot_preview → commands::snapshot::shugu_snapshot_preview
//   - shugu_snapshot_rewind  → commands::snapshot::shugu_snapshot_rewind
//
// Types camelCase alignés sur les serde côté Rust (ForkResult, SnapshotPreview,
// RewindResult, Snapshot). Module mince : types + invoke, aucune logique.

import { invoke } from "@/lib/tauri";

/** Résultat d'un fork de conversation (mirror de ForkResult côté Rust). */
export interface ForkResult {
  conversationId: string;
  title: string;
  copiedMessages: number;
  forkPointAgentId: string | null;
}

/** Fork une conversation au message donné : la NOUVELLE conversation contient
 *  les messages jusqu'à ce message inclus ; la source est conservée intacte. */
export async function forkConversationAt(
  conversationId: string,
  messageId: string,
): Promise<ForkResult> {
  return invoke<ForkResult>("conversation_fork_at", { conversationId, messageId });
}

/** Un checkpoint de tour (`refs/shugu/turn/<id>`) — mirror de Snapshot. */
export interface Snapshot {
  turnId: string;
  refName: string;
  oid: string;
  tree: string;
  parent: string | null;
  createdAt: number;
}

/** Ce qu'un rewind changerait — alimente la boîte de confirmation AVANT décision. */
export interface SnapshotPreview {
  turnId: string;
  refName: string;
  /** Fichiers suivis qui seraient restaurés à l'état du checkpoint. */
  restored: string[];
  /** Fichiers non suivis (créés après le checkpoint) qui seraient supprimés. */
  removed: string[];
}

export async function snapshotPreview(turnId: string): Promise<SnapshotPreview> {
  return invoke<SnapshotPreview>("shugu_snapshot_preview", { turnId });
}

/** Résultat du rewind gardé (mirror de RewindResult côté Rust). */
export interface RewindResult {
  snapshot: Snapshot;
  /** Checkpoint de secours pris avant le revert (rewind rewindable) ; null si
   *  sa capture a échoué — l'UI doit le dire honnêtement. */
  safetyRef: string | null;
  restored: string[];
  removed: string[];
}

/** Rewind fichiers gardé : checkpoint de secours puis revert + event
 *  `rewindApplied` persisté sur le flux du run. Double appel idempotent-safe. */
export async function snapshotRewind(
  turnId: string,
  kind?: "files" | "both",
  forkedConversationId?: string,
): Promise<RewindResult> {
  return invoke<RewindResult>("shugu_snapshot_rewind", { turnId, kind, forkedConversationId });
}
