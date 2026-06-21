// Golden verification — do NOT modify. Structural checks on index.html using
// only Node built-ins (no DOM library): normalise whitespace and assert the
// required elements/text are present in order.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const norm = html.replace(/\s+/g, " ");

test("has doctype", () => {
  assert.match(html, /<!doctype html>/i);
});

test("has h1 with exact text", () => {
  assert.match(norm, /<h1[^>]*>\s*Shugu Eval\s*<\/h1>/i);
});

test("has three list items in order", () => {
  const items = [...norm.matchAll(/<li[^>]*>\s*([^<]*?)\s*<\/li>/gi)].map((m) => m[1].trim());
  assert.deepStrictEqual(items, ["alpha", "beta", "gamma"]);
});

test("has a Go button with id go", () => {
  assert.match(norm, /<button[^>]*id=["']go["'][^>]*>\s*Go\s*<\/button>/i);
});
