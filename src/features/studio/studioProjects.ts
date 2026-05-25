// Shugu Forge — Studio projects (Projets tab) data layer.
//
// TanStack ONLY (no custom store): `useStudioProjects()` is a useQuery wrapping
// the Rust commands in `src-tauri/src/commands/studio.rs` (SQLite = source of
// truth). The "current project" pointer uses the synthetic-query pattern (like
// `studioDraft` / `activeDesignSystem`).
//
// A project links to its `conversationId`; the conversation HISTORY is rebuilt
// on demand from `agents`/`agent_events` (see `turnsFromAgents` in studioChat.ts)
// — never duplicated here.

import { useQuery } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";

/** Mirrors the Rust `StudioProject` (camelCase serde). */
export interface StudioProject {
  id: string;
  name: string;
  conversationId: string | null;
  workspaceRoot: string;
  dir: string;
  /** "auto" (per-session, refreshed each generation) | "saved" (frozen fork). */
  kind: "auto" | "saved" | (string & {});
  createdAt: number;
  updatedAt: number;
}

const LIST_KEY = ["studio", "projects"] as const;
const CURRENT_KEY = ["studio", "currentProject"] as const;

/** Projects of the current workspace, newest first (soft-deleted hidden). */
export function useStudioProjects() {
  return useQuery<StudioProject[]>({
    queryKey: LIST_KEY,
    queryFn: () => invoke<StudioProject[]>("studio_project_list"),
    staleTime: 5_000,
  });
}

export function invalidateStudioProjects(): void {
  void queryClient.invalidateQueries({ queryKey: LIST_KEY });
}

/** Id of the project bound to the current Studio session (synthetic query). */
export function useStudioCurrentProject(): string | null {
  return (
    useQuery<string | null>({
      queryKey: CURRENT_KEY,
      queryFn: () => null,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? null
  );
}
export function setStudioCurrentProject(id: string | null): void {
  queryClient.setQueryData<string | null>(CURRENT_KEY, id);
}

// ── Command wrappers (Tauri maps camelCase JS keys → snake_case Rust args) ──

/** Create or refresh the auto-project for `conversationId`; snapshots the
 *  current preview. Returns the project id. */
export function studioProjectUpsertAuto(
  name: string,
  conversationId: string | null,
): Promise<string> {
  return invoke<string>("studio_project_upsert_auto", { name, conversationId });
}

/** Save the current preview as a NEW named, frozen fork. */
export function studioProjectSaveAs(
  name: string,
  conversationId: string | null,
): Promise<string> {
  return invoke<string>("studio_project_save_as", { name, conversationId });
}

/** Restore a project's snapshot into the live preview dir. */
export function studioProjectLoad(id: string): Promise<void> {
  return invoke<void>("studio_project_load", { id });
}

export function studioProjectRename(id: string, name: string): Promise<void> {
  return invoke<void>("studio_project_rename", { id, name });
}

/** Soft-delete (sets deleted_at; the snapshot folder is kept on disk). */
export function studioProjectDelete(id: string): Promise<void> {
  return invoke<void>("studio_project_delete", { id });
}
