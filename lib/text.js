const { stripVTControlCharacters } = require("node:util");
function safeText(text) {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

module.exports = { safeText };
