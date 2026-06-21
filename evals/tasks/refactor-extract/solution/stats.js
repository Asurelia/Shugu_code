function mean(nums) {
  let total = 0;
  for (const n of nums) total += n;
  return total / nums.length;
}

function min(nums) {
  let lo = Infinity;
  for (const n of nums) if (n < lo) lo = n;
  return lo;
}

function max(nums) {
  let hi = -Infinity;
  for (const n of nums) if (n > hi) hi = n;
  return hi;
}

function summary(nums) {
  return { mean: mean(nums), min: min(nums), max: max(nums) };
}

module.exports = { summary, mean, min, max };
