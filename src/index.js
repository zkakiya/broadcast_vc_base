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
  console.log('[boot] web server started');


  // Discordログイン
  await client.login(CFG.botToken);
  console.log(`✅ Logged in as bot`);

  voice.setIo(io);  // Socket.IOをセット

  // Multiモード時のVC接続とWhisper起動
  if (CFG.mode === 'multi') {
    await probeWhisper();
    await joinAndRecordVC();
  }
})();