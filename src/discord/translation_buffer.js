// src/discord/translation_buffer.js
import { translateText } from '../utils/translate.js';
import { CFG } from '../config.js';

export class TranslationBuffer {
    /**
     * @param {Object} opts
     * @param {string} opts.id        // エントリID（UI側の一意キー）
     * @param {string} opts.target    // 翻訳ターゲット言語（例: 'en'）
     * @param {SocketIO.Server} opts.io // socket.io の io
     * @param {(trText:string)=>Promise<void>|void} [opts.onTranslated] // Discord追記など
     * @param {number} [opts.throttleMs] // 既定: CFG.translate.throttleMs
     * @param {boolean} [opts.applyDictOnTr] // 訳に辞書適用するか（既定: CFG.flags.dictApplyTr）
     */
    constructor({ id, target, io, onTranslated, throttleMs, applyDictOnTr } = {}) {
        this.id = id;
        this.target = target;
        this.io = io;
        this.onTranslated = onTranslated;
        this.full = '';
        this.timer = null;

        this.throttleMs = typeof throttleMs === 'number' ? throttleMs : CFG.translate.throttleMs;
        this.applyDictOnTr = (applyDictOnTr ?? CFG.flags.dictApplyTr) === true;
    }

    append(text) {
        if (!this.target) return;
        this.full += (text || '');
        this._schedule();
    }

    flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        return this._translateNow();
    }

    dispose() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    _schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this._translateNow().catch(e => {
                console.warn('[TranslationBuffer] translate failed:', e?.message || e);
            });
        }, this.throttleMs);
    }

    async _translateNow() {
        const src = (this.full || '').trim();
        if (!src || !this.target) return;

        let tr = await translateText({ text: src, target: this.target });
        if (!tr) return;

        if (this.applyDictOnTr) {
            try {
                const { applyUserDictionary } = await import('../utils/dictionary.js');
                tr = applyUserDictionary(tr);
            } catch { /* noop */ }
        }

        if (this.io) {
            this.io.emit('transcript_update', {
                id: this.id,
                tr: { to: this.target, text: tr, mode: 'replace' },
            });
        }
        if (typeof this.onTranslated === 'function') {
            try { await this.onTranslated(tr); } catch (e) {
                console.warn('[TranslationBuffer:onTranslated] failed:', e?.message || e);
            }
        }
    }
}
