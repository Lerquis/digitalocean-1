class Logger {
  create(name) {
    const prefix = () => `[${new Date().toISOString()}]`;
    const isQuiet = process.env.LOG_ONLY_SUMMARY === "true";

    return {
      info: (...args) => {
        if (!isQuiet) console.log(`${prefix()} [INFO]  [${name}]`, ...args);
      },
      warn: (...args) => console.warn(`${prefix()} [WARN]  [${name}]`, ...args),
      error: (...args) =>
        console.error(`${prefix()} [ERROR] [${name}]`, ...args),
      summary: (...args) =>
        console.log(`${prefix()} [SUMMARY] [${name}]`, ...args),
    };
  }
}

module.exports = new Logger();
