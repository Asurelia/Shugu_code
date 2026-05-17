// Shugu Forge — TanStack mutations for per-message actions (edit / delete /
// regenerate). Introduced in the V6 schema (message_edit_delete_scaffold).
//
// All mutations follow the same pattern:
//   1. Write to SQLite via db.messages.*
//   2. Invalidate the TanStack query cache so all consumers re-fetch
//   3. Emit `chat://messages-changed` so the cross-window sync (mascot) picks up
//
// "Regenerate from here" additionally calls sendChatMessage to re-trigger the
// LLM round-trip after the tail of the conversation is soft-deleted.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { emit } from "@tauri-apps/api/event";
import { db } from "@/lib/db";
import { vecDelete } from "@/lib/vector";
import { sendChatMessage } from "./chat-sync";
import { chatKeys } from "./keys";

const EVT_MESSAGES = "chat://messages-changed";

// ─── useEditMessage ─────────────────────────────────────────────────────────
//
// Edit the text of an existing message. Sets `edited_at` timestamp in SQLite.
// Only `text` is editable (not `body` / code blocks) — the inline editor in
// ChatPanel.tsx surfaces a plain textarea, not a rich markdown editor.

export function useEditMessage(convId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ messageId, newText }: { messageId: string; newText: string }) => {
      await db.messages.editText(messageId, newText.trim());
    },
    onSuccess: async (_data, { messageId: _mid }) => {
      // Invalidate the messages query so the UI re-fetches the updated row.
      await qc.invalidateQueries({ queryKey: chatKeys.messagesByConv(convId) });
      try {
        await emit(EVT_MESSAGES, { conversationId: convId });
      } catch (err) {
        console.warn("[mutations] emit messages-changed after edit failed:", err);
      }
    },
  });
}

// ─── useDeleteMessage ────────────────────────────────────────────────────────
//
// Soft-delete a single message. `deleted_at` is stamped; the SQL query in
// `db.messages.listByConversation` already filters `deleted_at IS NULL`, so
// the message disappears from the UI and from future LLM history without a
// physical DELETE.

export function useDeleteMessage(convId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ messageId }: { messageId: string }) => {
      await db.messages.softDelete(messageId);
      // VEC1 — best-effort remove from semantic index on soft-delete.
      try {
        await vecDelete("messages", messageId);
      } catch (err) {
        console.warn("[mutations] vecDelete messages failed:", err);
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: chatKeys.messagesByConv(convId) });
      try {
        await emit(EVT_MESSAGES, { conversationId: convId });
      } catch (err) {
        console.warn("[mutations] emit messages-changed after delete failed:", err);
      }
    },
  });
}

// ─── useRegenerateFrom ───────────────────────────────────────────────────────
//
// "Regenerate from here" — available on AI messages only.
//
// Steps:
//   1. Soft-delete the target AI message + every message in the conversation
//      whose ts >= the target's ts (the "tail" is pruned).
//   2. `softDeleteFrom` returns the last user message BEFORE the cut point —
//      that is the prompt we re-send to the LLM.
//   3. Invalidate the cache so the pruned tail disappears from the UI.
//   4. Call `sendChatMessage` to kick off a fresh LLM round-trip.
//
// Guard: if no prior user message exists (the very first message in the conv
// was an AI message, which shouldn't happen in normal flow but is defensive),
// the regenerate is a no-op (the tail was still pruned — better than nothing).

export function useRegenerateFrom(convId: string, modelId: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async ({ messageId }: { messageId: string }) => {
      // Prune the tail and get the last user prompt before the cut point.
      const priorUserMsg = await db.messages.softDeleteFrom(messageId, convId);

      // Invalidate before sending so the pruned messages disappear from the
      // UI immediately, before the new response starts streaming in.
      await qc.invalidateQueries({ queryKey: chatKeys.messagesByConv(convId) });
      try {
        await emit(EVT_MESSAGES, { conversationId: convId });
      } catch (err) {
        console.warn("[mutations] emit messages-changed after regenerate prune failed:", err);
      }

      if (!priorUserMsg) {
        // No user message to re-send — tail was pruned, nothing more to do.
        console.warn("[mutations] regenerateFrom: no prior user message found in conv", convId);
        return;
      }

      // Re-trigger the LLM with the prior user text. sendChatMessage handles
      // appending the user message again + streaming the AI reply. It also
      // emits chat://messages-changed internally via appendMessage, so a
      // second emit here is not needed.
      const promptText = (priorUserMsg.text ?? priorUserMsg.body ?? "").trim();
      if (!promptText) {
        console.warn("[mutations] regenerateFrom: prior user message has no text", priorUserMsg.id);
        return;
      }

      await sendChatMessage(convId, promptText, modelId);
    },
  });
}
