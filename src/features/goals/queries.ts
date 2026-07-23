import { useQuery } from "@tanstack/react-query";
import { listGoalsByConversation } from "@/lib/goals";

export const goalKeys = {
  all: ["goals"] as const,
  byConversation: (conversationId: string) =>
    [...goalKeys.all, "conversation", conversationId] as const,
};

export function useGoalsByConversation(conversationId: string | null | undefined) {
  return useQuery({
    queryKey: goalKeys.byConversation(conversationId ?? "__none__"),
    queryFn: () =>
      conversationId ? listGoalsByConversation(conversationId) : Promise.resolve([]),
    enabled: !!conversationId,
    staleTime: 0,
  });
}
