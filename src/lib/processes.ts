// Shugu Forge — P6.9 sessions shell persistantes + processus d'arrière-plan :
// bindings IPC (mirrors Rust commands::agents::processes).

import { invoke } from "@/lib/tauri";

/** Un processus d'arrière-plan suivi en SQLite (statuts honnêtes après reload). */
export interface BackgroundRow {
  id: string;
  runId: string;
  command: string;
  cwd: string;
  pid: number;
  /** "running" | "exited" | "interrupted" | "killed". */
  status: string;
  exitCode: number | null;
  createdAt: number;
  endedAt: number | null;
  outputTail: string;
}

export interface SessionInfo {
  id: string;
  alive: boolean;
}

export interface ProcessesOverview {
  sessions: SessionInfo[];
  processes: BackgroundRow[];
}

/** Sessions + processus d'arrière-plan d'un run. */
export async function agentProcessList(runId: string): Promise<ProcessesOverview> {
  return invoke<ProcessesOverview>("agent_process_list", { runId });
}

export interface ProcessOutputView {
  id: string;
  status: string;
  exitCode: number | null;
  tail: string;
}

/** Queue bornée d'un processus d'arrière-plan (vivant ou snapshot SQLite). */
export async function agentProcessOutput(id: string): Promise<ProcessOutputView> {
  return invoke<ProcessOutputView>("agent_process_output", { id });
}

/** Tue un processus d'arrière-plan (arbre). false = déjà terminal/introuvable. */
export async function agentProcessStop(id: string): Promise<boolean> {
  return invoke<boolean>("agent_process_stop", { id });
}
