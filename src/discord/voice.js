// src/discord/voice.js
// VC接続 → 発話検知 → Opus→PCM→WAV → Whisper(Python) → Discord送信 → OBS字幕プッシュ
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import wav from 'wav';
import prism from 'prism-media';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} from '@discordjs/voice';

import { client, GUILD_ID, VOICE_CHANNEL_ID, TEXT_CHANNEL_ID } from './client.js';
import { transcribeAudioGPU } from '../core/transcribe.js';
let ioRef = null;
export function setIo(io) { ioRef = io; }
import { getSpeaker } from '../registry/speakers.js';
import { CONFIG } from '../config.js';
import { translateText } from '../utils/translate.js';
import { sanitizeASR, canonicalizeForDup } from '../utils/text_sanitize.js';

import { getPersonProtectSet } from '../utils/dictionary.js';


// ── VC接続ハンドル ───────────────────────────────────────────
let currentConnection = null;
let isReconnecting = false;

// ── 低遅延向けパラメータ（ENVで上書き可） ────────────────
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 350);
const UTTER_MAX_MS = Number(process.env.UTTER_MAX_MS || 3000);
const SEG_GAP_MS = Number(process.env.SEG_GAP_MS || 80);

// __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 録音ディレクトリは src/recordings に固定
const recordingsDir = path.join(__dirname, '../recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

// ── 重複発火/多重送信ガード ──────────────────────────────
const activeSessions = new Map();  // userId -> { closing: boolean }
const lastTexts = new Map();  // userId -> { text, ts }

// userIdごとに最近のフレーズを保持して“ほぼ同じ”を弾く
const recentPhraseMap = new Map(); // userId -> Array<{canon:string, ts:number}>
const PHRASE_WINDOW_MS = Number(process.env.ASR_PHRASE_WINDOW_MS || 4000); // 4秒窓
const PHRASE_MAX_KEEP = Number(process.env.ASR_PHRASE_MAX_KEEP || 8);      // バッファ長

// ── Whisper直列実行（負荷スパイク抑制） ───────────────────
import { createLimiter } from '../utils/limiter.js';
const limitASR = createLimiter(Number(process.env.ASR_CONCURRENCY || 2));
function enqueue(task) { return limitASR(task); }

// ── 再接続ポリシー ────────────────────────────────────────
const VOICE_RETRY_MAX = Number(process.env.VOICE_RETRY_MAX ?? 5);
const VOICE_RETRY_INITIAL_MS = Number(process.env.VOICE_RETRY_INITIAL_MS ?? 1500);
const VOICE_RETRY_MAX_MS = Number(process.env.VOICE_RETRY_MAX_MS ?? 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function backoffDelay(attempt, baseMs, maxMs) {
  const pure = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(pure / 2)));
  return Math.min(pure + jitter, maxMs);
}

// ── 翻訳バッファ：全文“置換”で安定描画 ───────────────────────
const translateBuffers = new Map(); // baseId -> { timer, full, target }
const THROTTLE_MS = Number(process.env.TRANS_TRANSLATE_THROTTLE_MS || 800);

function scheduleTranslate({ id, appendText, target }) {
  if (!target) return;
  const cur = translateBuffers.get(id) || { timer: null, full: '', target };
  cur.full += appendText;
  cur.target = target;

  if (cur.timer) clearTimeout(cur.timer);
  cur.timer = setTimeout(async () => {
    try {
      const srcFull = cur.full.trim();
      if (!srcFull) return;

      let tr = await translateText({ text: srcFull, target: cur.target });
      if (!tr) return;

      // 辞書適用（任意）
      if (process.env.ASR_DICT_APPLY_TR === '1') {
        try {
          const { applyUserDictionary } = await import('../utils/dictionary.js');
          tr = applyUserDictionary(tr);
        } catch { }
      }

      if (ioRef) ioRef.emit('transcript_update', {
        id,
        tr: { to: cur.target, text: tr, mode: 'replace' }
      });
    } catch (e) {
      console.warn('[translate buffer] failed:', e?.message || e);
    }
  }, THROTTLE_MS);

  translateBuffers.set(id, cur);
}
function resetTranslateBuffer(id) {
  const buf = translateBuffers.get(id);
  if (!buf) return;
  if (buf.timer) clearTimeout(buf.timer);
  translateBuffers.delete(id);
}

// ── 本体 ───────────────────────────────────────────────────
export async function joinAndRecordVC() {
  if (!client.user) {
    await new Promise(res => client.once('clientReady', res));
  }
  const guild = await client.guilds.fetch(GUILD_ID);
  if (!guild) throw new Error('Guild not found');

  const voiceChannel = await guild.channels.fetch(VOICE_CHANNEL_ID);
  if (!voiceChannel) throw new Error('Voice channel not found');

  if (currentConnection) {
    try { currentConnection.destroy(); } catch { }
    currentConnection = null;
  }

  let attempt = 0;
  const maxAttempts = VOICE_RETRY_MAX;
  const baseDelay = VOICE_RETRY_INITIAL_MS;
  let connection;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
        preferredEncryptionMode: 'aead_xchacha20_poly1305_rtpsize',
      });
      currentConnection = connection;

      connection.on('error', (err) => {
        console.error('[voice] connection error:', err?.message || err);
      });
      const VOICE_DEBUG = process.env.VOICE_DEBUG === '1';
      connection.on('stateChange', async (oldS, newS) => {
        if (VOICE_DEBUG) console.log(`[voice] state ${oldS.status} -> ${newS.status}`);
        if (newS.status === VoiceConnectionStatus.Disconnected && !isReconnecting) {
          isReconnecting = true;
          try {
            await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
            await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
            isReconnecting = false;
            return;
          } catch { }
          try { currentConnection?.destroy(); } catch { }
          currentConnection = null;
          let ok = false;
          for (let i = 1; i <= VOICE_RETRY_MAX; i++) {
            try {
              await sleep(backoffDelay(i, VOICE_RETRY_INITIAL_MS, VOICE_RETRY_MAX_MS));
              await joinAndRecordVC();
              ok = true;
              break;
            } catch (e) {
              console.warn(`[voice] backoff reconnect ${i}/${VOICE_RETRY_MAX} failed:`, e?.message || e);
            }
          }
          if (!ok) console.error('[voice] Reconnect failed after retries');
          isReconnecting = false;
        }
      });

      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
      console.log('🎧 Voice connection ready');
      break;
    } catch (e) {
      console.warn(`[voice] join attempt ${attempt} failed:`, e?.code || e?.message || e);
      try { connection?.destroy(); } catch { }
      if (attempt >= maxAttempts) throw e;
      const wait = backoffDelay(attempt, baseDelay, VOICE_RETRY_MAX_MS);
      await sleep(wait);
    }
  }

  const receiver = currentConnection.receiver;
  receiver.speaking.setMaxListeners(100);

  receiver.speaking.on('start', (userIdRaw) => {
    const userId = String(userIdRaw);
    if (activeSessions.has(userId)) return;
    activeSessions.set(userId, { closing: false, segment: 0, open: true });

    console.log(`🔊 ${userId} started speaking`);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: VAD_SILENCE_MS },
    });
    opusStream.setMaxListeners(0);

    let segIndex = 0;
    let wavPath = null;
    let wavWriter = null;
    let decoder = null;
    let forceTimer = null;
    let segStart = 0;
    let baseId = null;
    let firstFlushDone = false;
    let sentMsgRef = null;

    const startSegment = () => {
      segIndex += 1;
      segStart = Date.now();
      wavPath = path.join(recordingsDir, `${userId}-${segStart}-${segIndex}.wav`);
      decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
      wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });

      opusStream
        .pipe(decoder)
        .on('error', (e) => console.error('decoder error:', e))
        .pipe(wavWriter)
        .on('error', (e) => console.error('wavWriter error:', e));

      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = setTimeout(() => { endSegment(true); }, UTTER_MAX_MS);
    };

    const endSegment = (forced = false) => {
      if (!wavWriter) return;
      try { decoder?.unpipe?.(wavWriter); } catch { }
      try { wavWriter.end(); } catch { }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }

      const thisWav = wavPath;
      wavWriter = null; decoder = null; wavPath = null;

      setTimeout(async () => {
        try {
          const st = fs.statSync(thisWav);
          const MIN_WAV_BYTES = Number(process.env.MIN_WAV_BYTES ?? 48000);
          if (st.size < MIN_WAV_BYTES) {
            if (process.env.SHORT_WAV_LOG !== '0') {
              console.log(`(skip) short wav: ${st.size}B < ${MIN_WAV_BYTES}B`);
            }
            try { fs.unlinkSync(thisWav); } catch { }
            return;
          }

          const recognizedText = await enqueue(() => transcribeAudioGPU(thisWav));
          const cleanedText = sanitizeASR(recognizedText, { protect: getPersonProtectSet() });
          if (cleanedText && cleanedText.length) {
            // ① 時間窓デュープ（“ほぼ同じ”を 4s 窓で弾く）
            const canon = canonicalizeForDup(cleanedText);
            const now = Date.now();
            let buf = recentPhraseMap.get(userId) || [];
            buf = buf.filter(x => now - x.ts <= PHRASE_WINDOW_MS);
            if (buf.some(x => x.canon === canon)) {
              return; // 同一発話の反復っぽいので破棄
            }
            buf.push({ canon, ts: now });
            if (buf.length > PHRASE_MAX_KEEP) buf.shift();
            recentPhraseMap.set(userId, buf);

            // ② 完全一致の直近デュープも継続（既存ロジック）
            const prev = lastTexts.get(userId);
            if (!(prev && prev.text === cleanedText && now - prev.ts < 3000)) {
              lastTexts.set(userId, { text: cleanedText, ts: now });

              // 以降は cleanedText を使ってそのまま既存処理
              const sp = getSpeaker(userId);
              const speakerName = sp?.name || 'Speaker';
              const speakerSide = sp?.side;
              const speakerColor = sp?.color;
              const speakerAvatar = sp?.avatar;
              const speakerIcon = sp?.icon;
              const translateTarget = sp?.translateTo || CONFIG?.translate?.defaultTarget;

              if (!baseId) baseId = `${userId}-${segStart}`;
              if (!firstFlushDone) {
                firstFlushDone = true;
                const payload = {
                  id: baseId,
                  userId,
                  name: speakerName,
                  side: speakerSide,
                  color: speakerColor,
                  avatar: speakerAvatar,
                  icon: speakerIcon,
                  text: cleanedText,
                  lang: sp?.lang || 'ja',
                  ts: now,
                };
                if (ioRef) ioRef.emit('transcript', payload);
              } else {
                if (ioRef) ioRef.emit('transcript_update', { id: baseId, append: cleanedText });
              }

              // Discord 原文
              try {
                const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
                if (textChannel && textChannel.isTextBased()) {
                  if (!sentMsgRef) {
                    sentMsgRef = await textChannel.send(`**${speakerName}**: ${cleanedText}`);
                  } else {
                    const cur = sentMsgRef.content ?? '';
                    const next = cur + '\n' + cleanedText;
                    try { await sentMsgRef.edit(next); }
                    catch { sentMsgRef = await textChannel.send(cleanedText); }
                  }
                }

                // 訳はバッファして“置換”で安定表示
                if (CONFIG?.translate?.enabled && translateTarget) {
                  scheduleTranslate({ id: baseId, appendText: cleanedText + ' ', target: translateTarget });
                }
              } catch (e) {
                console.error('❌ Failed to send message:', e);
              }
            }
          }
        } catch (e) {
          console.error('❌ Whisper error:', e);
        } finally {
          try { if (fs.existsSync(thisWav)) fs.unlinkSync(thisWav); } catch { }
        }
      }, 100);

      if (forced) setTimeout(() => { startSegment(); }, SEG_GAP_MS);
    };

    opusStream.on('error', (e) => console.error('opusStream error:', e));
    startSegment();

    opusStream.once('end', async () => {
      const s = activeSessions.get(userId);
      if (s?.closing) return;
      if (s) s.closing = true;

      console.log(`⏹️ ${userId} presumed end of speech`);
      try { endSegment(false); } catch { }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }

      setTimeout(() => {
        activeSessions.delete(userId);
        baseId = null;
        firstFlushDone = false;
        sentMsgRef = null;
        resetTranslateBuffer(`${userId}-${segStart}`);
      }, 50);
    });
  });
}
