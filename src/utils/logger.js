const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
const order = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
const allow = (lv) => order[lv] <= (order[level] ?? 3);
export const log = {
    error: (...a) => allow('error') && console.error(...a),
    warn: (...a) => allow('warn') && console.warn(...a),
    info: (...a) => allow('info') && console.log(...a),
    debug: (...a) => allow('debug') && console.debug(...a),
    trace: (...a) => allow('trace') && console.debug(...a),
};
