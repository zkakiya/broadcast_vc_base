// src/discord/rms_gate.js
import { Transform } from 'stream';

export class RmsGate extends Transform {
    constructor(opts = {}) {
        super({ readableObjectMode: false, writableObjectMode: false });
        this.sampleRate = opts.sampleRate || 48000;
        this.frameMs = opts.frameMs ?? Number(process.env.VAD_FRAME_MS ?? 20);
        this.frameBytes = (this.sampleRate * this.frameMs / 1000) * 2; // s16le mono
        this.buf = Buffer.alloc(0);

        this.openDb = opts.openDb ?? Number(process.env.VAD_OPEN_DB ?? -38); // 開く
        this.closeDb = opts.closeDb ?? Number(process.env.VAD_CLOSE_DB ?? -45); // 閉じる
        this.hangMs = opts.hangMs ?? Number(process.env.VAD_HANG_MS ?? 400); // 無音継続で閉

        this.state = 'closed';
        this.silMs = 0;
        this.debug = process.env.VAD_DEBUG === '1';
    }

    _transform(chunk, _enc, cb) {
        this.buf = Buffer.concat([this.buf, chunk]);

        while (this.buf.length >= this.frameBytes) {
            const frame = this.buf.subarray(0, this.frameBytes);
            this.buf = this.buf.subarray(this.frameBytes);

            // RMS（16bit）
            let sum = 0, n = frame.length / 2;
            for (let i = 0; i < frame.length; i += 2) {
                const s = frame.readInt16LE(i);
                sum += s * s;
            }
            const rms = Math.sqrt(sum / n) / 32768;
            const db = 20 * Math.log10(rms + 1e-9);

            if (this.state === 'closed') {
                if (db >= this.openDb) {
                    this.state = 'open';
                    this.silMs = 0;
                    if (this.debug) console.log('[gate] OPEN');
                }
            } else {
                if (db < this.closeDb) {
                    this.silMs += this.frameMs;
                    if (this.silMs >= this.hangMs) {
                        this.state = 'closed';
                        this.silMs = 0;
                        this.emit('segmentEnd'); // 区間終端の合図
                        if (this.debug) console.log('[gate] CLOSE -> segmentEnd');
                    }
                } else {
                    this.silMs = 0;
                }
            }

            if (this.state === 'open') this.push(frame);
        }

        cb();
    }
}
