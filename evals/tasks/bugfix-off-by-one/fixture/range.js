// BUG: the loop condition uses `<` so it excludes `end` (off-by-one).
function range(start, end) {
  const out = [];
  for (let i = start; i < end; i++) {
    out.push(i);
  }
  return out;
}

module.exports = { range };
