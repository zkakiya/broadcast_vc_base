// src/index.js

// 1) まず .env ロードを“確定”させる（後勝ちで上書き）
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// 既定: .env（最下層）
if (fs.existsSync(path.resolve('.env'))) {
  dotenv.config({ path: path.resolve('.env'), override: false }); // base
  console.log('[env] loaded: .env');
}

// MODE は .env か外部環境で決める。無ければ 'multi'
let MODE = (process.env.MODE || 'multi').toLowerCase();

// 共有: apps/.env.shared（後勝ち）
if (fs.existsSync(path.resolve('apps/.env.shared'))) {
  dotenv.config({ path: path.resolve('apps/.env.shared'), override: true });
  console.log('[env] loaded: apps/.env.shared');
  // ここで MODE が上書きされる可能性もあるので取り直す
  MODE = (process.env.MODE || MODE).toLowerCase();
}

// モード別: apps/.env.<mode>（最優先・後勝ち）
const modeEnvPath = path.resolve(`apps/.env.${MODE}`);
if (fs.existsSync(modeEnvPath)) {
  dotenv.config({ path: modeEnvPath, override: true });
  console.log('[env] loaded:', `apps/.env.${MODE}`);
} else {
  console.log('[env] mode file missing:', `apps/.env.${MODE}`);
}

// スナップショット表示（確認用）
console.log('[env] MODE =', MODE);
console.log('[env] snapshot:', {
  WHISPER_IMPL: process.env.WHISPER_IMPL,
  WHISPER_MODEL: process.env.WHISPER_MODEL,
  FASTER_WHISPER_DEVICE: process.env.FASTER_WHISPER_DEVICE,
  FW_COMPUTE_TYPE: process.env.FW_COMPUTE_TYPE,
  WHISPER_LANG: process.env.WHISPER_LANG,
});

// 2) env 確定後に他モジュールを読み込む（ここから従来のロジック）
const { CONFIG } = await import('./config.js');
const { client } = await import('./discord/client.js');
const { cleanRecordingsDir } = await import('./utils/cleanup.js');
const { io, startWebServer } = await import('./web/server.js');

console.log('[boot] index.js start');

console.log('[boot] cleanup…');
await cleanRecordingsDir(CONFIG.clean);
console.log('[boot] cleanup done');

console.log('[boot] start web server…');
try {
  await startWebServer(); // ここで listening ログが出るはず
  console.log('[boot] web server started');
} catch (e) {
  console.error('[boot] web server failed:', e);
}

// ── 共通エラーハンドラ（クラッシュ防止） ──────────────────────
client.on('error', (err) => console.error('[client] error:', err));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// ── モード分岐 ────────────────────────────────────────────────
if (MODE === 'multi') {
  // Discord を使うのは multi のみ。まずログインしてから clientReady を待つ。
  let bootstrapped = false;
  const onClientReady = async () => {
    if (bootstrapped) return; // 二重起動ガード
    bootstrapped = true;
    console.log(`✅ Logged in as ${client.user.tag}`);

    try {
      const m = await import('./discord/voice.js');
      m.setIo(io);
      await m.joinAndRecordVC();
    } catch (e) {
      console.error('voice join failed', e);
    }
  };

  // v15 以降: clientReady（ready は使わない）
  client.once('clientReady', onClientReady);

  console.log('[boot] login…');
  await client.login(CONFIG.botToken);
} else if (MODE === 'solo') {
  // solo は Discord を使わない。即座にソロのパイプラインを起動。
  const kind = (process.env.SOLO_MODE || 'realtime').toLowerCase();
  try {
    if (kind === 'realtime') {
      const m = await import('./solo/realtime.js');
      m.setIo(io);
      m.startSoloRealtime().catch(e => console.error('solo realtime failed', e));
    } else {
      const m = await import('./solo/recorder.js');
      m.setIo(io);
      m.startSoloRecorder().catch(e => console.error('solo recorder failed', e));
    }
  } catch (e) {
    console.error('[solo] boot failed:', e);
  }
} else {
  console.warn(`[boot] unknown MODE=${MODE}; nothing started.`);
}
