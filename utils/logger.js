class Logger {
  create(name) {
    const prefix = () => `[${new Date().toISOString()}]`;
    return {
      info: (...args) => console.log(`${prefix()} [INFO]  [${name}]`, ...args),
      warn: (...args) => console.warn(`${prefix()} [WARN]  [${name}]`, ...args),
      error: (...args) => console.error(`${prefix()} [ERROR] [${name}]`, ...args),
    };
  }
}

module.exports = new Logger();
