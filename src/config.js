// src/config.js
import 'dotenv/config';

export const CONFIG = {
  webPort: Number(process.env.WEB_PORT ?? 3000),
  publicDir: process.env.PUBLIC_DIR || 'public',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  guildId: process.env.GUILD_ID,
  voiceChannelId: process.env.VOICE_CHANNEL_ID,
  textChannelId: process.env.TEXT_CHANNEL_ID,
  botToken: process.env.BOT_TOKEN,

  recordingsDir: process.env.RECORDINGS_DIR || './src/recordings',
  minWavBytes: Number(process.env.MIN_WAV_BYTES ?? 48000),       // ~0.5秒
  vadSilenceMs: Number(process.env.VAD_SILENCE_MS ?? 600),       // 600–900おすすめ
  whisperNoSpeech: process.env.WHISPER_NO_SPEECH ?? '0.3',

  shortWavLog: process.env.SHORT_WAV_LOG !== '0',               // ログ抑制トグル
  clean: {
  dir: process.env.RECORDINGS_DIR || './src/recordings',
  maxAgeMinutes: Number(process.env.CLEAN_RECORDINGS_MAX_AGE_MIN ?? 0),
  dryRun: process.env.CLEAN_RECORDINGS_DRY_RUN === '1',
  },
};

