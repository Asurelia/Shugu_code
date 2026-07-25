// Shugu Forge — P6.4 hooks de cycle de vie : bindings IPC (mirrors Rust
// commands::agents::hooks). Types camelCase alignés sur HookInfo/HookTestResult.

import { invoke } from "@/lib/tauri";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PreCompact"
  | "Stop"
  | (string & {});

export type HookOutcomeName =
  | "ok"
  | "context"
  | "block"
  | "timeout"
  | "error"
  | "block-ignored"
  | (string & {});

/** Un hook tel que listé par `hooks_list` (user + projet, annoté disabled). */
export interface HookInfo {
  id: string;
  event: HookEventName;
  matcher: string | null;
  command: string;
  timeoutSecs: number;
  async: boolean;
  /** "user" (~/.shugu/hooks.json) | "project" (<workspace>/.shugu/hooks.json). */
  source: "user" | "project" | (string & {});
  disabled: boolean;
}

export async function hooksList(): Promise<HookInfo[]> {
  return invoke<HookInfo[]>("hooks_list");
}

/** Active/désactive un hook — persisté dans SQLite settings (`hooks.disabled`),
 *  le hooks.json de l'utilisateur n'est jamais réécrit. Renvoie la liste d'ids
 *  désactivés à jour. */
export async function hooksSetDisabled(id: string, disabled: boolean): Promise<string[]> {
  return invoke<string[]>("hooks_set_disabled", { id, disabled });
}

/** Résultat de l'action « tester » (même exécution confinée qu'en production). */
export interface HookTestResult {
  outcome: HookOutcomeName;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export async function hooksTest(id: string): Promise<HookTestResult> {
  return invoke<HookTestResult>("hooks_test", { id });
}
