// Durable Goal IPC contract. A Goal is an objective; AgentRow records are its
// successive execution attempts.

import { invoke } from "@/lib/tauri";
import type { ExecutionProfile } from "@/lib/agents";

export type GoalStatus = "active" | "waiting" | "paused" | "completed" | "cancelled";

export interface GoalRow {
  id: string;
  conversationId: string;
  workspaceId: string | null;
  title: string;
  objective: string;
  status: GoalStatus;
  role: string;
  model: string;
  protocol: string | null;
  baseUrl: string | null;
  executionProfile: ExecutionProfile;
  isolate: boolean;
  currentAgentId: string | null;
  lastOutput: string | null;
  lastError: string | null;
  resumeCount: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export async function listGoalsByConversation(conversationId: string): Promise<GoalRow[]> {
  return invoke<GoalRow[]>("goal_list_by_conversation", { conversationId });
}

export async function getGoal(goalId: string): Promise<GoalRow> {
  return invoke<GoalRow>("goal_get", { goalId });
}

export async function archiveGoal(goalId: string): Promise<void> {
  return invoke<void>("goal_archive", { goalId });
}
