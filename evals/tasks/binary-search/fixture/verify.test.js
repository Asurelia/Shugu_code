// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { binarySearch } = require("./search.js");

test("finds present elements", () => {
  const a = [1, 3, 5, 7, 9, 11];
  assert.strictEqual(binarySearch(a, 1), 0);
  assert.strictEqual(binarySearch(a, 7), 3);
  assert.strictEqual(binarySearch(a, 11), 5);
});

test("returns -1 for absent", () => {
  assert.strictEqual(binarySearch([1, 3, 5], 4), -1);
  assert.strictEqual(binarySearch([], 1), -1);
});

test("does not delegate to indexOf", () => {
  const src = fs.readFileSync(path.join(__dirname, "search.js"), "utf8");
  assert.ok(!/\.indexOf\s*\(/.test(src), "must not use Array.prototype.indexOf");
});
