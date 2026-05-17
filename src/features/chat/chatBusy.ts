// Shugu Forge — chat busy flag (TanStack-backed).
//
// `busy` = "the model is generating right now". Set par ChatPanel quand
// `send()` fire, clear quand `sendChatMessage()` resolve. Read par
// ChibiWithMood pour driver son mood (busy ⇒ peek_thinking).
//
// Refactor 2026-05-17 : ancien store custom (subscribers/publishers
// manuel) → TanStack Query avec setQueryData. Pas de fetch — la query
// existe juste comme "slot de state observable" partagé. Cohérent avec
// la directive TanStack-only (plus aucun pattern subscriber artisanal).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

const CHAT_BUSY_KEY = ["chat", "busy"] as const;

/** Lit le flag de manière non-réactive (helpers hors-React). */
export function getChatBusy(): boolean {
  return queryClient.getQueryData<boolean>(CHAT_BUSY_KEY) ?? false;
}

/** Set le flag. Déclenche un re-render des consumers `useChatBusy()`. */
export function setChatBusy(value: boolean): void {
  if (getChatBusy() === value) return;
  queryClient.setQueryData<boolean>(CHAT_BUSY_KEY, value);
}

/** Hook React-réactif sur le flag chat-busy. */
export function useChatBusy(): boolean {
  const { data } = useQuery<boolean>({
    queryKey: CHAT_BUSY_KEY,
    queryFn: () => false, // initial only — setChatBusy override
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? false;
}
