// BUG: average divides the sum by (length + 1) instead of length.
function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

function average(nums) {
  return sum(nums) / (nums.length + 1);
}

module.exports = { sum, average };
