// evals/lib/agent.mjs
//
// The headless agent LOOP — a faithful Node port of the Shugu Grounded agent's
// tool-use driver (`src-tauri/src/commands/agents/runner.rs::run_agent_task`).
//
// It uses the SAME system prompt (GROUNDED_PROMPT), the SAME tool surface
// (evals/lib/tools.mjs), and the SAME bounded multi-turn loop:
//   1. send system + history + tools to the model
//   2. if the model returns tool_calls, execute each in the sandbox and feed the
//      results back as one tool_results turn
//   3. loop until the model returns no tool_calls (final answer) or the
//      iteration budget is exhausted
//
// On the LAST iteration we inject a "[Shugu system] FINAL iteration" nudge and
// accept whatever the model produces, exactly like the runner's MAX_ITERATIONS
// handling — so a run always terminates with a transcript and a metric, never
// hangs.

import { callModel } from "./provider.mjs";
import { executeTool, toolDefinitions } from "./tools.mjs";

// Mirrors MAX_ITERATIONS in runner.rs (24). One write→run-test→fix cycle costs
// an iteration, so the budget must leave room to see a real failure and fix it.
export const MAX_ITERATIONS = 24;

// The EXACT Grounded system prompt from runner.rs::GROUNDED_PROMPT, so the eval
// exercises the model under the real operating instructions. Kept verbatim;
// if the Rust prompt changes, update this string (documented in evals/README.md).
export const GROUNDED_PROMPT = `You are Shugu's Grounded agent. You work DIRECTLY on the user's real project, with execution enabled on their machine. Git is the safety net: every change you make is visible in the app's Git panel, where the user can review and discard it. Your job: make the requested change AND prove it works by running the project's own checks.

LOOP (DeepSWE-shaped):
1. UNDERSTAND before editing. Use fs_search and fs_read_file to locate the relevant code and read it FULLY. Never edit a file you have not read.
2. EDIT surgically: fs_edit for changes to existing files, fs_write_file for new ones.
3. VERIFY after every change with run_command. If a verification command was provided below, run EXACTLY that. Otherwise read package.json / Cargo.toml to find the project's own check (typecheck, test, build) and run it.
4. READ the failure. A non-zero exit is INFORMATION, not defeat: read stderr, find the root cause, fix it, then run the check AGAIN.
5. Declare done ONLY when the check passes (exit 0). End with a short plain-text summary of what you changed and why.

TOOLCHAIN: you run on the user's real machine — \`node\`, \`pnpm\`, \`npm\`, \`npx\`, \`cargo\`, \`git\`, etc. resolve exactly as in their terminal, network included.

RULES (you are editing the REAL project — be surgical):
- NEVER run destructive commands outside the task scope: no \`rm\`/\`del\` sweeps, no \`git commit\`, \`git push\`, \`git checkout\`, \`git reset\` unless the task EXPLICITLY asks for it.
- Do not install global tools or modify files outside the workspace unless the task explicitly requires it.
- No drive-by refactors: change what the task needs, nothing else.
- Keep going until the check is green or you exhaust your iteration budget. Honest partial progress beats a confident wrong answer.`;

/**
 * @typedef {Object} AgentRunResult
 * @property {number} iterations        Model turns consumed.
 * @property {number} toolCalls         Total tool invocations.
 * @property {number} toolErrors        Tool invocations that returned is_error.
 * @property {string} finalText         The agent's closing message.
 * @property {string} stopReason        Why the loop ended ("done"|"budget"|"error").
 * @property {{ input: number, output: number }} usage  Token usage (best-effort).
 * @property {import("./provider.mjs").AgentMessage[]} transcript
 * @property {string} [error]           Set when stopReason === "error".
 */

/**
 * Run the Grounded agent on one task inside `sandboxRoot`.
 *
 * @param {Object} params
 * @param {import("./provider.mjs").ProviderConfig} params.provider
 * @param {string} params.sandboxRoot       Absolute path to the throwaway dir.
 * @param {string} params.task              The user task prompt.
 * @param {string} [params.verifyCommand]   Verification command appended to the
 *                                           system prompt (run EXACTLY this).
 * @param {number} [params.maxIterations]
 * @param {(ev: object) => void} [params.onEvent]  Progress callback.
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<AgentRunResult>}
 */
export async function runAgentTask(params) {
  const {
    provider,
    sandboxRoot,
    task,
    verifyCommand,
    maxIterations = MAX_ITERATIONS,
    onEvent = () => {},
    signal,
  } = params;

  // System prompt = GROUNDED_PROMPT + the task's verification command (matches
  // mod.rs: it appends the VERIFICATION COMMAND block so the agent runs it).
  let system = GROUNDED_PROMPT;
  if (verifyCommand && verifyCommand.trim()) {
    system += `\n\nVERIFICATION COMMAND (run EXACTLY this with run_command after each change, iterate until it exits 0):\n${verifyCommand.trim()}\n`;
  }

  const tools = toolDefinitions({ runCommand: true });

  /** @type {import("./provider.mjs").AgentMessage[]} */
  const history = [{ kind: "user", content: task }];

  let iterations = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let finalText = "";
  let stopReason = "budget";
  const usage = { input: 0, output: 0 };

  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      stopReason = "error";
      return finish({ error: "aborted" });
    }
    iterations++;
    const isFinal = i === maxIterations - 1;

    if (isFinal) {
      history.push({
        kind: "user",
        content:
          "[Shugu system] FINAL iteration — no more tool calls will be executed. Produce your best final answer / summary now.",
      });
    }

    let turn;
    try {
      turn = await callModel(provider, system, history, isFinal ? [] : tools, {
        maxTokens: 4096,
        temperature: 0,
        signal,
      });
    } catch (err) {
      stopReason = "error";
      return finish({ error: err.message });
    }

    if (turn.usage) {
      usage.input += turn.usage.input;
      usage.output += turn.usage.output;
    }

    onEvent({ type: "turn", iteration: iterations, text: turn.text, toolCalls: turn.toolCalls.length });

    if (!turn.toolCalls.length || isFinal) {
      finalText = turn.text ?? "";
      history.push({ kind: "assistant", content: finalText });
      stopReason = isFinal && turn.toolCalls.length ? "budget" : "done";
      return finish({});
    }

    // Record the assistant turn with its tool calls, then execute them.
    history.push({ kind: "assistant_tools", content: turn.text, toolCalls: turn.toolCalls });

    /** @type {{ id: string, content: string, isError: boolean }[]} */
    const results = [];
    for (const tc of turn.toolCalls) {
      toolCalls++;
      onEvent({ type: "tool", name: tc.name, args: tc.args });
      const res = await executeTool(sandboxRoot, tc);
      if (res.isError) toolErrors++;
      results.push({ id: tc.id, content: res.content, isError: res.isError });
    }
    history.push({ kind: "tool_results", results });
  }

  return finish({});

  function finish(extra) {
    return {
      iterations,
      toolCalls,
      toolErrors,
      finalText,
      stopReason,
      usage,
      transcript: history,
      ...extra,
    };
  }
}
