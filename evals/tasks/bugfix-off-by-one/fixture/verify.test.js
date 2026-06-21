// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const { range } = require("./range.js");

test("inclusive range", () => {
  assert.deepStrictEqual(range(1, 4), [1, 2, 3, 4]);
});

test("single element", () => {
  assert.deepStrictEqual(range(5, 5), [5]);
});

test("longer range length", () => {
  assert.strictEqual(range(0, 9).length, 10);
});
