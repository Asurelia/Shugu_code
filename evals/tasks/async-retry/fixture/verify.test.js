// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const { retry } = require("./retry.js");

test("returns immediately on success", async () => {
  let calls = 0;
  const v = await retry(async () => {
    calls++;
    return 42;
  });
  assert.strictEqual(v, 42);
  assert.strictEqual(calls, 1);
});

test("retries then succeeds", async () => {
  let calls = 0;
  const v = await retry(async () => {
    calls++;
    if (calls < 3) throw new Error("nope");
    return "ok";
  }, 3);
  assert.strictEqual(v, "ok");
  assert.strictEqual(calls, 3);
});

test("throws the last error after exhausting attempts", async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      calls++;
      throw new Error(`fail-${calls}`);
    }, 2),
    /fail-2/,
  );
  assert.strictEqual(calls, 2);
});
