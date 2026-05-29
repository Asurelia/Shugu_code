// Shugu Forge — OpenAI Codex CLI bridge frontend bindings.
//
// Mirrors `src-tauri/src/commands/codex.rs`. Codex is the user's ChatGPT
// subscription driven through the local `codex` binary (shell-out, no API key).
// These are thin `invoke` wrappers + the shared types; no React, no state.
//
// Honesty note baked into the data model: per-run token counts are EXACT
// (OpenAI's own `turn.completed.usage`), but the subscription's authoritative
// quota (5h/weekly %) is NOT exposed headless — so `CodexWindow` is a LOCAL
// rolling-window ESTIMATE the UI must label as such.

import { invoke } from "@/lib/tauri";
import { getConfig, setConfig } from "@/lib/credentials";

export interface CodexAuth {
  /** True iff the ACTIVE home's `auth.json` exists (we never read its contents). */
  loggedIn: boolean;
  path: string;
  /** True iff a runnable `codex` binary was resolved. */
  binaryFound: boolean;
  binary: string | null;
  /** True iff Shugu uses a DEDICATED Codex home (isolated from the terminal). */
  dedicated: boolean;
}

export interface CodexUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Rolling-window aggregate — a LOCAL estimate, not OpenAI's real quota. */
export interface CodexWindow {
  windowSecs: number;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CodexRunRow {
  runId: string;
  ts: number;
  model: string;
  surface: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface CodexLimitEvent {
  ts: number;
  kind: string;
  message: string;
}

/** Rolling-window seconds for the two estimate gauges. Codex Plus/Pro limits
 * reset on a ~5h rolling window + a weekly window. */
export const CODEX_WINDOW_5H = 5 * 60 * 60;
export const CODEX_WINDOW_WEEK = 7 * 24 * 60 * 60;

/** Auth + binary status — drives the Connections card and the chat zero-config
 * auto-enable (logged in ⇒ Codex shows up in the picker without ceremony). */
export async function codexAuthStatus(): Promise<CodexAuth> {
  return invoke<CodexAuth>("codex_auth_status");
}

/** Convenience: is Codex usable right now (binary resolved AND logged in)? */
export async function codexReady(): Promise<boolean> {
  try {
    const s = await codexAuthStatus();
    return s.binaryFound && s.loggedIn;
  } catch {
    return false;
  }
}

/** Summed REAL token usage over a trailing window (local estimate of quota use). */
export async function codexUsageWindow(windowSecs: number): Promise<CodexWindow> {
  return invoke<CodexWindow>("codex_usage_window", { windowSecs });
}

/** Recent runs with EXACT per-run token counts (newest first). */
export async function codexUsageRecent(limit = 20): Promise<CodexRunRow[]> {
  return invoke<CodexRunRow[]>("codex_usage_recent", { limit });
}

/** Most recent detected "limite atteinte" event, if any. */
export async function codexLimitRecent(): Promise<CodexLimitEvent | null> {
  return invoke<CodexLimitEvent | null>("codex_limit_recent");
}

// ── Native models + real rate limits (via the app-server) ──────────────

/** One model the user's Codex account offers, with its allowed reasoning efforts. */
export interface CodexModel {
  /** Stable id to pass to a turn (the picker uses `codex/<model>`). */
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  /** none | minimal | low | medium | high | xhigh (subset per model). */
  supportedEfforts: string[];
}

/** List the account's real models (GPT-5.5, 5.4, …) + their reasoning efforts.
 *  Spawns/uses the persistent app-server connection. */
export async function codexModels(): Promise<CodexModel[]> {
  return invoke<CodexModel[]>("codex_models");
}

/** One rate-limit window (primary ≈ 5h, secondary ≈ weekly). REAL data. */
export interface CodexRateWindow {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface CodexRateLimits {
  primary: CodexRateWindow | null;
  secondary: CodexRateWindow | null;
  planType: string | null;
}

/** The account's REAL rate limits from OpenAI (not the local estimate). */
export async function codexRateLimits(): Promise<CodexRateLimits> {
  return invoke<CodexRateLimits>("codex_rate_limits");
}

// ── Account connection (in-app login) ──────────────────────────────────

/** Run `codex login` (browser OAuth by default, or device-code flow). Streams
 *  progress on the `codex://login` Tauri event so the UI can show the device
 *  code / URL. Resolves when login completes (or rejects on failure/timeout).
 *  Respects the dedicated-vs-shared home (handled Rust-side). */
export async function codexLogin(deviceAuth = false): Promise<void> {
  return invoke<void>("codex_login", { deviceAuth });
}

/** Run `codex logout` for the active account (dedicated or shared). */
export async function codexLogout(): Promise<void> {
  return invoke<void>("codex_logout");
}

// ── Dedicated-vs-shared toggle (persisted in the settings table; Rust reads
//    the same `provider.codex.dedicated` row to set CODEX_HOME on every spawn) ──

/** Is Shugu set to use a DEDICATED Codex account (isolated from the terminal)? */
export async function codexGetDedicated(): Promise<boolean> {
  return (await getConfig("codex", "dedicated")) === "true";
}

/** Switch between shared (terminal-global ~/.codex) and Shugu-dedicated CODEX_HOME. */
export async function codexSetDedicated(on: boolean): Promise<void> {
  await setConfig("codex", "dedicated", on ? "true" : "false");
}
