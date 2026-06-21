// Golden verification — do NOT modify. Spawns the CLI and checks output + exit.
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SAMPLE = path.join(__dirname, "sample.txt");

test("counts lines, words, bytes", () => {
  const r = spawnSync(process.execPath, ["wc.js", SAMPLE], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, `exit ${r.status} stderr=${r.stderr}`);
  const bytes = fs.statSync(SAMPLE).size;
  // sample.txt: 3 newlines, 9 words.
  assert.strictEqual(r.stdout.trim(), `3 9 ${bytes}`);
});

test("missing file exits non-zero", () => {
  const r = spawnSync(process.execPath, ["wc.js", "does-not-exist.txt"], { encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
});

test("no argument exits non-zero", () => {
  const r = spawnSync(process.execPath, ["wc.js"], { encoding: "utf8" });
  assert.notStrictEqual(r.status, 0);
});
