// Golden verification — do NOT modify. Uses only Node's built-in test runner.
const test = require("node:test");
const assert = require("node:assert");
const { fizzbuzz } = require("./fizzbuzz.js");

test("basic numbers are stringified", () => {
  assert.deepStrictEqual(fizzbuzz(2), ["1", "2"]);
});

test("fizz, buzz, fizzbuzz", () => {
  const out = fizzbuzz(15);
  assert.strictEqual(out[2], "Fizz"); // 3
  assert.strictEqual(out[4], "Buzz"); // 5
  assert.strictEqual(out[14], "FizzBuzz"); // 15
  assert.strictEqual(out[5], "Fizz"); // 6
  assert.strictEqual(out[9], "Buzz"); // 10
});

test("length matches n", () => {
  assert.strictEqual(fizzbuzz(20).length, 20);
});
