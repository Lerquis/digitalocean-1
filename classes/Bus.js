const { EventEmitter } = require("node:events");

class EventBus extends EventEmitter {}

module.exports = EventBus;
