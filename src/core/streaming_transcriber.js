// 疑似ストリーミング: 一定間隔でWAV化→既存transcribeを呼ぶ（サイズ判定は "PCM長" で行う）
import fs from 'fs';
import path from 'path';
import wav from 'wav';
import { transcribeAudioGPU } from './transcribe.js';
import { canonicalizeForDup } from '../utils/text_sanitize.js';

const STREAM_DEBUG = process.env.STREAM_DEBUG === '1';

export class StreamingTranscriber {
    /**
     * @param {object} p
     * @param {number} p.flushIntervalMs
     * @param {(t:string)=>void} p.onPartial
     * @param {(t:string)=>void} p.onFinal
     * @param {number} [p.minBytes]       // PCMの最小バイト数（ファイルサイズではない）
     * @param {number} [p.phraseWindowMs]
     * @param {number} [p.phraseMaxKeep]
     * @param {string} [p.outDir]
     */
    constructor({ flushIntervalMs, onPartial, onFinal, minBytes = 16000, phraseWindowMs = 6000, phraseMaxKeep = 12, outDir }) {
        this.flushIntervalMs = flushIntervalMs;
        this.onPartial = onPartial;
        this.onFinal = onFinal;
        this.minBytes = minBytes;
        this.phraseWindowMs = phraseWindowMs;
        this.phraseMaxKeep = phraseMaxKeep;

        this._pcmChunks = []; // Buffer[]
        this._timer = null;
        this._closed = false;
        this._recentCanon = []; // {canon, ts}
        this._lastText = { text: null, ts: 0 };
        this._inflight = Promise.resolve(); // 直列化
        this.outDir = outDir || process.cwd();
        try { fs.mkdirSync(this.outDir, { recursive: true }); } catch { /* noop */ }

        if (STREAM_DEBUG) console.log('[stream] ctor interval=', this.flushIntervalMs, 'minBytes=', this.minBytes);
    }

    start() {
        if (this._timer) return;
        this._timer = setInterval(() => { this._flush(false); }, this.flushIntervalMs);
        if (STREAM_DEBUG) console.log('[stream] start', this.flushIntervalMs, this.minBytes);
    }

    appendPCM(int16buf) {
        if (this._closed) return;
        const buf = Buffer.isBuffer(int16buf)
            ? int16buf
            : Buffer.from(int16buf.buffer, int16buf.byteOffset, int16buf.byteLength);
        this._pcmChunks.push(buf);
    }

    async _flush(final) {
        if (this._closed && !final) return;

        // ここで「PCM合計バイト数」を確定（これで閾値判定する）
        const pcm = Buffer.concat(this._pcmChunks);
        const pcmBytes = pcm.length;
        if (STREAM_DEBUG) console.log('[stream][flush] begin', { final, pcmBytes });

        // 非finalでは短すぎるものを即スキップ（ファイル書かない）
        if (!final && pcmBytes < this.minBytes) {
            if (STREAM_DEBUG) console.log('[stream][flush] skip:short', { pcmBytes, need: this.minBytes });
            return;
        }

        // 次の flush に備えて蓄積をクリア
        this._pcmChunks = [];

        // 直列化して順序を保証
        this._inflight = this._inflight.then(async () => {
            // final でも「短すぎる」ならスキップ（無音終端対策）
            if (final && pcmBytes < this.minBytes) {
                if (STREAM_DEBUG) console.log('[stream][flush] skip:short(final)', { pcmBytes, need: this.minBytes });
                return;
            }
            const tmp = path.join(this.outDir, `strm-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
            try {
                // WAVに包む（finish まで待機）
                await new Promise((res, rej) => {
                    const writer = new wav.FileWriter(tmp, { sampleRate: 48000, channels: 1 });
                    writer.on('finish', res);
                    writer.on('error', rej);
                    writer.end(pcm);
                });

                // ここでファイルサイズは見ない（環境で0になるケースがあったため）
                // 実際の内容量は pcmBytes を根拠にする。
                if (STREAM_DEBUG) {
                    try {
                        const st = fs.statSync(tmp);
                        console.log('[stream][flush] wrote wav', { fileBytes: st.size, pcmBytes });
                    } catch { /* ignore */ }
                }

                // ASR（短すぎるものはここには来ない）
                const text = await transcribeAudioGPU(tmp);
                const t = String(text || '').trim();
                if (!t) {
                    if (STREAM_DEBUG) console.log('[stream][flush] asr: empty');
                    return;
                }

                // デュープ抑止
                const now = Date.now();
                const canon = canonicalizeForDup(t);
                this._recentCanon = this._recentCanon.filter(x => now - x.ts <= this.phraseWindowMs);
                if (!final && this._recentCanon.some(x => x.canon === canon)) {
                    if (STREAM_DEBUG) console.log('[stream][flush] dup-skip', { t: t.slice(0, 40) });
                    return;
                }
                this._recentCanon.push({ canon, ts: now });
                if (this._recentCanon.length > this.phraseMaxKeep) this._recentCanon.shift();

                if (!final && this._lastText.text === t && now - this._lastText.ts < 1200) {
                    if (STREAM_DEBUG) console.log('[stream][flush] dedup-skip same-latest');
                    return;
                }
                this._lastText = { text: t, ts: now };

                if (final) {
                    if (STREAM_DEBUG) console.log('[stream][flush] emit FINAL', t.slice(0, 60));
                    this.onFinal?.(t);
                } else {
                    if (STREAM_DEBUG) console.log('[stream][flush] emit PARTIAL', t.slice(0, 60));
                    this.onPartial?.(t);
                }
            } catch (e) {
                console.error('[stream][flush] error', e?.message || e);
            } finally {
                try { fs.unlinkSync(tmp); } catch { /* noop */ }
            }
        }).catch(() => { /* swallow */ });

        await this._inflight;
    }

    async finalize() {
        if (this._closed) return;
        this._closed = true;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        await this._flush(true);
        if (STREAM_DEBUG) console.log('[stream] finalized');
    }
}
