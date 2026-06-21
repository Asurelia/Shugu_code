// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const { makeSlug } = require("./index.js");

test("basic slug", () => {
  assert.strictEqual(makeSlug("  Hello, World!  "), "hello-world");
});

test("trailing punctuation does not leave a dash", () => {
  assert.strictEqual(makeSlug("Done!"), "done");
  assert.strictEqual(makeSlug("a -- b -- "), "a-b");
});

test("internal runs collapse", () => {
  assert.strictEqual(makeSlug("foo___bar   baz"), "foo-bar-baz");
});
