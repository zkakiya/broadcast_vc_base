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

await cleanRecordingsDir(CONFIG.clean);

setIo(io);

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  startWebServer();             // 👈 OBS向けページ起動
  await joinAndRecordVC();      // 👈 VC録音＆文字起こし開始
});

// すべてのイベントハンドラを登録し終えてからログイン開始
client.login(CONFIG.botToken).catch(console.error);