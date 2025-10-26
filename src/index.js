// src/index.js
import 'dotenv/config';
import { CONFIG } from './config.js';
import { client } from './discord/client.js';
import { cleanRecordingsDir } from './utils/cleanup.js';
import { io, startWebServer } from './web/server.js';

// 環境変数で調整可能に
const REC_DIR = process.env.RECORDINGS_DIR || './src/recordings';
const MAX_AGE_MIN = process.env.CLEAN_RECORDINGS_MAX_AGE_MIN
  ? Number(process.env.CLEAN_RECORDINGS_MAX_AGE_MIN)
  : 0; // 0 = すべて削除
const DRY_RUN = process.env.CLEAN_RECORDINGS_DRY_RUN === '1';

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

// ── モードチェック ─────────────────────────────────────────────
const MODE = (process.env.MODE || 'multi').toLowerCase();

// ── 共通エラーハンドラ（クラッシュ防止） ──────────────────────
client.on('error', (err) => console.error('[client] error:', err));
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

if (MODE === 'multi') {
  // Discord を使うのは multi のみ。まずログインしてから clientReady を待つ。
  let bootstrapped = false;
  const onClientReady = async () => {
    if (bootstrapped) return; // 二重起動ガード
    bootstrapped = true;
    console.log(`✅ Logged in as ${client.user.tag}`);

    // 動的 import（不要依存の読み込みを避ける）
    try {
      const m = await import('./discord/voice.js');
      m.setIo(io);
      await m.joinAndRecordVC();
    } catch (e) {
      console.error('voice join failed', e);
    }
  };

  // v14: 'ready' / v15+: 'clientReady' の両対応（どちらが来ても1回だけ実行）
  client.once('clientReady', onClientReady);

  console.log('[boot] login…');
  // すべてのイベントハンドラを登録し終えてからログイン開始
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
