function sum(nums) {
  return nums.reduce((a, b) => a + b, 0);
}

function average(nums) {
  return sum(nums) / nums.length;
}

module.exports = { sum, average };
