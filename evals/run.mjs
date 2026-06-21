#!/usr/bin/env node
// evals/run.mjs — the Shugu agent eval runner (Lane 7, gap AM-1).
//
// For each golden task under evals/tasks/:
//   1. create a throwaway sandbox dir, seeded from the task's fixture/
//   2. drive the Grounded agent headless against the provider API in that dir
//   3. run the task's verify command in the same dir — exit 0 == pass
//   4. record a scorecard row { task, pass/fail, duration, iterations, ... }
// then print + persist the scorecard.
//
// MODES:
//   (default / live)  Needs an API key (ANTHROPIC_API_KEY or OPENAI_API_KEY,
//                     etc., or EVAL_API_KEY). Runs the real agent on each task.
//   --dry-run         No model call. Records every task as "skipped" with the
//                     reason, but STILL produces a full, valid scorecard. Use to
//                     prove the harness wiring without spending tokens / a key.
//   --self-check      No model call. Seeds each sandbox from the task's
//                     solution/ (reference answer) and runs ONLY the verify
//                     command. Proves every golden task is well-formed and its
//                     verify command is executable & correct. This is what the
//                     gate runs in CI without an API key.
//
// FLAGS:
//   --model <id>      Provider model id ("anthropic/claude-haiku-4-5",
//                     "openai/gpt-4o-mini", …). Default: EVAL_MODEL or
//                     "anthropic/claude-haiku-4-5".
//   --only a,b,c      Run only these task ids (comma-separated).
//   --max-iter N      Override the agent iteration budget.
//   --quiet           Less per-task chatter.
//
// EXIT CODE: 0 when the runner completed and produced a scorecard (even if some
// tasks failed — the scorecard captures that). Non-zero only on a harness-level
// error (no tasks found, missing solution in --self-check, etc.). This keeps the
// gate ("the runner runs and emits a scorecard") robust.

import { buildProviderConfig } from "./lib/provider.mjs";
import { runAgentTask, MAX_ITERATIONS } from "./lib/agent.mjs";
import { loadTasks } from "./lib/tasks.mjs";
import { makeSandbox, cleanupSandbox, runVerify } from "./lib/sandbox.mjs";
import {
  buildScorecard,
  formatScorecard,
  writeScorecard,
} from "./lib/scorecard.mjs";

function parseArgs(argv) {
  const out = { mode: "live", only: null, model: null, maxIter: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.mode = "dry-run";
    else if (a === "--self-check") out.mode = "self-check";
    else if (a === "--quiet") out.quiet = true;
    else if (a === "--model") out.model = argv[++i];
    else if (a === "--only") out.only = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--max-iter") out.maxIter = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const HELP = `shugu agent eval runner

usage:
  node evals/run.mjs [--self-check | --dry-run] [--model <id>] [--only a,b] [--max-iter N] [--quiet]

modes:
  (default)     run the real agent on each task (needs an API key)
  --self-check  seed each sandbox from solution/ and only run verify (no key)
  --dry-run     record everything as skipped, still emit a scorecard (no key)

env:
  EVAL_MODEL        default model id (else anthropic/claude-haiku-4-5)
  EVAL_API_KEY      override api key (else <PREFIX>_API_KEY / <PROTOCOL>_API_KEY)
  EVAL_BASE_URL     override base url (for custom/local OpenAI-compatible servers)
  EVAL_KEEP_SANDBOX=1  keep temp dirs for debugging
`;

function log(quiet, ...args) {
  if (!quiet) console.log(...args);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return 0;
  }

  const model = opts.model || process.env.EVAL_MODEL || "anthropic/claude-haiku-4-5";
  const maxIter = opts.maxIter || MAX_ITERATIONS;

  const tasks = await loadTasks({ only: opts.only });
  if (!tasks.length) {
    console.error("no golden tasks found under evals/tasks/");
    return 1;
  }

  // Decide effective mode. In live mode without a resolvable key, degrade to a
  // skipped scorecard instead of crashing — the runner must always emit output.
  let mode = opts.mode;
  let provider = null;
  let skipReason = null;
  if (mode === "live") {
    provider = buildProviderConfig(model);
    if (!provider.apiKey && !process.env.EVAL_BASE_URL) {
      mode = "skipped-no-key";
      skipReason = `no API key resolved for "${model}" (set ANTHROPIC_API_KEY / OPENAI_API_KEY / EVAL_API_KEY)`;
    }
  }

  log(opts.quiet, `\n=== Shugu agent eval — ${tasks.length} task(s) — model ${model} — mode ${mode} ===\n`);

  /** @type {import("./lib/scorecard.mjs").ScoreRow[]} */
  const rows = [];

  for (const task of tasks) {
    const started = Date.now();
    const baseRow = {
      task: task.id,
      title: task.title,
      category: task.category,
      iterations: 0,
      toolCalls: 0,
      toolErrors: 0,
      verifyExitCode: -1,
      durationMs: 0,
    };

    // ── modes that DON'T call the model ──────────────────────────
    if (mode === "dry-run" || mode === "skipped-no-key") {
      rows.push({
        ...baseRow,
        status: "skipped",
        pass: false,
        durationMs: Date.now() - started,
        note: mode === "dry-run" ? "dry-run" : skipReason,
      });
      log(opts.quiet, `SKIP  ${task.id} — ${mode === "dry-run" ? "dry-run" : skipReason}`);
      continue;
    }

    if (mode === "self-check") {
      // Seed from solution/ and run verify only — proves the task is sound.
      if (!task.solutionDir) {
        rows.push({
          ...baseRow,
          status: "error",
          pass: false,
          durationMs: Date.now() - started,
          note: "self-check needs a solution/ dir",
        });
        log(opts.quiet, `ERR   ${task.id} — no solution/ to self-check`);
        continue;
      }
      const sandbox = await makeSandbox(task.id, task.fixtureDir);
      // Overlay the reference solution on top of the fixture.
      await overlay(task.solutionDir, sandbox);
      const v = await runVerify(task.verify, sandbox, task.verifyTimeoutSecs);
      await cleanupSandbox(sandbox);
      rows.push({
        ...baseRow,
        status: v.pass ? "pass" : "fail",
        pass: v.pass,
        verifyExitCode: v.code ?? -1,
        durationMs: Date.now() - started,
        note: v.pass ? "solution verified" : `solution FAILED verify (exit ${v.code})`,
      });
      log(
        opts.quiet,
        `${v.pass ? "PASS" : "FAIL"}  ${task.id} — solution ${v.pass ? "verified" : `failed (exit ${v.code})`}`,
      );
      continue;
    }

    // ── live: run the real agent ─────────────────────────────────
    log(opts.quiet, `RUN   ${task.id} — ${task.title}`);
    const sandbox = await makeSandbox(task.id, task.fixtureDir);
    let result;
    try {
      result = await runAgentTask({
        provider,
        sandboxRoot: sandbox,
        task: task.prompt,
        verifyCommand: task.verify,
        maxIterations: maxIter,
        onEvent: (ev) => {
          if (opts.quiet) return;
          if (ev.type === "tool") process.stdout.write(`  · ${ev.name}\n`);
        },
      });
    } catch (err) {
      await cleanupSandbox(sandbox);
      rows.push({
        ...baseRow,
        status: "error",
        pass: false,
        durationMs: Date.now() - started,
        note: `agent error: ${err.message}`,
        stopReason: "error",
      });
      log(opts.quiet, `ERR   ${task.id} — ${err.message}`);
      continue;
    }

    if (result.stopReason === "error") {
      await cleanupSandbox(sandbox);
      rows.push({
        ...baseRow,
        status: "error",
        pass: false,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        toolErrors: result.toolErrors,
        durationMs: Date.now() - started,
        note: `agent error: ${result.error}`,
        stopReason: "error",
        usage: result.usage,
      });
      log(opts.quiet, `ERR   ${task.id} — ${result.error}`);
      continue;
    }

    // Ground truth: run the verify command in the post-agent sandbox.
    const v = await runVerify(task.verify, sandbox, task.verifyTimeoutSecs);
    await cleanupSandbox(sandbox);

    rows.push({
      task: task.id,
      title: task.title,
      category: task.category,
      status: v.pass ? "pass" : "fail",
      pass: v.pass,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      toolErrors: result.toolErrors,
      verifyExitCode: v.code ?? -1,
      durationMs: Date.now() - started,
      stopReason: result.stopReason,
      usage: result.usage,
      note: v.pass ? "" : `verify exit ${v.code}${v.timedOut ? " (timeout)" : ""}`,
    });
    log(
      opts.quiet,
      `${v.pass ? "PASS" : "FAIL"}  ${task.id} — ${result.iterations} iter, ${result.toolCalls} tools` +
        (v.pass ? "" : ` — verify exit ${v.code}`),
    );
  }

  const sc = buildScorecard(rows, { model, mode });
  console.log(formatScorecard(sc));
  const { jsonPath, latestPath } = await writeScorecard(sc);
  console.log(`scorecard written: ${jsonPath}`);
  console.log(`latest:            ${latestPath}`);
  return 0;
}

/** Copy every file from src over dest (overwriting). */
async function overlay(src, dest) {
  const { promises: fs } = await import("node:fs");
  const path = await import("node:path");
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      await fs.mkdir(d, { recursive: true });
      await overlay(s, d);
    } else {
      await fs.mkdir(path.dirname(d), { recursive: true });
      await fs.copyFile(s, d);
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("eval runner crashed:", err);
    process.exit(2);
  });
