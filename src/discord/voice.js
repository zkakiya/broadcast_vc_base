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
import { io } from '../web/server.js';
import { getSpeaker } from '../registry/speakers.js';

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

    // 無音 300ms で1発話区切り（分割過多を防止）
    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
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
          // Whisperは直列実行で負荷を平準化
          const text = await enqueue(() => transcribeAudioGPU(wavPath));

          if (text && text.length) {
            // 短時間の完全一致は重複として破棄（ソフト・デュープ）
            const prev = lastTexts.get(userId);
            if (prev && prev.text === text && Date.now() - prev.ts < 3000) {
              activeSessions.delete(userId);
              return;
            }
            lastTexts.set(userId, { text, ts: Date.now() });

            const sp = getSpeaker(userId);
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
              // 将来的に翻訳を載せるなら：tr: { to:'en', text:'...' }
            };

            // 1) OBS字幕ページへ
            io.emit('transcript', payload);

            // 2) Discordテキストへ
            try {
              const textChannel = await client.channels.fetch(TEXT_CHANNEL_ID);
              if (textChannel && textChannel.isTextBased()) {
                await textChannel.send(`**${sp.name}**: ${text}`);
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
          fs.unlink(wavPath, (err) => {
            if (err) console.warn('WAV delete failed:', err?.message);
          });
          activeSessions.delete(userId);
        }
      }, 100);
    });
  });
}
