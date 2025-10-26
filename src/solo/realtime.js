// src/solo/realtime.js
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import wav from 'wav';
import { transcribeAudioGPU } from '../core/transcribe.js';
import { translateText } from '../utils/translate.js';

let ioRef = null;
export function setIo(io) { ioRef = io; }

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const recDir = path.join(__dirname, '../recordings');
if (!fs.existsSync(recDir)) fs.mkdirSync(recDir, { recursive: true });

// ---- ENV ----
const PORT = Number(process.env.SOLO_TCP_PORT || 52000);
const SR = Number(process.env.SOLO_SR || 16000);
const CH = Number(process.env.SOLO_CH || 1);

const VAD_FRAME_MS = Number(process.env.VAD_FRAME_MS || 20);
const VAD_SILENCE_MS = Number(process.env.VAD_SILENCE_MS || 300);
const VAD_RMS_TH = Number(process.env.VAD_RMS_THRESHOLD || 800);

const SEG_MIN_MS = Number(process.env.SEG_MIN_MS || 800);
const SEG_MAX_MS = Number(process.env.SEG_MAX_MS || 2200);

const SOLO = {
    userId: process.env.SOLO_USER_ID || 'solo',
    name: process.env.SOLO_NAME || 'Speaker',
    avatar: process.env.SOLO_AVATAR || '',
    icon: process.env.SOLO_ICON || '',
    color: process.env.SOLO_COLOR || '#36a2ff',
    side: (process.env.SOLO_SIDE || 'L'),
    translateTo: process.env.SOLO_TRANSLATE_TO || '',
};

// ---- ユーティリティ ----
function nowTs() { return Date.now(); }
function samplesFromMs(ms) { return Math.floor(SR * ms / 1000); }
const FRAME_SAMPLES = samplesFromMs(VAD_FRAME_MS);
const SILENCE_FRAMES = Math.ceil(VAD_SILENCE_MS / VAD_FRAME_MS);
const SEG_MIN_SAMPLES = samplesFromMs(SEG_MIN_MS);
const SEG_MAX_SAMPLES = samplesFromMs(SEG_MAX_MS);

// 直列実行（Whisper負荷平準化）
let last = Promise.resolve();
function enqueue(task) {
    last = last.then(() => task()).catch(() => { }).finally(() => { });
    return last;
}

function emitTranscript(text) {
    if (!text || !ioRef) return;
    const id = `${SOLO.userId}-${nowTs()}`;
    const payload = {
        id,
        userId: SOLO.userId,
        name: SOLO.name,
        avatar: SOLO.avatar,
        icon: SOLO.icon,
        color: SOLO.color,
        side: SOLO.side,
        text,
        lang: 'ja',
        ts: nowTs(),
    };
    ioRef.emit('transcript', payload);

    if (SOLO.translateTo) {
        translateText({ text, target: SOLO.translateTo })
            .then(tr => tr && ioRef.emit('transcript_update', { id, tr: { to: SOLO.translateTo, text: tr } }))
            .catch(() => { });
    }
}

// WAV ファイルへ書き出し（s16le Int16Array を受け取る）
async function writeWav(int16, outPath) {
    return new Promise((resolve, reject) => {
        const writer = new wav.FileWriter(outPath, { sampleRate: SR, channels: CH });
        const buf = Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
        writer.write(buf);
        writer.end(() => resolve());
        writer.on('error', reject);
    });
}

// ---- VAD & セグメンテーション付き PCM 集約器 ----
class Segmenter {
    constructor() {
        this.buf = new Int16Array(0); // 累積
        this.tail = new Int16Array(0); // フレームの切れ端
        this.silenceCount = 0;
        this.lastVoiceTs = 0;
        this.lastEmitTs = 0;
    }

    // 生PCMバッファ（Buffer）を Int16 として取り込む
    async push(chunk) {
        // 受け取り: Buffer（s16le） → Int16Array
        const tailBytes = Buffer.from(this.tail.buffer, this.tail.byteOffset, this.tail.byteLength);
        const joined = Buffer.concat([tailBytes, chunk]);

        const samples = new Int16Array(joined.buffer, joined.byteOffset, Math.floor(joined.byteLength / 2));

        // フレームサイズ単位で処理、端数は tail に残す
        const totalFrames = Math.floor(samples.length / FRAME_SAMPLES);
        const usedSamples = totalFrames * FRAME_SAMPLES;
        const remainSamples = samples.length - usedSamples;

        if (totalFrames > 0) {
            const work = samples.subarray(0, usedSamples);
            await this._processFrames(work, totalFrames);
        }

        // 端数（次回へ）
        if (remainSamples > 0) {
            this.tail = samples.subarray(usedSamples); // view（コピー不要）
        } else {
            this.tail = new Int16Array(0);
        }
    }

    async _processFrames(samples, frameCount) {
        for (let i = 0; i < frameCount; i++) {
            const start = i * FRAME_SAMPLES;
            const end = start + FRAME_SAMPLES;
            const frame = samples.subarray(start, end);

            // RMS 計算（簡易）
            let sumSq = 0;
            for (let k = 0; k < frame.length; k++) {
                const v = frame[k];
                sumSq += v * v;
            }
            const rms = Math.sqrt(sumSq / frame.length);

            const isVoice = rms >= VAD_RMS_TH;
            if (isVoice) {
                // 音声中
                this.silenceCount = 0;
                this.lastVoiceTs = nowTs();
            } else {
                // 無音継続
                this.silenceCount++;
            }

            // 常にバッファへ積む
            this.buf = Segmenter._appendInt16(this.buf, frame);

            const segLen = this.buf.length; // サンプル数

            // 長すぎるセグメントを強制的に切る（上限）
            if (segLen >= SEG_MAX_SAMPLES) {
                await this._flushSegment('max');
                continue;
            }

            // 無音が続いたら切る（下限以上のみ）
            if (this.silenceCount >= SILENCE_FRAMES && segLen >= SEG_MIN_SAMPLES) {
                await this._flushSegment('silence');
                continue;
            }
        }
    }

    static _appendInt16(a, bView) {
        const out = new Int16Array(a.length + bView.length);
        out.set(a, 0);
        out.set(bView, a.length);
        return out;
    }

    async _flushSegment(reason) {
        try {
            const seg = this.buf;
            this.buf = new Int16Array(0);
            this.silenceCount = 0;

            // 余計に短すぎる場合は捨てる
            if (seg.length < SEG_MIN_SAMPLES) return;

            const wavPath = path.join(recDir, `solo-${nowTs()}.wav`);
            await writeWav(seg, wavPath);

            // Whisper 直列実行
            await enqueue(async () => {
                const text = await transcribeAudioGPU(wavPath);
                try { fs.unlinkSync(wavPath); } catch { }
                if (text && text.trim()) emitTranscript(text.trim());
            });
        } catch (e) {
            console.warn('[solo/realtime] flush error:', e?.message || e);
        }
    }
}

// ---- TCP サーバ（Windows FFmpeg からの s16le を受信） ----
export async function startSoloRealtime() {
    const server = net.createServer((socket) => {
        console.log('[solo/realtime] client connected:', socket.remoteAddress, socket.remotePort);
        socket.setNoDelay(true);

        const seg = new Segmenter();

        socket.on('data', async (chunk) => {
            // chunk は s16le PCM（Buffer）
            await seg.push(chunk);
        });

        socket.on('end', async () => {
            // 終端時に溜まりがあれば締める
            await seg._flushSegment('end');
            console.log('[solo/realtime] client disconnected');
        });

        socket.on('error', (err) => {
            console.warn('[solo/realtime] socket error:', err?.message || err);
        });
    });

    server.on('error', (err) => {
        console.error('[solo/realtime] server error:', err?.message || err);
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[solo/realtime] listening on tcp://0.0.0.0:${PORT} (sr=${SR}, ch=${CH})`);
    });
}
