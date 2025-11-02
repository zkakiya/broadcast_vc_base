import './env/load.js';
import { CFG, assertConfig } from './config.js';
import { probeWhisper } from './core/transcribe.js';
import { startWebServer } from './web/server.js';
import { cleanRecordingsDir } from './utils/cleanup.js';

assertConfig();

(async () => {
  const { client } = await import('./discord/client.js');
  const { joinAndRecordVC } = await import('./discord/voice.js');

  // Cleanup
  cleanRecordingsDir(CFG.cleanupDir);

  // Webサーバー起動
  startWebServer(CFG.port);

  // Discordログイン
  await client.login(CFG.botToken);
  console.log(`✅ Logged in as bot`);

  // Multiモード時のVC接続とWhisper起動
  if (CFG.mode === 'multi') {
    await probeWhisper();
    await joinAndRecordVC();
  }
})();