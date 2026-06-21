// evals/lib/sandbox.mjs
//
// Disposable workspace + verification command runner for one golden task.
//
// Each task runs in a FRESH temp directory (the agent's "real project"), seeded
// from the task's optional fixture/. After the agent finishes we run the task's
// verify command in that same directory and capture the REAL exit code — that
// is the ground truth for pass/fail. The temp dir is removed afterwards unless
// EVAL_KEEP_SANDBOX=1 (kept for debugging a failing task).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a fresh sandbox dir, copy the fixture tree into it (if any).
 * @param {string} taskId
 * @param {string|undefined} fixtureDir  Absolute path to fixture/ or undefined.
 * @returns {Promise<string>} absolute sandbox root
 */
export async function makeSandbox(taskId, fixtureDir) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `shugu-eval-${taskId}-`));
  if (fixtureDir) {
    await copyDir(fixtureDir, base);
  }
  return base;
}

/** Recursively copy a directory tree. */
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

/**
 * Remove a sandbox dir (no-op when EVAL_KEEP_SANDBOX=1).
 * @param {string} dir
 */
export async function cleanupSandbox(dir) {
  if (process.env.EVAL_KEEP_SANDBOX === "1") return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Run a verification command in `cwd` and capture exit code + output.
 * @param {string} command
 * @param {string} cwd
 * @param {number} [timeoutSecs]
 * @returns {Promise<{ pass: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function runVerify(command, cwd, timeoutSecs = 120) {
  return new Promise((resolve) => {
    // `shell: true` (single command string) for platform-correct quoting — the
    // verify command may itself contain quotes (e.g. `node --test "x.js"`).
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, { cwd, shell: true, windowsHide: true, env: process.env });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, timeoutSecs * 1000);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ pass: false, code: 127, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ pass: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}
