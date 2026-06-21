// Golden verification — do NOT modify.
const test = require("node:test");
const assert = require("node:assert");
const { parseCsv } = require("./csv.js");

test("parses header + rows into objects", () => {
  const text = "name, age\nAlice, 30\nBob, 25\n";
  assert.deepStrictEqual(parseCsv(text), [
    { name: "Alice", age: "30" },
    { name: "Bob", age: "25" },
  ]);
});

test("ignores trailing blank lines", () => {
  const text = "a,b\n1,2\n\n";
  assert.deepStrictEqual(parseCsv(text), [{ a: "1", b: "2" }]);
});

test("empty body yields empty array", () => {
  assert.deepStrictEqual(parseCsv("x,y\n"), []);
});
