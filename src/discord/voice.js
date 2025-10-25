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
import { transcribeAudioGPU } from './transcribe.js';
// index.js で作った io を受け取る style（将来的選択肢）
let ioRef = null;
export function setIo(io) { ioRef = io; }
import { getSpeaker } from '../registry/speakers.js';
import { CONFIG } from '../config.js';
import { translateText } from '../utils/translate.js';

// ── VC接続ハンドル（モジュールスコープ） ────────────────────────
let currentConnection = null;
let isReconnecting = false; // 多重再接続ガード

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
let last = Promise.resolve();
function enqueue(task) {
  last = last.then(() => task()).catch(() => { }).finally(() => { });
  return last;
}

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
    activeSessions.set(userId, { closing: false });

    console.log(`🔊 ${userId} started speaking`);

    // 無音しきい値（ms）は環境変数で可変。既定600ms（取りこぼし低減）
    const SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 600);
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: Number(process.env.VAD_SILENCE_MS || 600) },
    });

    opusStream.setMaxListeners(0);

    // 一時WAV
    const wavPath = path.join(recordingsDir, `${userId}-${Date.now()}.wav`);

    // Opus → PCM(48k/mono) → WAV
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
    const wavWriter = new wav.FileWriter(wavPath, { sampleRate: 48000, channels: 1 });

    opusStream
      .on('error', (e) => console.error('opusStream error:', e))
      .pipe(decoder)
      .on('error', (e) => console.error('decoder error:', e))
      .pipe(wavWriter)
      .on('error', (e) => console.error('wavWriter error:', e));

    opusStream.once('end', async () => {
      // 二重close防止
      const s = activeSessions.get(userId);
      if (s?.closing) return;
      if (s) s.closing = true;

      console.log(`⏹️ ${userId} presumed end of speech`);
      try { wavWriter.end(); } catch { }

      // FileWriter flush 待ち（安全策）
      setTimeout(async () => {
        try {
          // ★ ここで即座に開放：次の発話をブロックしない
          activeSessions.delete(userId);

          // 話者情報は最初に取得して以降で使う（TDZ回避）
          const sp = getSpeaker(userId);

          // WAVの最小長をチェック（48kHz/mono なら 1秒 ≒ 96KB + ヘッダ）
          const st = fs.statSync(wavPath);
          const MIN_WAV_BYTES = Number(process.env.MIN_WAV_BYTES ?? 48000); // 目安:0.5秒
          if (st.size < MIN_WAV_BYTES) {
            // 短すぎる断片は静かにスキップ（ログ抑制は環境変数で）
            if (process.env.SHORT_WAV_LOG !== '0') {
              console.log(`(skip) short wav: ${st.size}B < ${MIN_WAV_BYTES}B`);
            }
            // 先に削除して終了
            try { fs.unlinkSync(wavPath); } catch { }
            return; // ★ ここで終わり（throwしない）
          }

          // Whisperは直列実行で負荷を平準化
          const recognizedText = await enqueue(() => transcribeAudioGPU(wavPath));

          if (recognizedText && recognizedText.length) {
            // 短時間の完全一致は重複として破棄（ソフト・デュープ）
            const prev = lastTexts.get(userId);


            if (prev && prev.text === recognizedText && Date.now() - prev.ts < 3000) {
              return;
            }
            lastTexts.set(userId, { text: recognizedText, ts: Date.now() });

            // ここで必要情報を“確定”しておく（IIFE内では sp を使わない）
            const speakerName = sp?.name || 'Speaker';
            const speakerSide = sp?.side;
            const speakerColor = sp?.color;
            const speakerAvatar = sp?.avatar;
            const speakerIcon = sp?.icon;
            const translateTarget = sp?.translateTo || CONFIG?.translate?.defaultTarget;

            const msgId = `${userId}-${Date.now()}`;
            const payload = {
              id: msgId,
              userId,
              name: speakerName,
              side: speakerSide,
              color: speakerColor,
              avatar: speakerAvatar,
              icon: speakerIcon,
              text: recognizedText,
              lang: sp.lang || 'ja',
              ts: Date.now(),
            };
            if (ioRef) ioRef.emit('transcript', payload); // ★ 原文を即時表示

            // 2) Discordテキストへ（まず原文だけ送信、Messageを保持）
            try {
              const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
              if (textChannel && textChannel.isTextBased()) {
                var sentMsg = await textChannel.send(`**${speakerName}**: ${recognizedText}`);
              } else {
                console.warn('Text channel not found or not text-based');
              }
            } catch (e) {
              console.error('❌ Failed to send message:', e);
            }

            // 3) 翻訳は後追い（必要情報はすべて引数で渡す／同じ try 内で起動）
            (async (origText, msgIdLocal, nameLocal, targetLocal, sentMsgLocal) => {
              try {
                if (!CONFIG?.translate?.enabled) return;
                if (!targetLocal) return; // 送信先言語未設定なら何もしない
                const tr = await translateText({ text: origText, target: targetLocal });
                if (!tr) return;
                // 配信画面に追記
                if (ioRef) ioRef.emit('transcript_update', { id: msgIdLocal, tr: { to: targetLocal, text: tr } });
                // Discord: 原文メッセージを編集して訳を追記
                if (sentMsgLocal) {
                  const newContent = `**${nameLocal}**\n${origText}\n> _${tr}_`;
                  try {
                    await sentMsgLocal.edit(newContent);
                  } catch {
                    // 失敗したらフォールバックで追記メッセージ
                    const ch = await client.channels.fetch(TEXT_CHANNEL_ID);
                    if (ch && ch.isTextBased()) await ch.send(`> _${tr}_`);
                  }
                }
              } catch (e) {
                console.warn('[translate async] failed:', e?.message || e);
              }
            })(recognizedText, msgId, speakerName, translateTarget, sentMsg);

          }
        } catch (e) {
          console.error('❌ Whisper error:', e);
        } finally {
          // 一時WAVは必ず削除
          try {
            // すでに削除済みならスキップ（ENOENT抑制）
            if (fs.existsSync(wavPath)) {
              fs.unlink(wavPath, (err) => {
                if (err && err.code !== 'ENOENT') console.warn('WAV delete failed:', err?.message);
              });
            }
          } catch { }
        }
      }, 100);
    });
  });
}
