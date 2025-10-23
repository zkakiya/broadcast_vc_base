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

// --- 翻訳ユーティリティ（OpenAI優先 / 最小実装） -----------------
const TRANSLATE_ENABLED = process.env.TRANSLATE_ENABLED === '1';
const TRANSLATE_TARGET_DEFAULT = process.env.TRANSLATE_TARGET_DEFAULT || ''; // 空なら後述の自動判定
const hasOpenAI = !!process.env.OPENAI_API_KEY;

async function translateTextMinimal({ text, source, target }) {
  if (!TRANSLATE_ENABLED) return null;
  if (!text || !target || (source && source.toLowerCase() === target.toLowerCase())) return null;
  if (!hasOpenAI) return null; // ※必要なら DeepL/Libre を足せます
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `You are a translator. Translate from ${source || 'auto'} to ${target}. Output only the translation.` },
          { role: 'user', content: text }
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.warn('[translate] failed:', e?.message || e);
    return null;
  }
}

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
  last = last.then(() => task()).catch(() => {}).finally(() => {});
  return last;
}

export async function joinAndRecordVC() {
  const guild = await client.guilds.fetch(GUILD_ID);
  if (!guild) throw new Error('Guild not found');

  const voiceChannel = await guild.channels.fetch(VOICE_CHANNEL_ID);
  if (!voiceChannel) throw new Error('Voice channel not found');

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  console.log('🎧 Voice connection ready');

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
       end: { behavior: EndBehaviorType.AfterSilence, duration: Number(process.env.VAD_SILENCE_MS||600) },
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
      try { wavWriter.end(); } catch {}

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
          let alreadyDeleted = false;
          if (st.size < MIN_WAV_BYTES) {
            // 短すぎる断片は静かにスキップ（ログ抑制は環境変数で）
            if (process.env.SHORT_WAV_LOG !== '0') {
              console.log(`(skip) short wav: ${st.size}B < ${MIN_WAV_BYTES}B`);
            }
            // 削除は finally に任せず、ここで行う → 二重削除防止のフラグを立てる
            try { fs.unlinkSync(wavPath); alreadyDeleted = true; } catch {}
            return; // ★ ここで終わり（throwしない）
          }

          // Whisperは直列実行で負荷を平準化
          const text = await enqueue(() => transcribeAudioGPU(wavPath));

          if (text && text.length) {
            // 短時間の完全一致は重複として破棄（ソフト・デュープ）
            const prev = lastTexts.get(userId);

            // 翻訳先ターゲット：明示（env）> 自動（話者langがjaならen、そうでなければja）
            const targetLang =
              TRANSLATE_TARGET_DEFAULT ||
              ((sp.lang || 'ja').toLowerCase() === 'ja' ? 'en' : 'ja');
            const trText = await translateTextMinimal({
              text,
              source: sp.lang || undefined,
              target: targetLang,
            });

            if (prev && prev.text === text && Date.now() - prev.ts < 3000) {
              return;
            }
            lastTexts.set(userId, { text, ts: Date.now() });

            const payload = {
              id: `${userId}-${Date.now()}`,
              userId,
              name: sp.name,
              side: sp.side,
              color: sp.color,
              avatar: sp.avatar,
              icon: sp.icon, 
              text,
              lang: sp.lang || 'ja',
              ts: Date.now(),
              // 翻訳（あれば）
              ...(trText ? { tr: { lang: targetLang, text: trText } } : {}),
            };

            // 1) OBS字幕ページへ
            if (ioRef) {
              ioRef.emit('transcript', payload);
            } else {
              console.warn('[socket] ioRef is not set; skipped emit');
            }
            // 2) Discordテキストへ
            try {
              const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
              if (textChannel && textChannel.isTextBased()) {
                if (trText) {
                  await textChannel.send(`**${sp.name}**\n${text}\n> _${trText}_`);
                } else {
                  await textChannel.send(`**${sp.name}**: ${text}`);
                }
               } else {
                console.warn('Text channel not found or not text-based');
              }
            } catch (e) {
              console.error('❌ Failed to send message:', e);
            }
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
          } catch {}
        }
      }, 100);
    });
  });
}
