// 疑似ストリーミング: 一定間隔でWAV化→既存transcribeを呼ぶ
import fs from 'fs';
import path from 'path';
import { transcribeAudioGPU } from './transcribe.js';
import { canonicalizeForDup } from '../utils/text_sanitize.js';

function pcm16ToWavBuffer(pcmBuf, sampleRate = 48000, channels = 1) {
    const byteRate = sampleRate * channels * 2; // 16bit
    const blockAlign = channels * 2;
    const dataSize = pcmBuf.length;
    const riffSize = 36 + dataSize;

    const h = Buffer.alloc(44);
    h.write('RIFF', 0);                 // ChunkID
    h.writeUInt32LE(riffSize, 4);       // ChunkSize
    h.write('WAVE', 8);                 // Format
    h.write('fmt ', 12);                // Subchunk1ID
    h.writeUInt32LE(16, 16);            // Subchunk1Size (PCM)
    h.writeUInt16LE(1, 20);             // AudioFormat (PCM=1)
    h.writeUInt16LE(channels, 22);      // NumChannels
    h.writeUInt32LE(sampleRate, 24);    // SampleRate
    h.writeUInt32LE(byteRate, 28);      // ByteRate
    h.writeUInt16LE(blockAlign, 32);    // BlockAlign
    h.writeUInt16LE(16, 34);            // BitsPerSample
    h.write('data', 36);                // Subchunk2ID
    h.writeUInt32LE(dataSize, 40);      // Subchunk2Size

    return Buffer.concat([h, pcmBuf]);
}

export class StreamingTranscriber {
    /**
     * @param {object} p
     * @param {number} p.flushIntervalMs  // 例: 1200
     * @param {(t:string)=>void} p.onPartial
     * @param {(t:string)=>void} p.onFinal
     * @param {number} [p.minBytes]       // 例: 48000
     * @param {number} [p.phraseWindowMs] // デュープ窓、例: 6000
     * @param {number} [p.phraseMaxKeep]  // 例: 12
     * @param {string} [p.outDir]  // 一時WAVの出力先（必ず存在するディレクトリを渡す）
     */
    constructor({ flushIntervalMs, onPartial, onFinal, minBytes = 16000, phraseWindowMs = 6000, phraseMaxKeep = 12, outDir }) {
        this.flushIntervalMs = flushIntervalMs;
        this.onPartial = onPartial;
        this.onFinal = onFinal;
        // 一旦しきい値を少し緩める（短文で発火させるため）
        this.minBytes = Math.max(8000, Number(minBytes) || 16000);
        this.phraseWindowMs = phraseWindowMs;
        this.phraseMaxKeep = phraseMaxKeep;

        this._pcmChunks = []; // Buffer[]
        this._timer = null;
        if (process.env.WHISPER_DEBUG === '1') {
            console.log('[stream] start interval=', this.flushIntervalMs, 'minBytes=', this.minBytes);
        }
        this._closed = false;
        this._recentCanon = []; // {canon, ts}
        this._lastText = { text: null, ts: 0 };
        this._inflight = Promise.resolve(); // 直列実行
        this.outDir = outDir || process.cwd(); // フォールバック
        try { fs.mkdirSync(this.outDir, { recursive: true }); } catch { }

    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => { this._flush(false); }, this.flushIntervalMs);
        if (process.env.WHISPER_DEBUG === '1') console.log('[stream] start', this.flushIntervalMs, this.minBytes);

        if (process.env.WHISPER_DEBUG === '1') {
            console.log('[stream] start interval=', this.flushIntervalMs, 'minBytes=', this.minBytes);
        }
    }

    appendPCM(int16buf) {
        if (this._closed) return;
        // Int16Array or Buffer → Buffer
        const buf = Buffer.isBuffer(int16buf) ? int16buf : Buffer.from(int16buf.buffer, int16buf.byteOffset, int16buf.byteLength);
        this._pcmChunks.push(buf);
    }

    async _flush(final) {
        if (this._closed && !final) return;
        const pcm = Buffer.concat(this._pcmChunks);
        if (!final) {
            // 小さすぎるならスキップ
            if (pcm.length < this.minBytes) return;
        }
        this._pcmChunks = [];

        // 直列で処理（最新を上書きできれば十分）
        this._inflight = this._inflight.then(async () => {
            const dbg = (msg, extra) => {
                if (process.env.STREAM_DEBUG === '1' || process.env.WHISPER_DEBUG === '1') {
                    console.log('[stream][flush]', msg, extra || '');
                }
            };
            dbg('begin', { final, pcmBytes: pcm.length });
            const tmp = path.join(this.outDir, `strm-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
            try {
                // 16-bit mono 48k WAV を自前で生成して一括書き込み
                const wavBuf = pcm16ToWavBuffer(pcm, 48000, 1);
                fs.writeFileSync(tmp, wavBuf);

                // ファイルサイズではなく、元PCM長でしきい値を判定（FS差異回避）
                if (pcm.length < this.minBytes) { dbg('skip:short', { pcmBytes: pcm.length, need: this.minBytes }); return; }
                if (process.env.WHISPER_DEBUG === '1') {
                    console.log('[stream] wav bytes:', st.size);
                }

                const text = await transcribeAudioGPU(tmp).catch(err => {
                    dbg('asr:error', String(err && err.message || err));
                    return '';
                });
                const t = String(text || '').trim();
                if (!t) { dbg('empty-asr'); return; }
                dbg('text', { len: t.length, sample: t.slice(0, 40) });

                // デュープ抑止
                const now = Date.now();
                const canon = canonicalizeForDup(t);
                this._recentCanon = this._recentCanon.filter(x => now - x.ts <= this.phraseWindowMs);
                if (!final && this._recentCanon.some(x => x.canon === canon)) return;
                this._recentCanon.push({ canon, ts: now });
                if (this._recentCanon.length > this.phraseMaxKeep) this._recentCanon.shift();

                if (!final && this._lastText.text === t && now - this._lastText.ts < 1200) return;
                this._lastText = { text: t, ts: now };

                if (final) this.onFinal?.(t);
                else this.onPartial?.(t);
            } finally {
                try { fs.unlinkSync(tmp); } catch { }
            }
        }).catch(() => { });
        await this._inflight;
    }

    async finalize() {
        if (this._closed) return;
        this._closed = true;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        // 最後に残りを1度だけ確定
        await this._flush(true);
    }
}
