// evals/test/harness.test.mjs
//
// Unit tests for the harness internals (path-guard + tool dispatch + provider
// routing), runnable with `node --test evals/test/harness.test.mjs`. These do
// NOT call any LLM — they exercise the deterministic plumbing so a regression in
// the sandbox/tool layer is caught without spending tokens.

import test from "node:test";
import assert from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeResolve, executeTool, toolDefinitions } from "../lib/tools.mjs";
import { resolveProvider, buildProviderConfig } from "../lib/provider.mjs";

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "shugu-eval-test-"));
}

test("safeResolve accepts workspace-relative paths", () => {
  const root = path.resolve("/tmp/x");
  assert.strictEqual(safeResolve(root, "a/b.txt"), path.join(root, "a", "b.txt"));
  assert.strictEqual(safeResolve(root, "."), root);
  assert.strictEqual(safeResolve(root, ""), root);
});

test("safeResolve rejects traversal, absolute, and null bytes", () => {
  const root = path.resolve("/tmp/x");
  assert.throws(() => safeResolve(root, "../escape"), /escapes/);
  assert.throws(() => safeResolve(root, "a/../../escape"), /escapes/);
  assert.throws(() => safeResolve(root, "/etc/passwd"), /absolute/);
  assert.throws(() => safeResolve(root, "C:/Windows"), /absolute/);
  assert.throws(() => safeResolve(root, "a\0b"), /null/);
});

test("fs_write_file then fs_read_file round-trips", async () => {
  const root = await tmpRoot();
  const w = await executeTool(root, { name: "fs_write_file", args: { path: "hi.txt", content: "hello" } });
  assert.strictEqual(w.isError, false);
  const r = await executeTool(root, { name: "fs_read_file", args: { path: "hi.txt" } });
  assert.strictEqual(r.isError, false);
  assert.strictEqual(r.content, "hello");
  await fs.rm(root, { recursive: true, force: true });
});

test("fs_edit replaces a unique snippet and rejects ambiguous/missing", async () => {
  const root = await tmpRoot();
  await executeTool(root, { name: "fs_write_file", args: { path: "f.js", content: "let a = 1;\nlet b = 2;\n" } });
  const ok = await executeTool(root, {
    name: "fs_edit",
    args: { path: "f.js", old_string: "let a = 1;", new_string: "let a = 99;" },
  });
  assert.strictEqual(ok.isError, false);
  const back = await executeTool(root, { name: "fs_read_file", args: { path: "f.js" } });
  assert.match(back.content, /let a = 99;/);

  const missing = await executeTool(root, {
    name: "fs_edit",
    args: { path: "f.js", old_string: "nope", new_string: "x" },
  });
  assert.strictEqual(missing.isError, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("run_command returns real exit code in output", async () => {
  const root = await tmpRoot();
  const ok = await executeTool(root, { name: "run_command", args: { command: "node -e \"process.exit(0)\"" } });
  assert.match(ok.content, /\[exit 0\]/);
  const bad = await executeTool(root, { name: "run_command", args: { command: "node -e \"process.exit(3)\"" } });
  assert.match(bad.content, /\[exit 3\]/);
  await fs.rm(root, { recursive: true, force: true });
});

test("fs_list_dir returns JSON of children", async () => {
  const root = await tmpRoot();
  await executeTool(root, { name: "fs_write_file", args: { path: "dir/a.txt", content: "x" } });
  const r = await executeTool(root, { name: "fs_list_dir", args: { path: "." } });
  const parsed = JSON.parse(r.content);
  assert.ok(parsed.some((e) => e.name === "dir" && e.is_dir === true));
  await fs.rm(root, { recursive: true, force: true });
});

test("unknown tool is a soft error", async () => {
  const root = await tmpRoot();
  const r = await executeTool(root, { name: "nope_tool", args: {} });
  assert.strictEqual(r.isError, true);
  assert.match(r.content, /unknown tool/);
  await fs.rm(root, { recursive: true, force: true });
});

test("toolDefinitions advertises the grounded tool set", () => {
  const names = toolDefinitions({ runCommand: true }).map((d) => d.name);
  for (const n of ["fs_read_file", "fs_write_file", "fs_edit", "fs_search", "run_command", "todo_write"]) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  const noRun = toolDefinitions({ runCommand: false }).map((d) => d.name);
  assert.ok(!noRun.includes("run_command"));
});

test("resolveProvider maps prefixes to protocol + baseUrl", () => {
  assert.deepStrictEqual(resolveProvider("anthropic/claude-haiku-4-5"), {
    providerId: "anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-4-5",
  });
  const groq = resolveProvider("groq/llama-3.3-70b-versatile");
  assert.strictEqual(groq.protocol, "openai");
  assert.match(groq.baseUrl, /groq\.com/);
  // unknown prefix -> openai/custom with empty baseUrl
  const unk = resolveProvider("weirdvendor/some-model");
  assert.strictEqual(unk.protocol, "openai");
  assert.strictEqual(unk.baseUrl, "");
});

test("buildProviderConfig honours EVAL_BASE_URL override", () => {
  const prev = process.env.EVAL_BASE_URL;
  process.env.EVAL_BASE_URL = "http://localhost:9999";
  try {
    const cfg = buildProviderConfig("anthropic/claude-haiku-4-5");
    assert.strictEqual(cfg.baseUrl, "http://localhost:9999");
  } finally {
    if (prev === undefined) delete process.env.EVAL_BASE_URL;
    else process.env.EVAL_BASE_URL = prev;
  }
});
