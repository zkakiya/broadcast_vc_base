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
// index.js で作った io を受け取る style（将来的選択肢）
let ioRef = null;
export function setIo(io) { ioRef = io; }
import { getSpeaker } from '../registry/speakers.js';
import { CONFIG } from '../config.js';
import { translateText } from '../utils/translate.js';

// ── VC接続ハンドル（モジュールスコープ） ────────────────────────
let currentConnection = null;
let isReconnecting = false; // 多重再接続ガード

// ── 低遅延向けパラメータ（ENVで上書き可） ─────────────────────
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 350);   // 終端判定
const UTTER_MAX_MS = Number(process.env.UTTER_MAX_MS || 3000);  // 強制カット(ミリ秒)
const SEG_GAP_MS = Number(process.env.SEG_GAP_MS || 80);    // セグメント切替の休止(安全マージン)

// --- 翻訳ユーティリティ（OpenAI優先 / 最小実装） -----------------
const TRANSLATE_ENABLED = process.env.TRANSLATE_ENABLED === '1';
const TRANSLATE_TARGET_DEFAULT = process.env.TRANSLATE_TARGET_DEFAULT || ''; // 空なら後述の自動判定
const hasOpenAI = !!process.env.OPENAI_API_KEY;

// __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 録音ディレクトリは src/recordings に固定
const recordingsDir = path.join(__dirname, '../recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

// ── 重複発火/多重送信ガード ──────────────────────────────
const activeSessions = new Map();  // userId -> { closing: boolean }
const lastTexts = new Map();       // userId -> { text, ts }

// ── Whisper直列実行（負荷スパイク抑制） ───────────────────
import { createLimiter } from '../utils/limiter.js';
const limitASR = createLimiter(Number(process.env.ASR_CONCURRENCY || 2));
function enqueue(task) { return limitASR(task); } // 全体N並列

// ── 再接続ポリシー（環境変数で上書き可） ─────────────────────────
const VOICE_RETRY_MAX = Number(process.env.VOICE_RETRY_MAX ?? 5);                // 最大試行
const VOICE_RETRY_INITIAL_MS = Number(process.env.VOICE_RETRY_INITIAL_MS ?? 1500); // 初回遅延
const VOICE_RETRY_MAX_MS = Number(process.env.VOICE_RETRY_MAX_MS ?? 30000);        // 遅延上限

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function backoffDelay(attempt, baseMs, maxMs) {
  // 2^n の指数バックオフにフルジッター（0..delay/2）を加算して衝突緩和
  const pure = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(pure / 2)));
  return Math.min(pure + jitter, maxMs);
}

export async function joinAndRecordVC() {
  // v15 以降: clientReady を待つ（保険）
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
        // 互換モード優先度（対応していればこれが選ばれる）
        preferredEncryptionMode: 'aead_xchacha20_poly1305_rtpsize',
      });

      currentConnection = connection; // ここで保持

      // ログとエラーハンドラ
      connection.on('error', (err) => {
        console.error('[voice] connection error:', err?.message || err);
      });
      const VOICE_DEBUG = process.env.VOICE_DEBUG === '1';
      connection.on('stateChange', async (oldS, newS) => {
        if (VOICE_DEBUG) console.log(`[voice] state ${oldS.status} -> ${newS.status}`);

        // 切断 → クイック再接続を試み、失敗時は指数バックオフ付きで再入室
        if (newS.status === VoiceConnectionStatus.Disconnected && !isReconnecting) {
          isReconnecting = true;
          console.warn('[voice] Disconnected — quick reconnect trial');
          try {
            // “現在のコネクション”での素早い復帰（5秒以内）
            await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
            await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
            console.info('[voice] Quick reconnect succeeded');
            isReconnecting = false;
            return;
          } catch {
            console.warn('[voice] Quick reconnect failed — fallback to backoff');
          }

          // いったん破棄してクリーンに再入室（指数バックオフ）
          try { currentConnection?.destroy(); } catch { }
          currentConnection = null;
          let ok = false;
          for (let i = 1; i <= VOICE_RETRY_MAX; i++) {
            try {
              await sleep(backoffDelay(i, VOICE_RETRY_INITIAL_MS, VOICE_RETRY_MAX_MS));
              await joinAndRecordVC(); // 自身を呼び出し直して受信系も再構築
              console.info('[voice] Reconnected via backoff');
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
      // 準備完了を余裕をもって待つ
      await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
      console.log('🎧 Voice connection ready');
      break; // 成功
    } catch (e) {
      console.warn(`[voice] join attempt ${attempt} failed:`, e?.code || e?.message || e);
      try { connection?.destroy(); } catch { }
      if (attempt >= maxAttempts) throw e;
      const wait = backoffDelay(attempt, baseDelay, VOICE_RETRY_MAX_MS);
      await sleep(wait);
      continue; // リトライ
    }
  }
  const receiver = connection.receiver;
  receiver.speaking.setMaxListeners(100);

  receiver.speaking.on('start', (userIdRaw) => {
    const userId = String(userIdRaw);

    // 既に録音中なら重複subscribeを防止
    if (activeSessions.has(userId)) return;
    activeSessions.set(userId, { closing: false, segment: 0, open: true });

    console.log(`🔊 ${userId} started speaking`);

    // VADサイレンス短縮版
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: VAD_SILENCE_MS },
    });
    opusStream.setMaxListeners(0);

    // セグメント状態（同一発話で共通ID/メッセージを使い回す）
    let segIndex = 0;
    let wavPath = null;
    let wavWriter = null;
    let decoder = null;
    let forceTimer = null;
    let segStart = 0;
    let baseId = null;           // ★ 発話ごとの固定ID
    let firstFlushDone = false;  // ★ 最初のセグメントかどうか
    let sentMsgRef = null;       // ★ Discordの Message 参照（編集で追記）

    // セグメント開始
    const startSegment = () => {
      segIndex += 1;
      segStart = Date.now();
      wavPath = path.join(recordingsDir, `${userId}-${segStart}-${segIndex}.wav`);
      decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
      wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });
      // パイプ（新しい writer に差し替え）
      opusStream
        .pipe(decoder)
        .on('error', (e) => console.error('decoder error:', e))
        .pipe(wavWriter)
        .on('error', (e) => console.error('wavWriter error:', e));
      // 強制カットタイマー
      if (forceTimer) clearTimeout(forceTimer);
      forceTimer = setTimeout(() => {
        // 長すぎる発話を分割して早出し
        endSegment(/*force*/ true);
      }, UTTER_MAX_MS);
    };

    // セグメント終了
    const endSegment = (forced = false) => {
      if (!wavWriter) return;
      // 既存パイプを切り離してWAVを閉じる
      try { decoder?.unpipe?.(wavWriter); } catch { }
      try { wavWriter.end(); } catch { }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }

      const thisWav = wavPath; // ローカルに固定
      wavWriter = null; decoder = null; wavPath = null;

      // ファイルフラッシュ待ち→ASR投入
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
          // Whisper直列（キュー）で投入
          const recognizedText = await enqueue(() => transcribeAudioGPU(thisWav));
          if (recognizedText && recognizedText.length) {
            const prev = lastTexts.get(userId);
            if (prev && prev.text === recognizedText && Date.now() - prev.ts < 3000) {
              // デュープ抑止
            } else {
              lastTexts.set(userId, { text: recognizedText, ts: Date.now() });
              // 話者メタ
              const sp = getSpeaker(userId);
              const speakerName = sp?.name || 'Speaker';
              const speakerSide = sp?.side;
              const speakerColor = sp?.color;
              const speakerAvatar = sp?.avatar;
              const speakerIcon = sp?.icon;
              const translateTarget = sp?.translateTo || CONFIG?.translate?.defaultTarget;

              // ★ 同一発話の共通IDを使う（最初だけ transcript、以降は transcript_update）
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
                  text: recognizedText,
                  lang: sp?.lang || 'ja',
                  ts: Date.now(),
                };
                if (ioRef) ioRef.emit('transcript', payload);
              } else {
                // 2個目以降は追記イベント（UI側は id で本文に append して表示を伸ばす）
                if (ioRef) ioRef.emit('transcript_update', { id: baseId, append: recognizedText });
              }

              // Discordへ原文送信/追記 → 後追い翻訳
              try {
                const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
                if (textChannel && textChannel.isTextBased()) {
                  if (!sentMsgRef) {
                    // 最初は新規メッセージ
                    sentMsgRef = await textChannel.send(`**${speakerName}**: ${recognizedText}`);
                  } else {
                    // 2個目以降は編集で追記
                    const cur = sentMsgRef.content ?? '';
                    const next = cur + '\n' + recognizedText;
                    try { await sentMsgRef.edit(next); }
                    catch { /* 失敗時はフォールバックで新規送信 */
                      sentMsgRef = await textChannel.send(recognizedText);
                    }
                  }
                }
                (async () => {
                  try {
                    if (!CONFIG?.translate?.enabled) return;
                    if (!translateTarget) return;
                    const tr = await translateText({ text: recognizedText, target: translateTarget });
                    if (!tr) return;
                    // UI側に訳の追記
                    if (ioRef) ioRef.emit('transcript_update', { id: baseId, tr: { to: translateTarget, text: tr } });
                    // Discord側も訳を追記（> 引用で末尾に）
                    if (sentMsgRef) {
                      const cur = sentMsgRef.content ?? '';
                      const next = `${cur}\n> _${tr}_`;
                      try { await sentMsgRef.edit(next); }
                      catch {
                        const ch = await client.channels.fetch(TEXT_CHANNEL_ID);
                        if (ch && ch.isTextBased()) sentMsgRef = await ch.send(`> _${tr}_`);
                      }
                    }
                  } catch (e) {
                    console.warn('[translate async] failed:', e?.message || e);
                  }
                })();
              } catch (e) {
                console.error('❌ Failed to send message:', e);
              }
            }
          }
        } catch (e) {
          console.error('❌ Whisper error:', e);
        } finally {
          try {
            if (fs.existsSync(thisWav)) fs.unlinkSync(thisWav);
          } catch { }
        }
      }, 100);

      // 次のセグメントへ（強制カット時のみ即座に再開）
      if (forced) {
        setTimeout(() => { startSegment(); }, SEG_GAP_MS);
      }
    };
    opusStream.on('error', (e) => console.error('opusStream error:', e));
    // 最初のセグメントを開始
    startSegment();

    opusStream.once('end', async () => {
      // 二重close防止
      const s = activeSessions.get(userId);
      if (s?.closing) return;
      if (s) s.closing = true;

      console.log(`⏹️ ${userId} presumed end of speech`);
      // 最終セグメントを閉じてASRへ
      try { endSegment(false); } catch { }
      if (forceTimer) { clearTimeout(forceTimer); forceTimer = null; }
      // すべてのセグメント処理は各 endSegment 内で行うので、ここではセッション解放のみ
      setTimeout(() => {
        activeSessions.delete(userId);
        // ★ 発話終了でリセット
        baseId = null;
        firstFlushDone = false;
        sentMsgRef = null;
      }, 50);
    });
  });
}
