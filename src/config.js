import './env/load.js';

function bool(v, d = false) {
  if (v === undefined || v === null || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function csv(v = '') {
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

export const CFG = {
  mode: process.env.MODE || 'multi',
  port: num(process.env.PORT, 8080),
  webPort: num(process.env.WEB_PORT || process.env.PORT, 8080),
  wsPort: num(process.env.WS_PORT, 8081),
  clean: process.env.CLEAN_DIR ?? null,
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.GUILD_ID,
    voiceChannelId: process.env.VOICE_CHANNEL_ID,
  },
  asr: {
    impl: process.env.WHISPER_IMPL || 'faster',
    model: process.env.WHISPER_MODEL || 'small',
    lang: process.env.WHISPER_LANG || 'ja',
    fwWorker: num(process.env.FW_WORKER, 1),
    hints: csv(process.env.ASR_HINTS),
    computeType: process.env.FW_COMPUTE_TYPE || 'float16',
    device: process.env.FASTER_WHISPER_DEVICE || 'cuda',
  },
  translate: {
    provider: (process.env.TRANS_PROVIDER || 'google').toLowerCase(),
    throttleMs: num(process.env.TRANS_TRANSLATE_THROTTLE_MS, 800),
    deeplKey: process.env.DEEPL_API_KEY,
    azureKey: process.env.AZURE_TRANSLATOR_KEY,
    azureRegion: process.env.AZURE_TRANSLATOR_REGION,
    enabled: bool(process.env.TRANS_TRANSLATE_ENABLED, true),
    defaultTarget: process.env.TRANS_DEFAULT_TARGET || null,
  },
  flags: {
    dictApplyTr: bool(process.env.ASR_DICT_APPLY_TR, true),
  },
  metrics: {
    window: num(process.env.METRICS_WINDOW, 20),
    switchUpMs: num(process.env.ASR_SWITCH_UP_MS, 900),
    switchDownMs: num(process.env.ASR_SWITCH_DOWN_MS, 700),
  }
};

export function assertConfig() {
  const missing = [];
  if (!CFG.discord.token) missing.push('DISCORD_TOKEN');
  if (!CFG.discord.guildId) missing.push('GUILD_ID');
  if (CFG.mode === 'multi' && !CFG.discord.voiceChannelId) missing.push('VOICE_CH_ID');
  if (missing.length) {
    throw new Error(`Missing required env: ${missing.join(', ')}`);
  }
}
