// Shugu Forge — TanStack Query hooks for the agent skill library.
//
// A role's learned skills (Voyager / Hermes): the agent saves a skill that the
// real environment VERIFIED (a `run_command` test exited 0), and every future
// run loads them back into context. The main agent panel reads this list; after
// an Atelier run that may have captured a skill, call `invalidateSkills(role)`.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { skillsList, type SkillRow } from "@/lib/agents";

export const skillKeys = {
  all: ["skills"] as const,
  list: (role: string) => ["skills", role] as const,
};

/** Skills a role has learned + saved (Voyager/Hermes), newest first. */
export function useSkillsList(role: string) {
  return useQuery<SkillRow[]>({
    queryKey: skillKeys.list(role),
    queryFn: () => skillsList(role),
    staleTime: 5_000,
  });
}

/** Refetch a role's skill library (after a run that may have saved a skill). */
export function invalidateSkills(role: string): void {
  void queryClient.invalidateQueries({ queryKey: skillKeys.list(role) });
}
