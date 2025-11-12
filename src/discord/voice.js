// src/discord/voice.js
// VC接続管理：接続/再接続、speaking検出、ユーザーごとのセッション生成を担当
// セッション内部（録音→ASR→翻訳→Discord/OBS出力）は VoiceSession に委譲

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';

import client from './client.js';
import { CFG } from '../config.js';
import { VoiceSession } from './voice_session.js';

let ioRef = null;
export function setIo(io) { ioRef = io; }

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 録音保存先
const recordingsDir = path.join(__dirname, '../recordings');
try { fs.mkdirSync(recordingsDir, { recursive: true }); } catch { /* noop */ }

// VC接続ハンドル
let currentConnection = null;
let isReconnecting = false;

// 再接続ポリシー
const VOICE_RETRY_MAX = Number(process.env.VOICE_RETRY_MAX ?? 5);
const VOICE_RETRY_INITIAL_MS = Number(process.env.VOICE_RETRY_INITIAL_MS ?? 1500);
const VOICE_RETRY_MAX_MS = Number(process.env.VOICE_RETRY_MAX_MS ?? 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function backoffDelay(attempt, baseMs, maxMs) {
  const pure = Math.min(baseMs * Math.pow(2, attempt - 1), maxMs);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(pure / 2)));
  return Math.min(pure + jitter, maxMs);
}

// ユーザー単位のセッション・ガード
const sessions = new Map(); // userId -> VoiceSession

export async function joinAndRecordVC() {
  console.debug('[debug] VOICE_CHANNEL_ID:', CFG.discord.voiceChannelId);

  // Discordクライアント準備
  if (!client.user) {
    await new Promise(res => client.once('clientReady', res));
  }
  const guild = client.guilds.cache.get(CFG.discord.guildId);
  if (!guild) {
    console.error('[error] Guild not found. Check CFG.discord.guildId');
    return;
  }
  const voiceChannel = await guild.channels.fetch(CFG.discord.voiceChannelId);
  if (!voiceChannel) throw new Error('Voice channel not found');

  // 既存接続があれば破棄
  if (currentConnection) {
    try { currentConnection.destroy(); } catch { }
    currentConnection = null;
  }

  // 接続（指数バックオフ）
  let attempt = 0;
  let connection;
  while (attempt < VOICE_RETRY_MAX) {
    attempt++;
    try {
      connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      currentConnection = connection;

      connection.on('error', (err) => {
        console.error('[voice] connection error:', err?.message || err);
      });

      const VOICE_DEBUG = CFG.flags.voiceDebug;
      connection.on('stateChange', async (oldS, newS) => {
        if (VOICE_DEBUG) console.log(`[voice] state ${oldS.status} -> ${newS.status}`);
        if (newS.status === VoiceConnectionStatus.Disconnected && !isReconnecting) {
          isReconnecting = true;
          try {
            await entersState(connection, VoiceConnectionStatus.Signalling, 5_000);
            await entersState(connection, VoiceConnectionStatus.Connecting, 5_000);
            isReconnecting = false;
            return; // 自動復旧できた
          } catch { /* fallthrough */ }

          // 破棄して再接続を試みる
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
      break; // 接続成功
    } catch (e) {
      console.warn(`[voice] join attempt ${attempt} failed:`, e?.code || e?.message || e);
      try { connection?.destroy(); } catch { }
      if (attempt >= VOICE_RETRY_MAX) throw e;
      const wait = backoffDelay(attempt, VOICE_RETRY_INITIAL_MS, VOICE_RETRY_MAX_MS);
      await sleep(wait);
    }
  }

  const receiver = currentConnection.receiver;
  receiver.speaking.setMaxListeners(100);

  // speaking開始：ユーザー単位でセッション生成（多重生成ガード）
  receiver.speaking.on('start', (userIdRaw) => {
    const userId = String(userIdRaw);
    if (sessions.has(userId)) return; // 既存セッション稼働中

    try {
      const session = new VoiceSession({
        client,
        receiver,
        userId,
        io: ioRef,
        recordingsDir,
      });
      sessions.set(userId, session);
      session.start();
      console.log(`🔊 ${userId} started speaking`);
    } catch (e) {
      console.error('[voice] session start failed:', e?.message || e);
    }
  });

  // speaking終了：確実にガード解除
  receiver.speaking.on('end', (userIdRaw) => {
    const userId = String(userIdRaw);
    if (sessions.has(userId)) {
      sessions.delete(userId);
      console.log(`⏹️ ${userId} end of speech (session cleared)`);
    } else {
      console.log(`⏹️ ${userId} end (no active session, ignored)`);
    }
    // listener leak防止
    if (receiver.speaking.listenerCount('start') > 50) {
      console.warn('[voice] speaking listener count high, resetting');
      receiver.speaking.removeAllListeners('start');
      receiver.speaking.removeAllListeners('end');
    }
  });
}
