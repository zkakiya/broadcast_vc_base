// src/env/load.js
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

/** 指定パスが存在すれば読み込む（後勝ち） */
function loadIfExists(p) {
    try {
        if (fs.existsSync(p)) {
            dotenv.config({ path: p, override: true });
            console.log('[env] loaded:', p);
            return true;
        }
    } catch { }
    return false;
}

// 1) まず .env（最下層の既定）
loadIfExists(path.resolve('.env'));

// MODE は事前に決める（既に .env で決まっていればそれを優先）
const MODE = (process.env.MODE || '').toLowerCase() || 'multi';

// 2) 共有
loadIfExists(path.resolve('apps/.env.shared'));

// 3) モード別（最後に読み込み＝ここが最優先）
loadIfExists(path.resolve(`apps/.env.${MODE}`));

// 参考ログ（必要に応じて消せます）
console.log('[env] MODE =', MODE);
console.log('[env] snapshot:', {
    WHISPER_IMPL: process.env.WHISPER_IMPL,
    WHISPER_MODEL: process.env.WHISPER_MODEL,
    FASTER_WHISPER_DEVICE: process.env.FASTER_WHISPER_DEVICE,
    FW_COMPUTE_TYPE: process.env.FW_COMPUTE_TYPE,
    WHISPER_LANG: process.env.WHISPER_LANG,
});
