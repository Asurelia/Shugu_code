import { useQuery } from "convex/react";
import { SEED_CONVOS } from "@/features/chat/chat-sidebar";
import { convexEnabled } from "@/lib/convex";
import { api } from "../../../convex/_generated/api";

export interface ConversationsResult {
  data: any[] | undefined;
  isLoading: boolean;
  source: "convex" | "mock";
}

export function useConversations(): ConversationsResult {
  // convexEnabled is a module-level constant derived from import.meta.env,
  // so this branch is stable across all renders for a given build.
  if (!convexEnabled) {
    return { data: SEED_CONVOS, isLoading: false, source: "mock" };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const data = useQuery(api.conversations.list, {});
  return { data, isLoading: data === undefined, source: "convex" };
}
