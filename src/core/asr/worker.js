// src/core/asr/worker.js
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

export class FWWorker {
    constructor({ python, script, init, autoRestart = true }) {
        this.python = python;
        this.script = script;
        this.proc = null;
        this.pending = new Map();
        this._buffer = '';
        this.initParams = init;
        this.autoRestart = autoRestart;
        this._starting = null;
        this._crashCount = 0;
    }

    async start() {
        if (this.proc) return;
        if (this._starting) return this._starting;
        this._starting = new Promise((resolve, reject) => {
            const args = [this.script];
            const proc = spawn(this.python, args, {
                env: {
                    ...process.env,
                    // 診断用に有効化（必要に応じてOFFに）
                    CT2_VERBOSE: process.env.CT2_VERBOSE || '0',
                    OMP_NUM_THREADS: process.env.OMP_NUM_THREADS || '1',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.proc = proc;

            const onExit = (code, signal) => {
                const msg = `fw_worker exit ${code}/${signal || ''}`.trim();
                if (process.env.FW_WORKER_LOG !== '0') {
                    console.warn('[fw][exit]', msg);
                }
                // ペンディングは全 reject
                for (const [, { reject }] of this.pending) reject(new Error(msg));
                this.pending.clear();
                this.proc = null;

                if (this.autoRestart) {
                    this._crashCount++;
                    const backoff = Math.min(5000, 200 * Math.pow(2, this._crashCount));
                    setTimeout(() => { this._starting = null; }, backoff);
                } else {
                    this._starting = null;
                }
            };

            proc.on('exit', onExit);
            proc.on('error', (e) => {
                if (process.env.FW_WORKER_LOG !== '0') console.error('[fw][proc error]', e?.message || e);
            });
            proc.stderr.on('data', d => {
                if (process.env.FW_WORKER_LOG !== '0') console.error('[fw][stderr]', String(d).trim());
            });
            proc.stdout.on('data', d => this._onData(d));

            // init を送り、起動完了を待つ
            this._call({ cmd: 'init', ...this.initParams })
                .then(() => { this._crashCount = 0; resolve(); })
                .catch((e) => { reject(e); });
        });
        return this._starting;
    }

    _onData(chunk) {
        this._buffer += String(chunk);
        let idx;
        while ((idx = this._buffer.indexOf('\n')) >= 0) {
            const line = this._buffer.slice(0, idx);
            this._buffer = this._buffer.slice(idx + 1);
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                const ent = this.pending.get(msg.id);
                if (ent) {
                    this.pending.delete(msg.id);
                    msg.ok ? ent.resolve(msg) : ent.reject(new Error(msg.error || 'fw error'));
                }
            } catch {
                // 壊れた行は黙って捨てる
            }
        }
    }

    _call(payload) {
        return new Promise((resolve, reject) => {
            const id = payload.id || randomUUID();
            this.pending.set(id, { resolve, reject });
            try {
                this.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
            } catch (e) {
                this.pending.delete(id);
                reject(e);
            }
        });
    }

    async transcribe(wav, { lang } = {}) {
        await this.start().catch((e) => {
            // 起動に失敗 → 以降の呼び出しは上位でフォールバック
            throw e;
        });
        const res = await this._call({ cmd: 'transcribe', wav, lang });
        return res;
    }
}
