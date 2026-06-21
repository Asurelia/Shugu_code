# Shugu agent eval harness (Lane 7 — gap AM-1)

**Why this exists.** AM-1 (the "blind spot"): nobody had measured whether the
Shugu coding agent actually *codes well*. This harness fixes that — it runs the
agent against a battery of **golden tasks** (prompt + fixture + a verify command
that must exit 0) in throwaway sandboxes, then emits a **scorecard**
(`{task, pass/fail, duration, iterations, …}`) so agent quality becomes a number
you can track over time.

## What it measures

For each golden task the harness:

1. creates a **fresh temp directory** (the agent's "real project"), seeded from
   the task's `fixture/`;
2. drives the agent **headless** in that directory (multi-turn tool-use loop);
3. runs the task's **verify command** in the same directory — `exit 0` == pass;
4. records a scorecard row: status, duration, iterations, tool calls, tool
   errors, verify exit code, token usage.

The verify command is the **ground truth**. The agent's own claims of success are
ignored — only the test passing counts.

## How it talks to the agent (the Rust integration question)

The real agent engine is Rust behind Tauri (`src-tauri/src/commands/agents/`),
which is hard to drive headless without booting the desktop app. So this harness
re-implements the agent's **exact operating contract** in Node and calls the
**same LLM providers** the Rust runner calls:

| Rust source | Harness port | What is mirrored |
|---|---|---|
| `agents/runner.rs::GROUNDED_PROMPT` | `evals/lib/agent.mjs` `GROUNDED_PROMPT` | the verbatim system prompt |
| `agents/runner.rs::run_agent_task` (tool-use loop, `MAX_ITERATIONS = 24`) | `evals/lib/agent.mjs` `runAgentTask` | the bounded multi-turn loop + final-iteration nudge |
| `agents/tools.rs` + `chat_tools.rs` | `evals/lib/tools.mjs` | tool names, arg schemas, path-guard (`fs::safe_resolve`) |
| `agents/runner.rs` `build_anthropic_messages` / `build_openai_messages` | `evals/lib/provider.mjs` | the two wire formats (tool_use/tool_result vs tool_calls/role:tool) |
| `src/lib/providers.ts` `resolveProvider` / `PROVIDER_REGISTRY` | `evals/lib/provider.mjs` `resolveProvider` | model-id → protocol + baseUrl routing |

This is **provider-faithful**, not engine-identical: it exercises the same model,
same prompt, same tools, same loop shape — which is exactly what AM-1 needs
(measuring the *model's* coding ability under Shugu's harness). It does **not**
go through Tauri IPC. If a future lane wants engine-identical evals, the seam is
clean: swap `runAgentTask` for a headless Tauri driver that spawns
`agents::spawn_grounded_run` and reuse this harness's task set + scorecard
unchanged. See "Driving the real Rust engine" below.

## Tool surface (matches the Grounded agent)

`fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_search`, `fs_edit`,
`fs_delete`, `fs_move`, `run_command`, `todo_write` — same names and argument
shapes as the Rust agent, same path-guard (absolute paths and `..` rejected,
workspace-relative POSIX under the sandbox root). `run_command` runs in the
sandbox with the real machine toolchain (node, npm, git…) and returns the real
exit code + stdout + stderr, just like the Rust tool.

## Running it

```bash
# self-check (no API key): seed each task from its solution/ and run only the
# verify command — proves every golden task is well-formed and executable.
pnpm test:eval                      # == node evals/run.mjs --self-check

# dry run (no API key): record everything as skipped, still emit a scorecard.
node evals/run.mjs --dry-run

# live (needs a key): run the REAL agent on each task.
ANTHROPIC_API_KEY=sk-... node evals/run.mjs --model anthropic/claude-haiku-4-5
OPENAI_API_KEY=sk-...    node evals/run.mjs --model openai/gpt-4o-mini

# subset / options
node evals/run.mjs --self-check --only fizzbuzz,binary-search
node evals/run.mjs --model groq/llama-3.3-70b-versatile --max-iter 16 --quiet
```

### Environment

| var | meaning |
|---|---|
| `EVAL_MODEL` | default model id (else `anthropic/claude-haiku-4-5`) |
| `EVAL_API_KEY` | explicit key override (else `<PREFIX>_API_KEY` / `<PROTOCOL>_API_KEY`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, … | per-provider keys |
| `EVAL_BASE_URL` | override base URL for custom / local OpenAI-compatible servers |
| `EVAL_KEEP_SANDBOX=1` | keep temp dirs for debugging a failing task |

The runner **always emits a scorecard** and exits 0 unless it hits a
harness-level error (no tasks found, missing `solution/` during `--self-check`).
A task failing the agent run is captured as a `fail`/`error` *row*, not a crash —
so the gate "the runner runs and emits a scorecard" is robust with or without a
key.

## Output

A scorecard is printed as an ASCII table and persisted to
`evals/results/scorecard-<timestamp>.json` plus `evals/results/latest.json`:

```json
{
  "model": "anthropic/claude-haiku-4-5",
  "mode": "live",
  "summary": { "total": 12, "pass": 11, "fail": 1, "error": 0, "skipped": 0,
               "passRate": 0.916, "totalDurationMs": 84213 },
  "rows": [
    { "task": "fizzbuzz", "status": "pass", "iterations": 3, "toolCalls": 4,
      "toolErrors": 0, "verifyExitCode": 0, "durationMs": 5120 }
  ]
}
```

`evals/results/` is gitignored except the committed `baseline.json` (the
reference run — see below).

## The golden tasks

12 tasks across categories (`from-scratch`, `bugfix`, `refactor`):
`fizzbuzz`, `binary-search`, `stack-class`, `json-merge`, `csv-parse`,
`async-retry`, `cli-wordcount`, `html-page`, `bugfix-off-by-one`,
`bugfix-multifile`, `bugfix-npm-test`, `refactor-extract`.

Every verify uses Node's built-in test runner (`node --test`) or `npm test`, so
**no dependency install is required** — the harness runs from a bare `node`.

### Anatomy of a task

```
evals/tasks/<id>/
  task.json          { id, title, category, tags, prompt, verify, verifyTimeoutSecs }
  fixture/           copied into the sandbox before the agent runs
                     (starter files + the verify test itself)
  solution/          reference answer — used ONLY by --self-check to prove the
                     task is sound (overlaid on fixture, then verify is run)
```

### Adding a task

1. `mkdir evals/tasks/<id>` and write `task.json` (`prompt` + `verify` required).
2. Put the verify script and any starter files in `fixture/`.
3. Put a known-good reference answer in `solution/`.
4. `node evals/run.mjs --self-check --only <id>` — it must PASS (solution
   verified). If it fails, your verify command or solution is wrong.

## Baseline

`evals/results/baseline.json` records a reference run so regressions are visible.
The committed baseline is a **`--self-check` run** (all 12 solutions verified) —
establishable on any machine with no API key, proving the *harness + task set*
are sound. To capture a **live model baseline**, run e.g.
`ANTHROPIC_API_KEY=… node evals/run.mjs` and copy the resulting
`results/latest.json` over `results/baseline.json`.

## Driving the real Rust engine (future work, documented seam)

To make evals engine-identical instead of provider-faithful, replace the body of
`runAgentTask` (`evals/lib/agent.mjs`) with a Tauri headless driver:

- expose a thin headless entrypoint over `agents::spawn_grounded_run`
  (`mod.rs`) that accepts `{ task, workspace_override, test_command, model }`
  and resolves when the run's `agent_outcomes` row lands;
- point `workspace_override` at the harness sandbox dir;
- read back `iterations` / `success` from `agent_outcomes` for the scorecard.

The task set (`evals/tasks/`), sandbox/verify plumbing (`evals/lib/sandbox.mjs`),
and scorecard (`evals/lib/scorecard.mjs`) are reused as-is — only the *driver*
changes.
