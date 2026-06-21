function isPlainObject(v) {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function deepMerge(base, override) {
  const out = {};
  for (const key of Object.keys(base)) {
    out[key] = isPlainObject(base[key]) ? deepMerge(base[key], {}) : base[key];
  }
  for (const key of Object.keys(override)) {
    if (isPlainObject(base[key]) && isPlainObject(override[key])) {
      out[key] = deepMerge(base[key], override[key]);
    } else if (isPlainObject(override[key])) {
      out[key] = deepMerge(override[key], {});
    } else {
      out[key] = override[key];
    }
  }
  return out;
}

module.exports = { deepMerge };
