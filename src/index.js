import './env/load.js';
import { CFG, assertConfig } from './config.js';
import { probeWhisper } from './core/transcribe.js';
import { startWebServer } from './web/server.js';
import { cleanRecordingsDir } from './utils/cleanup.js';
import * as voice from './discord/voice.js';

import pkg from '../package.json' with { type: 'json' };
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
const req = createRequire(import.meta.url);

function safeRequire(name) {
  try { return req(name); } catch { return null; }
}

const v = {
  node: process.version,
  app: pkg?.version ?? '0.0.0',
  discordjs: safeRequire('discord.js')?.version ?? 'n/a',
  voice: safeRequire('@discordjs/voice')?.version ?? 'n/a',
  opus: safeRequire('@discordjs/opus') ? 'yes' : 'no',
  sodium: safeRequire('libsodium-wrappers') ? 'yes' : 'no',
};
console.log('[boot] versions:', v);

assertConfig();

(async () => {
  const { client } = await import('./discord/client.js');
  const { joinAndRecordVC } = await import('./discord/voice.js');

  // Cleanup
  console.log('[boot] cleanup…');
  // recordings / recordings/_stream を既定ターゲットとして決定
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const recordingsDir = path.join(__dirname, 'recordings');
  const streamDir = path.join(recordingsDir, '_stream');
  try { fs.mkdirSync(recordingsDir, { recursive: true }); } catch { }
  try { fs.mkdirSync(streamDir, { recursive: true }); } catch { }

  // 互換：CFG.cleanupDir があれば追加対象に、配列指定にも対応
  const extra = [];
  if (CFG.cleanupDir) extra.push(CFG.cleanupDir);
  if (Array.isArray(CFG.cleanup?.dirs)) extra.push(...CFG.cleanup.dirs);

  const maxAgeMinutes = Number(CFG.cleanup?.maxAgeMinutes ?? 0);   // 0=全削除（音声拡張子のみ）
  const dryRun = Boolean(CFG.cleanup?.dryRun ?? false);

  // 既定 + 追加ターゲットをユニーク化して順次クリーンアップ
  const targets = [...new Set([recordingsDir, streamDir, ...extra].filter(Boolean))];
  for (const dir of targets) {
    await cleanRecordingsDir({ dir, maxAgeMinutes, dryRun });
  }

  // Webサーバー起動
  const io = await startWebServer(CFG.port);
  console.log('[boot] web server started');


  // Discordログイン
  await client.login(CFG.botToken);
  console.log(`✅ Logged in as bot`);

  voice.setIo(io);  // Socket.IOをセット

  // VC接続とWhisper起動（voiceChannelId があれば modeに関わらず参加）
  await probeWhisper();
  if (CFG.discord.voiceChannelId) {
    await joinAndRecordVC();
  } else {
    console.warn('[boot] VOICE_CHANNEL_ID が未設定のためVC参加をスキップしました（latest/timeline表示のみ稼働）');
  }
})();