// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const { Stack } = require("./stack.js");

test("push returns new size and peek/pop work", () => {
  const s = new Stack();
  assert.strictEqual(s.isEmpty(), true);
  assert.strictEqual(s.push(1), 1);
  assert.strictEqual(s.push(2), 2);
  assert.strictEqual(s.peek(), 2);
  assert.strictEqual(s.size(), 2);
  assert.strictEqual(s.pop(), 2);
  assert.strictEqual(s.pop(), 1);
  assert.strictEqual(s.isEmpty(), true);
});

test("pop/peek on empty return undefined", () => {
  const s = new Stack();
  assert.strictEqual(s.pop(), undefined);
  assert.strictEqual(s.peek(), undefined);
});
