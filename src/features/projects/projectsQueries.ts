// Shugu Forge — project registry hooks (V18).
//
// A project = an opened folder. `db.projects` is the source of truth (SQLite);
// these hooks expose it through TanStack. The "current project" is resolved from
// the workspace root (`fsGetWorkspaceRoot`) — opening a folder upserts its row.

import { useQuery } from "@tanstack/react-query";
import { db } from "@/lib/db";
import type { ProjectRow } from "@/lib/db";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { fsKeys } from "@/features/fs/keys";
import { projectKeys } from "./keys";

/** All registered projects (those with a folder), most-recently-opened first. */
export function useProjects() {
  return useQuery({
    queryKey: projectKeys.list(),
    queryFn: () => db.projects.list(),
    staleTime: 30_000,
  });
}

/** Active-conversation count per project id (+ GLOBAL_BUCKET for unassigned). */
export function useProjectCounts() {
  return useQuery({
    queryKey: projectKeys.counts(),
    queryFn: () => db.projects.conversationCounts(),
    staleTime: 30_000,
  });
}

/**
 * The project for the currently-open folder, or null when no folder is open.
 * Resolving upserts the project row (so opening a folder registers it and bumps
 * last_opened_at).
 */
export function useCurrentProject() {
  const { data: root } = useQuery({
    queryKey: fsKeys.workspaceRoot(),
    queryFn: fsGetWorkspaceRoot,
    staleTime: Infinity,
    retry: false,
  });
  return useQuery({
    queryKey: projectKeys.current(root ?? null),
    queryFn: async (): Promise<ProjectRow | null> => {
      if (!root) return null;
      return db.projects.upsertForRoot(root);
    },
    staleTime: Infinity,
  });
}

/**
 * Imperative resolver of the current project id — for non-hook call sites
 * (conversation creation). Best-effort: returns null (global) if no folder is
 * open or on any error.
 */
export async function resolveCurrentProjectId(): Promise<string | null> {
  try {
    const root = await fsGetWorkspaceRoot();
    if (!root) return null;
    const proj = await db.projects.upsertForRoot(root);
    return proj.id;
  } catch (e) {
    console.warn("[projects] resolveCurrentProjectId failed:", e);
    return null;
  }
}
