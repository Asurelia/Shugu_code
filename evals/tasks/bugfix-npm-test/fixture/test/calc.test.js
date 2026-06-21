// Golden verification — do NOT modify. Discovered by `node --test`.
const test = require("node:test");
const assert = require("node:assert");
const { sum, average } = require("../src/calc.js");

test("sum", () => {
  assert.strictEqual(sum([1, 2, 3, 4]), 10);
});

test("average", () => {
  assert.strictEqual(average([1, 2, 3, 4]), 2.5);
  assert.strictEqual(average([10, 20]), 15);
});
