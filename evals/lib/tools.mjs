// evals/lib/tools.mjs
//
// The agent's TOOL SURFACE, reimplemented in Node against a sandbox directory.
// These mirror the Rust agent tools in `src-tauri/src/commands/agents/tools.rs`
// and `src-tauri/src/commands/chat_tools.rs` — same names, same argument
// shapes, same path-guard semantics — so an eval here exercises the agent the
// SAME way the real Tauri runner would, minus the IPC boundary.
//
// Tools implemented (the Grounded agent's productive set):
//   fs_read_file, fs_write_file, fs_list_dir, fs_search, fs_edit,
//   fs_delete, fs_move, run_command, todo_write
//
// Path guard (port of fs::safe_resolve / safe_resolve_for_write):
//   - reject absolute paths and null bytes
//   - reject `..` traversal
//   - resolve workspace-relative POSIX paths under `root`, refuse escapes
//
// run_command runs in the sandbox with the real machine toolchain, exactly like
// the Rust `run_command` tool (real exit code + stdout + stderr, bounded by a
// wall-clock timeout).

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const READ_CAP = 32 * 1024; // matches fs_read_file's 32 KiB cap
const GREP_CAP = 80; // matches fs_search's 80-match cap
const DEFAULT_CMD_TIMEOUT_SECS = 60;
const MAX_CMD_TIMEOUT_SECS = 300;
const CMD_OUTPUT_CAP = 16 * 1024; // cap captured stdout/stderr per stream

/**
 * Resolve a workspace-relative POSIX path under `root`, refusing escapes.
 * Port of fs::safe_resolve (read) / safe_resolve_for_write (write).
 * @param {string} root  Absolute sandbox root.
 * @param {string} rel   Workspace-relative path.
 * @returns {string} absolute path inside root
 */
export function safeResolve(root, rel) {
  if (rel == null) throw new Error("path is required");
  if (rel.includes("\0")) throw new Error("path contains null byte");
  // Normalise POSIX → OS separators; treat "" and "." as the root.
  const cleaned = String(rel).replace(/\\/g, "/").trim();
  if (cleaned === "" || cleaned === ".") return root;
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error("absolute paths are rejected — use a workspace-relative path");
  }
  const parts = cleaned.split("/").filter((p) => p.length && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("path escapes workspace root (`..` not allowed)");
  }
  const abs = path.resolve(root, parts.join(path.sep));
  const rootResolved = path.resolve(root);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error("path escapes workspace root");
  }
  return abs;
}

// ─── individual tool implementations ─────────────────────────────

async function fsReadFile(root, args) {
  const abs = safeResolve(root, args.path);
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) throw new Error("file appears to be binary");
  if (buf.length > READ_CAP) {
    const slice = buf.subarray(0, READ_CAP).toString("utf8");
    return `${slice}\n[... TRUNCATED at ${READ_CAP} bytes — original size: ${buf.length} bytes ...]`;
  }
  return buf.toString("utf8");
}

async function fsWriteFile(root, args) {
  const abs = safeResolve(root, args.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const content = args.content ?? "";
  await fs.writeFile(abs, content, "utf8");
  return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${args.path}`;
}

async function fsListDir(root, args) {
  const abs = safeResolve(root, args.path ?? ".");
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out = entries
    .map((e) => ({ name: e.name, is_dir: e.isDirectory() }))
    .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
  return JSON.stringify(out);
}

async function fsDelete(root, args) {
  const abs = safeResolve(root, args.path);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new Error("fs_delete refuses directories — only files");
  await fs.unlink(abs);
  return `deleted ${args.path}`;
}

async function fsMove(root, args) {
  const from = safeResolve(root, args.from);
  const to = safeResolve(root, args.to);
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.access(to);
    throw new Error(`destination ${args.to} already exists — refusing to overwrite`);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  await fs.rename(from, to);
  return `moved ${args.from} -> ${args.to}`;
}

async function fsEdit(root, args) {
  const abs = safeResolve(root, args.path);
  const old = args.old_string ?? "";
  const neu = args.new_string ?? "";
  if (old.length === 0) {
    throw new Error(`old_string empty — use fs_write_file to create/overwrite ${args.path}`);
  }
  const content = await fs.readFile(abs, "utf8");
  const count = content.split(old).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${args.path}`);
  if (args.replace_all) {
    const updated = content.split(old).join(neu);
    await fs.writeFile(abs, updated, "utf8");
    return `edited ${args.path} (${count} replacement(s), ${Buffer.byteLength(updated, "utf8")} bytes)`;
  }
  if (count > 1) throw new Error(`old_string appears ${count}× — add context or set replace_all`);
  const updated = content.replace(old, neu);
  await fs.writeFile(abs, updated, "utf8");
  return `edited ${args.path} (${Buffer.byteLength(updated, "utf8")} bytes)`;
}

// ripgrep-backed search, falling back to a JS scan if `rg` is unavailable.
async function fsSearch(root, args) {
  const query = args.query ?? "";
  if (!query) throw new Error("query is required");
  const regex = !!args.regex;
  const caseSensitive = !!args.case_sensitive;
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--max-count",
    "20",
    caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  if (!regex) rgArgs.push("--fixed-strings");
  rgArgs.push("--", query, ".");
  try {
    const { code, stdout } = await runProcess("rg", rgArgs, root, 30);
    if (code === 0 || code === 1) {
      const lines = stdout.split(/\r?\n/).filter(Boolean).slice(0, GREP_CAP);
      const matches = lines.map((l) => {
        // rg format: path:line:preview
        const m = l.match(/^(.*?):(\d+):(.*)$/);
        if (!m) return l;
        const p = m[1].replace(/^\.[\\/]/, "").replace(/\\/g, "/");
        return `${p}:${m[2]}: ${m[3].trim()}`;
      });
      return `${matches.length} match(es):\n${matches.join("\n")}`;
    }
  } catch {
    // rg missing → JS fallback below
  }
  return jsSearch(root, query, regex, caseSensitive);
}

async function jsSearch(root, query, regex, caseSensitive) {
  /** @type {string[]} */
  const matches = [];
  const re = regex
    ? new RegExp(query, caseSensitive ? "" : "i")
    : null;
  const needle = caseSensitive ? query : query.toLowerCase();
  /** @param {string} dir @param {string} relDir */
  async function walk(dir, relDir) {
    if (matches.length >= GREP_CAP) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (matches.length >= GREP_CAP) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else {
        let content;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < GREP_CAP; i++) {
          const line = lines[i];
          const hit = re ? re.test(line) : (caseSensitive ? line : line.toLowerCase()).includes(needle);
          if (hit) matches.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      }
    }
  }
  await walk(root, "");
  return `${matches.length} match(es):\n${matches.join("\n")}`;
}

// run_command — real shell exec in the sandbox, real exit code + output.
async function runCommand(root, args) {
  const command = args.command;
  if (!command || typeof command !== "string") throw new Error("command is required");
  let timeout = Number(args.timeoutSecs ?? DEFAULT_CMD_TIMEOUT_SECS);
  if (!Number.isFinite(timeout) || timeout <= 0) timeout = DEFAULT_CMD_TIMEOUT_SECS;
  timeout = Math.min(timeout, MAX_CMD_TIMEOUT_SECS);

  // spawn(command, { shell: true }) — the single-string + shell form. This is the
  // ONLY form that quotes correctly cross-platform: hand-rolling
  // `cmd.exe /s /c "<command>"` with an embedded `node -e "..."` mangles the inner
  // quotes on Windows (cmd's /s strips the first/last quote), swallowing the -e
  // script and reporting a bogus exit 0. `shell: true` defers quoting to Node's
  // platform-correct wrapper, so real exit codes / stdout come through.
  const { code, stdout, stderr, timedOut } = await spawnShell(command, root, timeout);
  const head = [`[exit ${timedOut ? "TIMEOUT" : code}]`];
  if (stdout.trim()) head.push(`--- stdout ---\n${cap(stdout)}`);
  if (stderr.trim()) head.push(`--- stderr ---\n${cap(stderr)}`);
  const text = head.join("\n");
  // Non-zero exit is INFORMATION, not a tool error — return it as content so the
  // agent reads stderr and fixes (mirrors the Rust run_command behaviour).
  return text;
}

function cap(s) {
  if (s.length <= CMD_OUTPUT_CAP) return s;
  return `${s.slice(0, CMD_OUTPUT_CAP)}\n[... output truncated at ${CMD_OUTPUT_CAP} chars ...]`;
}

// todo_write — advisory plan, never touches files. We echo it back so the loop
// can surface the plan in the transcript, exactly like the Rust tool.
function todoWrite(_root, args) {
  const todos = Array.isArray(args.todos) ? args.todos : [];
  const rendered = todos
    .map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? "~" : " "}] ${t.text}`)
    .join("\n");
  return `plan updated (${todos.length} step(s)):\n${rendered}`;
}

// ─── process helpers ─────────────────────────────────────────────

/**
 * Core spawn + capture + timeout. `spec` is either a single command string (run
 * through `shell: true`) or { cmd, argv } for a direct argv-style exec.
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function spawnCapture(spec, cwd, timeoutSecs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child =
      typeof spec === "string"
        ? spawn(spec, { cwd, shell: true, windowsHide: true, env: process.env })
        : spawn(spec.cmd, spec.argv, { cwd, windowsHide: true, env: process.env });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutSecs * 1000);
    child.stdout?.on("data", (d) => {
      if (stdout.length < CMD_OUTPUT_CAP * 2) stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < CMD_OUTPUT_CAP * 2) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + `\nspawn error: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

// spawnShell: run a shell command string with platform-correct quoting.
function spawnShell(command, cwd, timeoutSecs) {
  return spawnCapture(command, cwd, timeoutSecs);
}

// runProcess: argv-style (no shell) exec — used by ripgrep so the query/path
// are passed literally, never re-parsed by a shell.
function runProcess(cmd, argv, cwd, timeoutSecs) {
  return spawnCapture({ cmd, argv }, cwd, timeoutSecs);
}

// ─── dispatcher ──────────────────────────────────────────────────

/**
 * The tool registry: name → handler. Handlers are async and receive
 * (root, args). They return a string result or throw (→ is_error result).
 */
const HANDLERS = {
  fs_read_file: fsReadFile,
  fs_write_file: fsWriteFile,
  fs_list_dir: fsListDir,
  fs_search: fsSearch,
  fs_edit: fsEdit,
  fs_delete: fsDelete,
  fs_move: fsMove,
  run_command: runCommand,
  todo_write: todoWrite,
};

/**
 * Execute one tool call in the sandbox. Never rejects: a failure becomes
 * { content, isError: true } so the agent can read the error and retry —
 * mirroring the Rust dispatcher's (text, is_error) contract.
 * @param {string} root
 * @param {{ name: string, args: object }} call
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
export async function executeTool(root, call) {
  const handler = HANDLERS[call.name];
  if (!handler) {
    return { content: `unknown tool: ${call.name}`, isError: true };
  }
  try {
    const out = await handler(root, call.args ?? {});
    return { content: String(out), isError: false };
  } catch (err) {
    return { content: `${call.name} failed: ${err.message}`, isError: true };
  }
}

/**
 * The tool DEFINITIONS advertised to the model. Argument schemas match the Rust
 * agent tools so the model behaves identically. `run_command` enabled toggles
 * whether the agent can execute (the Grounded agent always can).
 * @param {{ runCommand?: boolean }} [opts]
 * @returns {import("./provider.mjs").ToolDef[]}
 */
export function toolDefinitions(opts = {}) {
  const enableRun = opts.runCommand !== false;
  const defs = [
    {
      name: "fs_read_file",
      description:
        "Read a workspace-relative UTF-8 file (capped at 32 KiB). Use it to read code FULLY before editing.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative POSIX path." } },
        required: ["path"],
      },
    },
    {
      name: "fs_list_dir",
      description:
        'List the immediate children of a workspace-relative directory as a JSON array of {name, is_dir}. Use "." or "" for the root. Not recursive.',
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Workspace-relative POSIX path." } },
        required: ["path"],
      },
    },
    {
      name: "fs_search",
      description:
        "Search the whole workspace (ripgrep-style) and return matching lines as `path:line: preview`. Literal substring by default; set regex=true for a regex. Capped at 80 matches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          regex: { type: "boolean" },
          case_sensitive: { type: "boolean" },
        },
        required: ["query"],
      },
    },
    {
      name: "fs_write_file",
      description:
        "Write (overwrite) a workspace-relative file, creating parent directories. Use for NEW files. Overwrites without confirmation.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "fs_edit",
      description:
        "Surgically edit an EXISTING file: replace one exact, unique snippet (old_string) with new_string. PREFER this over fs_write_file for changes to existing files. old_string must match exactly and be unique unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "fs_delete",
      description: "Delete a workspace-relative FILE (not a directory). Use sparingly.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    {
      name: "fs_move",
      description:
        "Rename or move a workspace-relative file from `from` to `to`, creating missing parent dirs. Refuses to overwrite an existing destination.",
      parameters: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    {
      name: "todo_write",
      description:
        "Record or update your short plan for this task as a checklist. Call FIRST to lay out steps, then again to update statuses. Pass the FULL current list each time. Advisory only — never touches files.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["text", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  ];
  if (enableRun) {
    defs.push({
      name: "run_command",
      description:
        "Run a shell command in the workspace with the real toolchain (node, npm, git…) and network. Returns the REAL exit code + stdout + stderr — use it to actually RUN your code/tests, see what fails, and fix it before finishing.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: 'Shell command, run in the workspace root.' },
          timeoutSecs: { type: "integer", description: "Wall-clock cap in seconds (default 60, max 300)." },
        },
        required: ["command"],
      },
    });
  }
  return defs;
}
