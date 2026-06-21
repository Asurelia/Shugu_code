const { collapse } = require("./slugify.js");

function makeSlug(title) {
  return collapse(String(title).toLowerCase().trim());
}

module.exports = { makeSlug };
