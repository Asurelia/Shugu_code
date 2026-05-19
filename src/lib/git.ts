// Shugu Forge — Tauri IPC wrappers for the git command surface (LOT 2).
//
// One thin function per Rust command defined in
// `src-tauri/src/commands/git.rs`. The Rust commands carry
// `#[tauri::command(rename_all = "camelCase")]` on multi-word args, so JS
// must pass camelCase keys (e.g. `{ hunkPatch }`, `{ maxCount }`).
//
// Contract source: `docs/git-ipc-contract.md`. The TS types mirror the
// `serde(rename_all = "camelCase")` Rust structs.
//
// Optional args are sent as `null` rather than omitted — Tauri's serde
// resolves JSON `null` → Rust `Option::None` reliably across feature
// flags, while a missing key can be rejected when serde is strict.

import { invoke } from "@/lib/tauri";
import type {
  DiffSource,
  GitBlameLine,
  GitBranchList,
  GitFileStatus,
  GitLogEntry,
  GitRemote,
  GitStash,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Repository probes
// ---------------------------------------------------------------------------

export async function gitIsRepo(): Promise<boolean> {
  return invoke<boolean>("git_is_repo");
}

export async function gitShowHead(path: string): Promise<string | null> {
  return invoke<string | null>("git_show_head", { path });
}

// ---------------------------------------------------------------------------
// Status / diff / blame
// ---------------------------------------------------------------------------

export async function gitStatus(): Promise<GitFileStatus[]> {
  return invoke<GitFileStatus[]>("git_status");
}

export async function gitDiffFile(path: string, vs: DiffSource): Promise<string> {
  return invoke<string>("git_diff_file", { path, vs });
}

export async function gitBlame(path: string): Promise<GitBlameLine[]> {
  return invoke<GitBlameLine[]>("git_blame", { path });
}

// ---------------------------------------------------------------------------
// Index mutators (stage / unstage / discard / hunk-grained)
// ---------------------------------------------------------------------------

export async function gitStage(paths: string[]): Promise<void> {
  await invoke<void>("git_stage", { paths });
}

export async function gitUnstage(paths: string[]): Promise<void> {
  await invoke<void>("git_unstage", { paths });
}

export async function gitDiscard(paths: string[]): Promise<void> {
  await invoke<void>("git_discard", { paths });
}

export async function gitStageHunk(path: string, hunkPatch: string): Promise<void> {
  await invoke<void>("git_stage_hunk", { path, hunkPatch });
}

export async function gitUnstageHunk(path: string, hunkPatch: string): Promise<void> {
  await invoke<void>("git_unstage_hunk", { path, hunkPatch });
}

// ---------------------------------------------------------------------------
// Commit / history
// ---------------------------------------------------------------------------

/** Returns the new commit OID (40-char SHA). */
export async function gitCommit(message: string, amend: boolean): Promise<string> {
  return invoke<string>("git_commit", { message, amend });
}

export async function gitLog(
  maxCount: number,
  branch?: string | null,
): Promise<GitLogEntry[]> {
  return invoke<GitLogEntry[]>("git_log", { maxCount, branch: branch ?? null });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export async function gitBranches(): Promise<GitBranchList> {
  return invoke<GitBranchList>("git_branches");
}

export async function gitCheckout(branch: string, create: boolean): Promise<void> {
  await invoke<void>("git_checkout", { branch, create });
}

// ---------------------------------------------------------------------------
// Remote sync
// ---------------------------------------------------------------------------

/** Returns the CLI stdout summary (multi-line). */
export async function gitPush(remote: string, branch: string): Promise<string> {
  return invoke<string>("git_push", { remote, branch });
}

export async function gitPull(remote: string, branch: string): Promise<string> {
  return invoke<string>("git_pull", { remote, branch });
}

export async function gitFetch(remote?: string | null): Promise<string> {
  return invoke<string>("git_fetch", { remote: remote ?? null });
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

export async function gitStashList(): Promise<GitStash[]> {
  return invoke<GitStash[]>("git_stash_list");
}

export async function gitStashSave(message?: string | null): Promise<void> {
  await invoke<void>("git_stash_save", { message: message ?? null });
}

export async function gitStashApply(index: number, pop: boolean): Promise<void> {
  await invoke<void>("git_stash_apply", { index, pop });
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

export async function gitRemotes(): Promise<GitRemote[]> {
  return invoke<GitRemote[]>("git_remotes");
}

export async function gitRemoteAdd(name: string, url: string): Promise<void> {
  await invoke<void>("git_remote_add", { name, url });
}

export async function gitRemoteRemove(name: string): Promise<void> {
  await invoke<void>("git_remote_remove", { name });
}
