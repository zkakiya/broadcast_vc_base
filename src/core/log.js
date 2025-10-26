// src/core/log.js
const NS = (mod) => ({
    info: (...a) => console.log(`[${mod}]`, ...a),
    warn: (...a) => console.warn(`[${mod}]`, ...a),
    error: (...a) => console.error(`[${mod}]`, ...a),
    debug: (...a) => { if (process.env.DEBUG === '1') console.log(`[${mod}]`, ...a); },
});
export const log = {
    core: NS('core'),
    vc: NS('voice'),
    server: NS('server'),
    whisp: NS('whisper'),
};
