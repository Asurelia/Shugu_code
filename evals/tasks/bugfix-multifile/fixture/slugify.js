// BUG: the trailing-hyphen strip regex anchors to start (^) twice instead of
// stripping the trailing hyphen, so "hello-world-" keeps its trailing dash.
function collapse(s) {
  return s
    .replace(/[^a-z0-9]+/g, "-") // runs of non-alphanumerics -> single hyphen
    .replace(/^-+/, "") // strip leading hyphens
    .replace(/^-+/, ""); // BUG: should be /-+$/ to strip trailing hyphens
}

module.exports = { collapse };
