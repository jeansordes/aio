const { EventEmitter } = require("node:events");

/**
 * @returns {import('node:events').EventEmitter}
 */
function createEventBus() {
  return new EventEmitter();
}

module.exports = {
  createEventBus,
};
