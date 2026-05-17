// Shugu Forge — chat unread flag (TanStack-backed).
//
// `hasUnread` = "an AI reply arrived while the panel was closed or tucked
// at an edge". ChatPanel sole writer (owns msgs/input/mode context).
// ChibiWithMood sole reader (factors hasUnread into the peek_open vs
// peek_closed mood decision).
//
// Refactor 2026-05-17 : ancien store custom → TanStack Query avec
// setQueryData. Voir chatBusy.ts pour la motivation (directive
// TanStack-only).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

const CHAT_UNREAD_KEY = ["chat", "unread"] as const;

export function getChatUnread(): boolean {
  return queryClient.getQueryData<boolean>(CHAT_UNREAD_KEY) ?? false;
}

export function setChatUnread(value: boolean): void {
  if (getChatUnread() === value) return;
  queryClient.setQueryData<boolean>(CHAT_UNREAD_KEY, value);
}

export function useChatUnread(): boolean {
  const { data } = useQuery<boolean>({
    queryKey: CHAT_UNREAD_KEY,
    queryFn: () => false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data ?? false;
}
