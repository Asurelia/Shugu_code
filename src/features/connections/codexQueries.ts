// Shugu Forge — TanStack Query hooks for the Codex CLI bridge.
//
// Auth/binary status + usage tracking. Usage windows are LOCAL estimates built
// from real per-run token counts (OpenAI doesn't expose the subscription's real
// quota headless — see lib/codex.ts).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import {
  codexAuthStatus,
  codexUsageWindow,
  codexUsageRecent,
  codexLimitRecent,
  codexRateLimits,
  type CodexAuth,
  type CodexWindow,
  type CodexRunRow,
  type CodexLimitEvent,
  type CodexRateLimits,
} from "@/lib/codex";

export const codexKeys = {
  all: ["codex"] as const,
  auth: ["codex", "auth"] as const,
  window: (secs: number) => ["codex", "window", secs] as const,
  recent: (limit: number) => ["codex", "recent", limit] as const,
  limit: ["codex", "limit"] as const,
  rateLimits: ["codex", "rateLimits"] as const,
};

/** REAL account rate limits via the app-server. May reject when the app-server
 *  is unreachable / not logged in — the panel falls back to the local estimate. */
export function useCodexRateLimits() {
  return useQuery<CodexRateLimits>({
    queryKey: codexKeys.rateLimits,
    queryFn: codexRateLimits,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCodexAuth() {
  return useQuery<CodexAuth>({
    queryKey: codexKeys.auth,
    queryFn: codexAuthStatus,
    staleTime: 5_000,
  });
}

export function useCodexWindow(windowSecs: number) {
  return useQuery<CodexWindow>({
    queryKey: codexKeys.window(windowSecs),
    queryFn: () => codexUsageWindow(windowSecs),
    staleTime: 5_000,
  });
}

export function useCodexRecent(limit = 20) {
  return useQuery<CodexRunRow[]>({
    queryKey: codexKeys.recent(limit),
    queryFn: () => codexUsageRecent(limit),
    staleTime: 5_000,
  });
}

export function useCodexLimit() {
  return useQuery<CodexLimitEvent | null>({
    queryKey: codexKeys.limit,
    queryFn: codexLimitRecent,
    staleTime: 5_000,
  });
}

/** Refetch all Codex state (after a run that recorded usage, or after login). */
export function invalidateCodex(): void {
  void queryClient.invalidateQueries({ queryKey: codexKeys.all });
}
