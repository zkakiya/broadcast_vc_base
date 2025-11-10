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
  wsPort: num(process.env.WS_PORT, 8081),
  cleanupDir: process.env.RECORDINGS_DIR || 'src/recordings',
  // ...他の基本項目は同様...
  discord: {
    token: process.env.DISCORD_TOKEN,
    guildId: process.env.GUILD_ID,
    voiceChannelId: process.env.VOICE_CHANNEL_ID,    // ENVキー名を統一（VOICE_CH_ID→VOICE_CHANNEL_ID）
    textChannelId: process.env.TEXT_CHANNEL_ID,      // 追加: テキストチャンネルID
    retryMax: num(process.env.VOICE_RETRY_MAX, 5),             // 追加: VC再接続リトライ回数
    retryInitialMs: num(process.env.VOICE_RETRY_INITIAL_MS, 1500), // 追加: リトライ初期待機ms
    retryMaxMs: num(process.env.VOICE_RETRY_MAX_MS, 30000),    // 追加: リトライ最大待機ms
  },
  asr: {
    impl: (process.env.WHISPER_IMPL || 'faster').toLowerCase(), // 小文字統一
    model: process.env.WHISPER_MODEL || 'small',
    lang: process.env.WHISPER_LANG || 'ja',
    fwWorker: num(process.env.FW_WORKER, 1),
    hints: csv(process.env.ASR_HINTS),
    computeType: process.env.FW_COMPUTE_TYPE || 'float16',
    device: process.env.FASTER_WHISPER_DEVICE || 'cuda',
    // 追加: VAD・ASR関連パラメータをCFGに集約
    vadSilenceMs: num(process.env.VAD_SILENCE_MS, 350),
    utterMaxMs: num(process.env.UTTER_MAX_MS, 3000),
    segGapMs: num(process.env.SEG_GAP_MS, 80),
    concurrency: num(process.env.ASR_CONCURRENCY, 2),
    phraseWindowMs: num(process.env.ASR_PHRASE_WINDOW_MS, 4000),
    phraseMaxKeep: num(process.env.ASR_PHRASE_MAX_KEEP, 8),
    vadFrameMs: num(process.env.VAD_FRAME_MS, 20),
    vadRmsThreshold: num(process.env.VAD_RMS_THRESHOLD, 800),
    segMinMs: num(process.env.SEG_MIN_MS, 800),
    segMaxMs: num(process.env.SEG_MAX_MS, 2200),
  },
  translate: {
    provider: (process.env.TRANSLATE_PROVIDER || 'google').toLowerCase(),   // ENVキー名統一（TRANS_PROVIDER→TRANSLATE_PROVIDER）
    throttleMs: num(process.env.TRANSLATE_THROTTLE_MS, 800),                // ENVキー名統一（TRANS_TRANSLATE_THROTTLE_MS→TRANSLATE_THROTTLE_MS）
    deeplKey: process.env.DEEPL_API_KEY,
    azureKey: process.env.AZURE_TRANSLATOR_KEY,
    azureRegion: process.env.AZURE_TRANSLATOR_REGION,
    enabled: bool(process.env.TRANSLATE_ENABLED, true),        // ENVキー名統一（TRANS_TRANSLATE_ENABLED→TRANSLATE_ENABLED）
    defaultTarget: process.env.TRANSLATE_TARGET_DEFAULT || null, // ENVキー名統一（TRANS_DEFAULT_TARGET→TRANSLATE_TARGET_DEFAULT）
  },
  flags: {
    dictApplyTr: bool(process.env.ASR_DICT_APPLY_TR, true),
    shortWavLog: bool(process.env.SHORT_WAV_LOG, true),   // 追加: 短尺WAVスキップ時のログ出力フラグ
    voiceDebug: bool(process.env.VOICE_DEBUG, false),     // 追加: Discord音声状態遷移ログフラグ
  },
  metrics: {
    window: num(process.env.METRICS_WINDOW, 20),
    switchUpMs: num(process.env.ASR_SWITCH_UP_MS, 900),
    switchDownMs: num(process.env.ASR_SWITCH_DOWN_MS, 700),
    minWavBytes: num(process.env.MIN_WAV_BYTES, 48000),   // 追加: 最低WAVバイト数（短すぎる音声の閾値）
  },
  solo: {  // 追加: ソロモード関連設定を集約
    tcpPort: num(process.env.SOLO_TCP_PORT, 52000),
    sampleRate: num(process.env.SOLO_SR, 16000),
    channels: num(process.env.SOLO_CH, 1),
    maxQueue: num(process.env.RT_MAX_QUEUE, 3),
    coalesceMs: num(process.env.RT_COALESCE_MS, 3500),
  }
};

export function assertConfig() {
  const missing = [];
  if (!CFG.discord.token) missing.push('DISCORD_TOKEN');
  if (!CFG.discord.guildId) missing.push('GUILD_ID');
  if (CFG.mode === 'multi' && !CFG.discord.voiceChannelId) missing.push('VOICE_CHANNEL_ID');
  if (CFG.mode === 'multi' && !CFG.discord.textChannelId) missing.push('TEXT_CHANNEL_ID');
  if (missing.length) throw new Error(`Missing required env: ${missing.join(', ')}`);
}
