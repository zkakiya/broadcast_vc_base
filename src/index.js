import 'dotenv/config';
import { CONFIG } from './config.js';
import { client } from './discord/client.js';
import { cleanRecordingsDir } from './utils/cleanup.js';
import { io, startWebServer } from './web/server.js';
import { setIo, joinAndRecordVC } from './discord/voice.js';

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
  await startWebServer();           // ここで listening ログが出るはず
  console.log('[boot] web server started');
} catch (e) {
  console.error('[boot] web server failed:', e);
}

setIo(io);

 // v14 互換 + v15 以降の先取り
 const onClientReady = async () => {
   console.log(`✅ Logged in as ${client.user.tag}`);
   await joinAndRecordVC();
 };
['clientReady', 'ready'].forEach(ev => client.once(ev, onClientReady));
console.log('[boot] login…');
// すべてのイベントハンドラを登録し終えてからログイン開始
client.login(CONFIG.botToken).catch(console.error);