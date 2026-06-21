// evals/lib/tasks.mjs
//
// Discover and validate the golden tasks under evals/tasks/.
//
// Each task is a directory containing a `task.json`:
//   {
//     "id":        "fizzbuzz",                 // stable id (defaults to dir name)
//     "title":     "Implement FizzBuzz",        // human label
//     "prompt":    "Create fizzbuzz.js ...",     // the user task given to the agent
//     "verify":    "node verify.test.js",        // command that MUST exit 0 to pass
//     "verifyTimeoutSecs": 120,                  // optional, default 120
//     "tags":      ["js", "from-scratch"],       // optional
//     "category":  "from-scratch"                // optional grouping
//   }
//
// Optional sibling directories:
//   fixture/    — copied into the sandbox before the agent runs (starter files,
//                 the verify script itself, package fixtures, …).
//   solution/   — a REFERENCE solution used ONLY by `--self-check` to prove the
//                 task's verify command is correct and executable WITHOUT an LLM.
//
// The verify script lives in fixture/ so it is present in the sandbox and the
// agent is told (via the prompt) NOT to modify it.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TASKS_DIR = path.resolve(HERE, "..", "tasks");

/**
 * @typedef {Object} GoldenTask
 * @property {string} id
 * @property {string} title
 * @property {string} prompt
 * @property {string} verify
 * @property {number} verifyTimeoutSecs
 * @property {string[]} tags
 * @property {string} category
 * @property {string} dir          Absolute task directory.
 * @property {string|undefined} fixtureDir
 * @property {string|undefined} solutionDir
 */

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load and validate all golden tasks. Throws if a task.json is malformed.
 * @param {{ only?: string[] }} [opts]  Restrict to these task ids.
 * @returns {Promise<GoldenTask[]>}
 */
export async function loadTasks(opts = {}) {
  const entries = await fs.readdir(TASKS_DIR, { withFileTypes: true }).catch(() => []);
  /** @type {GoldenTask[]} */
  const tasks = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(TASKS_DIR, e.name);
    const manifestPath = path.join(dir, "task.json");
    if (!(await exists(manifestPath))) continue;
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (err) {
      throw new Error(`task "${e.name}" has invalid task.json: ${err.message}`);
    }
    const id = manifest.id || e.name;
    for (const field of ["prompt", "verify"]) {
      if (!manifest[field] || typeof manifest[field] !== "string") {
        throw new Error(`task "${id}" missing required string field "${field}"`);
      }
    }
    const fixtureDir = (await exists(path.join(dir, "fixture"))) ? path.join(dir, "fixture") : undefined;
    const solutionDir = (await exists(path.join(dir, "solution"))) ? path.join(dir, "solution") : undefined;
    const task = {
      id,
      title: manifest.title || id,
      prompt: manifest.prompt,
      verify: manifest.verify,
      verifyTimeoutSecs: Number(manifest.verifyTimeoutSecs) || 120,
      tags: Array.isArray(manifest.tags) ? manifest.tags : [],
      category: manifest.category || "uncategorized",
      dir,
      fixtureDir,
      solutionDir,
    };
    tasks.push(task);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  if (opts.only && opts.only.length) {
    const set = new Set(opts.only);
    return tasks.filter((t) => set.has(t.id));
  }
  return tasks;
}
