// Golden verification — do NOT modify. Checks both the unchanged summary
// behaviour AND that the helpers were extracted and exported.
const test = require("node:test");
const assert = require("node:assert");
const mod = require("./stats.js");

test("summary behaviour unchanged", () => {
  assert.deepStrictEqual(mod.summary([1, 2, 3, 4]), { mean: 2.5, min: 1, max: 4 });
});

test("helpers are exported", () => {
  assert.strictEqual(typeof mod.mean, "function");
  assert.strictEqual(typeof mod.min, "function");
  assert.strictEqual(typeof mod.max, "function");
});

test("helpers compute correctly", () => {
  assert.strictEqual(mod.mean([2, 4, 6]), 4);
  assert.strictEqual(mod.min([5, 1, 9]), 1);
  assert.strictEqual(mod.max([5, 1, 9]), 9);
});
