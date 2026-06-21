// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const { deepMerge } = require("./merge.js");

test("merges nested objects", () => {
  const a = { x: 1, nested: { p: 1, q: 2 } };
  const b = { nested: { q: 9, r: 3 }, y: 2 };
  assert.deepStrictEqual(deepMerge(a, b), {
    x: 1,
    nested: { p: 1, q: 9, r: 3 },
    y: 2,
  });
});

test("override replaces arrays wholesale", () => {
  assert.deepStrictEqual(deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
});

test("does not mutate inputs", () => {
  const a = { nested: { p: 1 } };
  const b = { nested: { q: 2 } };
  const copyA = JSON.parse(JSON.stringify(a));
  deepMerge(a, b);
  assert.deepStrictEqual(a, copyA);
});

test("null override replaces object", () => {
  assert.deepStrictEqual(deepMerge({ a: { x: 1 } }, { a: null }), { a: null });
});
