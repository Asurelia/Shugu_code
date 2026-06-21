// evals/lib/scorecard.mjs
//
// Build, print, and persist the eval SCORECARD.
//
// The scorecard is the harness's primary deliverable (gap AM-1: measure whether
// the agent codes well). Each row is one golden task with its outcome:
//   { task, status, pass, durationMs, iterations, toolCalls, toolErrors, ... }
//
// statuses:
//   pass     — agent finished AND the verify command exited 0
//   fail     — agent finished but verify did NOT exit 0
//   error    — the agent loop errored (e.g. provider/network failure)
//   skipped  — not run (no API key / dry-run); recorded so the scorecard is
//              always complete and the runner always produces output.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = path.resolve(HERE, "..", "results");

/**
 * @typedef {Object} ScoreRow
 * @property {string} task
 * @property {string} title
 * @property {string} category
 * @property {"pass"|"fail"|"error"|"skipped"} status
 * @property {boolean} pass
 * @property {number} durationMs
 * @property {number} iterations
 * @property {number} toolCalls
 * @property {number} toolErrors
 * @property {number} verifyExitCode
 * @property {string} [stopReason]
 * @property {string} [note]
 * @property {{ input: number, output: number }} [usage]
 */

/**
 * @typedef {Object} Scorecard
 * @property {string} createdAt
 * @property {string} model
 * @property {string} mode             "live" | "dry-run" | "self-check"
 * @property {Object} summary
 * @property {number} summary.total
 * @property {number} summary.pass
 * @property {number} summary.fail
 * @property {number} summary.error
 * @property {number} summary.skipped
 * @property {number} summary.passRate   pass / (pass+fail+error), 0 if none ran
 * @property {number} summary.totalDurationMs
 * @property {ScoreRow[]} rows
 */

/**
 * Assemble a scorecard object from rows.
 * @param {ScoreRow[]} rows
 * @param {{ model: string, mode: string }} meta
 * @returns {Scorecard}
 */
export function buildScorecard(rows, meta) {
  const pass = rows.filter((r) => r.status === "pass").length;
  const fail = rows.filter((r) => r.status === "fail").length;
  const error = rows.filter((r) => r.status === "error").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const ran = pass + fail + error;
  return {
    createdAt: new Date().toISOString(),
    model: meta.model,
    mode: meta.mode,
    summary: {
      total: rows.length,
      pass,
      fail,
      error,
      skipped,
      passRate: ran ? pass / ran : 0,
      totalDurationMs: rows.reduce((a, r) => a + (r.durationMs || 0), 0),
    },
    rows,
  };
}

/**
 * Pretty ASCII table + summary for the terminal.
 * @param {Scorecard} sc
 * @returns {string}
 */
export function formatScorecard(sc) {
  const icon = (s) =>
    s === "pass" ? "PASS" : s === "fail" ? "FAIL" : s === "error" ? "ERR " : "SKIP";
  const lines = [];
  lines.push("");
  lines.push(`Shugu agent eval scorecard — ${sc.model}  (mode: ${sc.mode})`);
  lines.push(`generated ${sc.createdAt}`);
  lines.push("");
  const header = `${"STATUS".padEnd(6)} ${"TASK".padEnd(22)} ${"ITER".padStart(4)} ${"TOOLS".padStart(5)} ${"ERR".padStart(3)} ${"TIME".padStart(8)}  NOTE`;
  lines.push(header);
  lines.push("-".repeat(header.length + 10));
  for (const r of sc.rows) {
    const time = `${(r.durationMs / 1000).toFixed(1)}s`;
    const note = r.note || (r.status === "fail" ? `verify exit ${r.verifyExitCode}` : "");
    lines.push(
      `${icon(r.status).padEnd(6)} ${r.task.slice(0, 22).padEnd(22)} ${String(r.iterations).padStart(4)} ${String(
        r.toolCalls,
      ).padStart(5)} ${String(r.toolErrors).padStart(3)} ${time.padStart(8)}  ${note}`,
    );
  }
  lines.push("-".repeat(header.length + 10));
  const s = sc.summary;
  lines.push(
    `total ${s.total}  pass ${s.pass}  fail ${s.fail}  error ${s.error}  skipped ${s.skipped}  ` +
      `passRate ${(s.passRate * 100).toFixed(0)}%  (${(s.totalDurationMs / 1000).toFixed(1)}s total)`,
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Persist the scorecard JSON to evals/results/ and update results/latest.json.
 * @param {Scorecard} sc
 * @returns {Promise<{ jsonPath: string, latestPath: string }>}
 */
export async function writeScorecard(sc) {
  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const stamp = sc.createdAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(RESULTS_DIR, `scorecard-${stamp}.json`);
  const latestPath = path.join(RESULTS_DIR, "latest.json");
  const payload = JSON.stringify(sc, null, 2);
  await fs.writeFile(jsonPath, payload, "utf8");
  await fs.writeFile(latestPath, payload, "utf8");
  return { jsonPath, latestPath };
}
