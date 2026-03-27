const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function fmt(level, msg, ...args) {
    const ts = new Date().toISOString();
    const extra = args.length ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ') : '';
    return `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}${extra}`;
}

const logger = {
    error: (msg, ...args) => LEVELS.error <= currentLevel && console.error(fmt('error', msg, ...args)),
    warn: (msg, ...args) => LEVELS.warn <= currentLevel && console.warn(fmt('warn', msg, ...args)),
    info: (msg, ...args) => LEVELS.info <= currentLevel && console.log(fmt('info', msg, ...args)),
    debug: (msg, ...args) => LEVELS.debug <= currentLevel && console.log(fmt('debug', msg, ...args)),
};

module.exports = logger;
