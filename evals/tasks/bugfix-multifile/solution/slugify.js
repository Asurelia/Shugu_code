function collapse(s) {
  return s
    .replace(/[^a-z0-9]+/g, "-") // runs of non-alphanumerics -> single hyphen
    .replace(/^-+/, "") // strip leading hyphens
    .replace(/-+$/, ""); // strip trailing hyphens
}

module.exports = { collapse };
