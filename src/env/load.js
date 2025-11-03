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

// 1) まず .env（最下層の既定）※既存の環境変数を上書きしない
if (fs.existsSync(path.resolve('.env'))) {
    dotenv.config({ path: path.resolve('.env'), override: false });
    console.log('[env] loaded: .env');
}

const MODE = (process.env.MODE || 'multi').toLowerCase();

// 2) 共有設定を上書き読み込み
loadIfExists(path.resolve('apps/.env.shared'));

// 3) モード別の設定をさらに上書き
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
