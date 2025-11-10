// src/discord/rms_gate.js
import { Transform } from 'stream';

/**
 * しきい値付き RMS ゲート（s16le mono 前提）
 * - frameMs ごとに RMS を計算し dB 化
 * - db >= openDb で OPEN
 * - OPEN 中に db < closeDb が hangMs 以上続くと CLOSE（segmentEnd を emit）
 * - OPEN 中のフレームだけ push（後段へ通過）
 */
export class RmsGate extends Transform {
    constructor(opts = {}) {
        super({ readableObjectMode: false, writableObjectMode: false });

        // 基本設定
        this.sampleRate = opts.sampleRate || 48000;
        this.frameMs = opts.frameMs ?? Number(process.env.VAD_FRAME_MS ?? 20); // 20ms 推奨
        this.frameBytes = Math.round(this.sampleRate * (this.frameMs / 1000) * 2); // s16le(2B) mono

        // しきい値
        this.openDb = opts.openDb ?? Number(process.env.VAD_OPEN_DB ?? -38);
        this.closeDb = opts.closeDb ?? Number(process.env.VAD_CLOSE_DB ?? -45);
        this.hangMs = opts.hangMs ?? Number(process.env.VAD_HANG_MS ?? 400);

        this.debug = !!(opts.debug ?? process.env.ASR_TRACE);

        // 状態
        this.buf = Buffer.alloc(0);
        this.state = 'closed'; // 'open' | 'closed'
        this.silMs = 0;        // OPEN中に closeDb 未満が続いた無音時間
    }

    /**
     * フレームの RMS(dBFS) を返す。s16le mono 前提。
     * 0 の場合は -Infinity を返す。
     */
    _dbFromFrame(frame) {
        // 2byte 単位で int16LE を読む
        const n = Math.floor(frame.length / 2);
        if (n === 0) return -Infinity;

        let sumSq = 0;
        for (let i = 0; i < n; i++) {
            const s = frame.readInt16LE(i * 2);
            sumSq += s * s;
        }
        const meanSq = sumSq / n;
        if (meanSq <= 0) return -Infinity;

        // 16bit フルスケールに対する dBFS
        const rms = Math.sqrt(meanSq);
        const norm = rms / 32768; // 0..1
        if (norm <= 0) return -Infinity;

        const db = 20 * Math.log10(norm);
        return Number.isFinite(db) ? db : -Infinity;
    }

    _transform(chunk, _enc, cb) {
        // バッファに溜め、frameBytes 単位で処理
        if (chunk?.length) this.buf = Buffer.concat([this.buf, chunk]);

        while (this.buf.length >= this.frameBytes) {
            const frame = this.buf.subarray(0, this.frameBytes);
            this.buf = this.buf.subarray(this.frameBytes);

            // ★ db を先に計算してから状態遷移に使う（「db 参照が初期化前」防止）
            const db = this._dbFromFrame(frame);

            // 状態遷移
            if (this.state === 'closed') {
                if (db >= this.openDb) {
                    this.state = 'open';
                    this.silMs = 0;
                    if (this.debug) console.log('[gate] OPEN');
                }
            } else { // open
                if (db < this.closeDb) {
                    this.silMs += this.frameMs;
                    if (this.silMs >= this.hangMs) {
                        this.state = 'closed';
                        this.silMs = 0;
                        // 区間終端通知（後段でセグメントを閉じて ASR に回す）
                        this.emit('segmentEnd');
                        if (this.debug) console.log('[gate] CLOSE -> segmentEnd');
                    }
                } else {
                    // 音が戻ったらカウントリセット
                    this.silMs = 0;
                }
            }

            // OPEN 中だけ下流へ PCM を通す
            if (this.state === 'open') {
                this.push(frame);
            }
        }

        cb();
    }

    _flush(cb) {
        // ストリーム終了時の後処理
        // OPEN のままならここで閉じてもよいが、現在の呼び出し側(voice_session)が管理するため何もしない
        cb();
    }
}

export default RmsGate;
