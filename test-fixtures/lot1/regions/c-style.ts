// LOT 1 — Region folding test: C-style // #region.
// Used by TypeScript / Rust / Go / Java / C / C++ / PHP.
// Click the fold gutter on the `// #region` line to collapse the body.

// #region Helpers
function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}

function divide(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}
// #endregion

// #region Main
function main() {
  console.log(add(1, 2));
  console.log(multiply(3, 4));
  console.log(divide(10, 2));
}
// #endregion

main();
