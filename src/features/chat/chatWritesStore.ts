// src/features/chat/chatWritesStore.ts
// Shugu Forge — Lot A (Task 12) — journal d'annulation par message AI.
//
// Quand chat_send tourne avec write_tools=ON, le backend écrit des fichiers
// pendant la boucle d'outils puis émet `chat://writes` { conversationId,
// records: [{ path, before }] } à la fin du tour. chat-sync capte ces records
// et, à la persistance du message AI, les associe à l'id de ce message ICI.
//
// Le bouton « Annuler les modifications de ce message » (views-chat.tsx) lit ce
// store via useChatWrites(messageId) ; s'il y a des records, il invoke
// `chat_revert_writes` puis vide le store pour ce message.
//
// Pattern TanStack-cached (calqué sur editorSelectionStore.ts) : setQueryData /
// getQueryData / useQuery. Un seul container (Record<messageId, records[]>) plutôt
// qu'une queryKey par message — la map est petite (un tour de chat n'écrit que
// quelques fichiers) et évite la prolifération de clés à nettoyer.
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

/** Une écriture du tour — miroir exact de Rust ChatWriteRecord (camelCase). */
export interface ChatWriteRecord {
  path: string;
  /** Contenu d'avant. null/undefined = le fichier a été créé (→ annuler = supprimer). */
  before?: string | null;
}

const KEY = ["chat", "writesByMessage"] as const;

type WritesMap = Record<string, ChatWriteRecord[]>;

/** Associe un journal d'écritures à un message AI. [] efface l'entrée. */
export function setChatWrites(messageId: string, records: ChatWriteRecord[]): void {
  queryClient.setQueryData<WritesMap>(KEY, (prev) => {
    const next: WritesMap = { ...(prev ?? {}) };
    if (records.length === 0) {
      delete next[messageId];
    } else {
      next[messageId] = records;
    }
    return next;
  });
}

/** Lecture non-hook (pour le send path / handlers). */
export function getChatWrites(messageId: string): ChatWriteRecord[] {
  const map = queryClient.getQueryData<WritesMap>(KEY);
  return map?.[messageId] ?? [];
}

// ── Annulations d'écritures d'AGENT (mode transcript) ──────────────────────
// En mode agent, la carte est alimentée par le transcript (events `write`), qui
// garde ses records même après un undo → sans mémoire, la carte réapparaîtrait
// en revenant sur la conversation. On note les messages déjà annulés (niveau
// session ; après un redémarrage les fichiers sont déjà restaurés, donc inutile
// de persister). Le store chat-direct, lui, vide simplement son entrée.
const revertedAgentMessages = new Set<string>();
export function markAgentWritesReverted(messageId: string): void {
  revertedAgentMessages.add(messageId);
}
export function isAgentWritesReverted(messageId: string): boolean {
  return revertedAgentMessages.has(messageId);
}

/** Hook réactif (pour le bouton Annuler sous un message). */
export function useChatWrites(messageId: string): ChatWriteRecord[] {
  const { data } = useQuery<WritesMap>({
    queryKey: KEY,
    queryFn: () => queryClient.getQueryData<WritesMap>(KEY) ?? {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data?.[messageId] ?? [];
}
