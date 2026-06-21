// One tangled block — the task is to extract mean/min/max helpers and export them.
function summary(nums) {
  let total = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of nums) {
    total += n;
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  return { mean: total / nums.length, min: lo, max: hi };
}

module.exports = { summary };
