// Shugu Forge — TanStack Query hooks for the Continual Harness panel.
//
// Reads (generations + per-generation metrics) are TanStack queries so the
// panel refetches on invalidation. Mutations (rollback, manual save, feedback,
// refiner config) are thin wrappers around the Tauri commands in
// `@/lib/agents`; the panel calls them then `invalidateHarness(role)`.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import {
  listHarnessGenerations,
  harnessMetrics,
  benchList,
  type HarnessGeneration,
  type HarnessMetric,
  type BenchTaskRow,
} from "@/lib/agents";

export const harnessKeys = {
  all: ["harness"] as const,
  generations: (role: string) => ["harness", "generations", role] as const,
  metrics: (role: string) => ["harness", "metrics", role] as const,
  benchTasks: (role: string) => ["harness", "bench", role] as const,
};

/** Every generation of a role's harness, newest first (evolution log). */
export function useHarnessGenerations(role: string) {
  return useQuery<HarnessGeneration[]>({
    queryKey: harnessKeys.generations(role),
    queryFn: () => listHarnessGenerations(role),
    staleTime: 5_000,
  });
}

/** Per-generation outcome metrics for a role. */
export function useHarnessMetrics(role: string) {
  return useQuery<HarnessMetric[]>({
    queryKey: harnessKeys.metrics(role),
    queryFn: () => harnessMetrics(role),
    staleTime: 5_000,
  });
}

/** Refetch both harness queries for a role after a mutation. */
export function invalidateHarness(role: string): void {
  void queryClient.invalidateQueries({ queryKey: harnessKeys.generations(role) });
  void queryClient.invalidateQueries({ queryKey: harnessKeys.metrics(role) });
}

/** Enabled bench tasks for a role (the suite the panel can run / seed). */
export function useBenchList(role: string) {
  return useQuery<BenchTaskRow[]>({
    queryKey: harnessKeys.benchTasks(role),
    queryFn: () => benchList(role),
    staleTime: 5_000,
  });
}

/** Refetch the bench task list for a role (after seeding / adding tasks). */
export function invalidateBench(role: string): void {
  void queryClient.invalidateQueries({ queryKey: harnessKeys.benchTasks(role) });
}
