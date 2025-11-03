import './env/load.js';
import { CFG, assertConfig } from './config.js';
import { probeWhisper } from './core/transcribe.js';
import { startWebServer } from './web/server.js';
import { cleanRecordingsDir } from './utils/cleanup.js';
import * as voice from './discord/voice.js';

assertConfig();

(async () => {
  const { client } = await import('./discord/client.js');
  const { joinAndRecordVC } = await import('./discord/voice.js');

  // Cleanup
  console.log('[boot] cleanup…');
  cleanRecordingsDir(CFG.cleanupDir);

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