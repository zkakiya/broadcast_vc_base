// src/discord/voice_session.js
import fs from 'fs';
import path from 'path';
import wav from 'wav';
import prism from 'prism-media';

import { CFG } from '../config.js';
import { transcribeAudioGPU } from '../core/transcribe.js';
import { sanitizeASR, canonicalizeForDup } from '../utils/text_sanitize.js';
import { getPersonProtectSet } from '../utils/dictionary.js';
import { getSpeaker } from '../registry/speakers.js';
import { TranslationBuffer } from './translation_buffer.js';
import { RmsGate } from './rms_gate.js';

// ★ ユーザーごとに Discord の送信メッセージを共有
const USER_MSG_REF = new Map(); // userId -> Message
// userId -> boolean（送信/更新ロック）
const USER_MSG_LOCK = new Map();

// ★ CFG.asr が未設定でも破綻しない安全デフォルト
const VAD_SILENCE_MS = CFG.asr?.vadSilenceMs ?? 600;
const UTTER_MAX_MS = CFG.asr?.utterMaxMs ?? 12000;
const SEG_GAP_MS = CFG.asr?.segGapMs ?? 180;
const PHRASE_WINDOW_MS = CFG.asr?.phraseWindowMs ?? 6000;
const PHRASE_MAX_KEEP = CFG.asr?.phraseMaxKeep ?? 12;
const MIN_SEG_MS = Number(process.env.MIN_SEG_MS ?? 900);
const MIN_WAV_BYTES = Number(process.env.MIN_WAV_BYTES ?? 48000);

export class VoiceSession {
    /**
     * @param {Object} p
     * @param {import('discord.js').Client} p.client
     * @param {import('@discordjs/voice').VoiceReceiver} p.receiver
     * @param {string} p.userId
     * @param {import('socket.io').Server} p.io
     * @param {string} p.recordingsDir
     */
    constructor({ client, receiver, userId, io, recordingsDir }) {
        this.client = client;
        this.receiver = receiver;
        this.userId = String(userId);
        this.io = io;
        this.recordingsDir = recordingsDir;

        try { fs.mkdirSync(this.recordingsDir, { recursive: true }); } catch { }

        // runtime
        this.opusStream = null;
        this.segIndex = 0;
        this.segStart = 0;
        this.baseId = null;
        this.firstFlushDone = false;

        this.wavPath = null;
        this.wavWriter = null;
        this.decoder = null;
        this.forceTimer = null;
        this.gate = null;

        this.recentCanon = []; // { canon, ts }
        this.lastText = { text: null, ts: 0 };

        this.sentMsgRef = USER_MSG_REF.get(this.userId) || null;

        this.trBuffer = null;
        this.closed = false;
        this._ending = false;

        this.origText = '';
        this.lastTr = '';
        this.speakerName = '';
    }

    start() {
        this.opusStream = this.receiver.subscribe(this.userId, {
            end: { behavior: 0 /* EndBehaviorType.Manual */ },
        });
        this.opusStream.setMaxListeners(0);

        this.opusStream
            .on('error', (e) => {
                const msg = String(e?.message || e || '');
                if (msg.includes('UnencryptedWhenPassthroughDisabled')) {
                    console.warn('[voice] received unencrypted packet; soft-recovering current segment');
                    try { this.decoder?.unpipe?.(this.gate); } catch { }
                    try { this.gate?.unpipe?.(this.wavWriter); } catch { }
                    try { this.wavWriter?.end?.(); } catch { }
                    this._endSegment(true);
                    return;
                }
                console.error('opusStream error:', e);
            })
            .once('end', () => this._onEndStream());

        this._startSegment();
    }

    _startSegment() {
        // ★ 追加：終了後は新規セグメントを開始しない（安全ガード）
        if (this.closed) return;

        this._ending = false;
        this.segIndex += 1;
        this.segStart = Date.now();
        this.baseId = this.baseId || `${this.userId}-${this.segStart}`;

        this.wavPath = path.join(this.recordingsDir, `${this.userId}-${this.segStart}-${this.segIndex}.wav`);
        this.decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

        try {
            fs.mkdirSync(path.dirname(this.wavPath), { recursive: true });
        } catch { }
        try {
            this.wavWriter = new wav.FileWriter(this.wavPath, { sampleRate: 48000, channels: 1 });
        } catch (e) {
            if (e?.code === 'ENOENT') {
                try {
                    fs.mkdirSync(path.dirname(this.wavPath), { recursive: true });
                    this.wavWriter = new wav.FileWriter(this.wavPath, { sampleRate: 48000, channels: 1 });
                } catch (e2) {
                    console.error('wavWriter open failed:', e2);
                    this._scheduleNextSegment();
                    return;
                }
            } else {
                console.error('wavWriter open failed:', e);
                this._scheduleNextSegment();
                return;
            }
        }
        console.log(`[seg] start user=${this.userId} seg=${this.segIndex}`);

        // ★ 手前VAD
        this.gate = new RmsGate({
            sampleRate: 48000,
            frameMs: Number(process.env.VAD_FRAME_MS ?? 20),
            openDb: Number(process.env.VAD_OPEN_DB ?? -38),
            closeDb: Number(process.env.VAD_CLOSE_DB ?? -45),
            hangMs: Number(process.env.VAD_HANG_MS ?? 400),
        });

        this.gate.on('segmentEnd', () => {
            if (!this._ending) {
                this._ending = true;
                try { this.decoder?.unpipe?.(this.gate); } catch { }
                try { this.gate?.unpipe?.(this.wavWriter); } catch { }
                try { this.wavWriter?.end(); } catch { }
                this._endSegment(true);
            }
        });

        this.opusStream
            .pipe(this.decoder)
            .on('error', (e) => console.error('decoder error:', e))
            .pipe(this.gate)
            .on('error', (e) => console.error('gate error:', e))
            .pipe(this.wavWriter)
            .on('error', (e) => console.error('wavWriter error:', e));

        if (this.forceTimer) clearTimeout(this.forceTimer);
        this.forceTimer = setTimeout(() => this._endSegment(true), UTTER_MAX_MS);
    }

    _emitTranscriptInitial(payload) {
        if (!this.io) return;
        this.io.emit('transcript', payload);
    }

    _emitTranscriptUpdate(payload) {
        if (!this.io) return;
        this.io.emit('transcript_update', payload);
    }

    _endSegment(forced = false) {
        if (!this.wavWriter) return;
        const durMs = Date.now() - this.segStart;
        const tooShort = durMs < MIN_SEG_MS;

        try { this.decoder?.unpipe?.(this.gate); } catch { }
        try { this.gate?.unpipe?.(this.wavWriter); } catch { }
        try { this.wavWriter.end(); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        const thisWav = this.wavPath;
        this.wavWriter = null; this.decoder = null; this.wavPath = null; this.gate = null;

        console.log(`[seg] end user=${this.userId} forced=${forced} dur=${durMs}ms short=${tooShort}`);

        setTimeout(async () => {
            try {
                if (tooShort) { try { if (fs.existsSync(thisWav)) fs.unlinkSync(thisWav); } catch { }; return; }
                const st = fs.statSync(thisWav);
                if (st.size < MIN_WAV_BYTES) {
                    if (process.env.SHORT_WAV_LOG !== '0') {
                        console.log(`(skip) short wav: ${st.size}B < ${MIN_WAV_BYTES}B`);
                    }
                    try { fs.unlinkSync(thisWav); } catch { }
                    return;
                }

                const recognizedText = await transcribeAudioGPU(thisWav);
                const cleanedText = sanitizeASR(recognizedText, { protect: getPersonProtectSet() });

                if (cleanedText && cleanedText.length) {
                    const now = Date.now();

                    // 発話者・UI初回flush
                    const sp = getSpeaker(this.userId);
                    const speakerName = sp?.name || 'Speaker';
                    const speakerSide = sp?.side;
                    const speakerColor = sp?.color;
                    const speakerAvatar = sp?.avatar;
                    const speakerIcon = sp?.icon;
                    const translateTarget = sp?.translateTo || CFG?.translate?.defaultTarget;
                    const lang = sp?.lang || 'ja';

                    if (!this.firstFlushDone) {
                        this.firstFlushDone = true;
                        this.speakerName = speakerName;

                        // ★ 初回：front へ transcript
                        this._emitTranscriptInitial({
                            id: this.baseId,
                            userId: this.userId,
                            name: speakerName,
                            side: speakerSide,
                            color: speakerColor,
                            avatar: speakerAvatar,
                            icon: speakerIcon,
                            text: cleanedText,
                            lang,
                            ts: now,
                        });
                    } else {
                        // ★ 2文目以降：front へ transcript_update（本文更新）
                        this._emitTranscriptUpdate({
                            id: this.baseId,
                            userId: this.userId,
                            text: cleanedText,
                            ts: now,
                        });
                    }

                    // Discord 側は常に置換更新
                    await this._updateDiscordMessage(cleanedText);

                    // 訳：クラス化バッファで “replace” 反映（front にも update を飛ばす）
                    const trEnabled = (CFG?.translate?.enabled ?? true);
                    if (trEnabled && translateTarget) {
                        this._ensureTrBuffer(translateTarget);
                        this.trBuffer.append(cleanedText + ' ');
                    }
                }
            } catch (e) {
                console.error('❌ Whisper error:', e);
            } finally {
                try { if (fs.existsSync(thisWav)) fs.unlinkSync(thisWav); } catch { }
            }
        }, 100);

        if (forced && !this.closed) this._scheduleNextSegment();
    }

    _scheduleNextSegment() {
        if (this.closed) return;
        setTimeout(() => {
            if (this.closed) return;
            this._startSegment();
        }, SEG_GAP_MS);
    }

    async _updateDiscordMessage(delta) {
        // --- 簡易ロック（userId 単位で直列化） ---
        while (USER_MSG_LOCK.get(this.userId)) {
            await new Promise(r => setTimeout(r, 10));
        }
        USER_MSG_LOCK.set(this.userId, true);

        try {
            const textChannel = await this.client.channels.fetch(CFG.discord.textChannelId);
            if (!textChannel || !textChannel.isTextBased()) return;

            this.sentMsgRef = this.sentMsgRef || USER_MSG_REF.get(this.userId) || null;

            const d = String(delta || '').trim();
            this.origText = d ? (this.origText ? `${this.origText} ${d}`.trim() : d) : this.origText;

            const base = `**${this.speakerName || 'Speaker'}**: ${this.origText}`;
            const body = this.lastTr ? `${base}\n> _${this.lastTr}_` : base;

            if (this.sentMsgRef) {
                try {
                    await this.sentMsgRef.edit(body);
                } catch (e) {
                    this.sentMsgRef = await textChannel.send(body);
                    USER_MSG_REF.set(this.userId, this.sentMsgRef);
                }
            } else {
                this.sentMsgRef = await textChannel.send(body);
                USER_MSG_REF.set(this.userId, this.sentMsgRef);
            }

            USER_MSG_REF.set(this.userId, this.sentMsgRef);
        } catch (e) {
            console.error('❌ Failed to update message:', e);
        } finally {
            USER_MSG_LOCK.set(this.userId, false);
        }
    }

    _ensureTrBuffer(target) {
        if (this.trBuffer) return;
        this.trBuffer = new TranslationBuffer({
            id: this.baseId,
            target,
            io: this.io,
            onTranslated: async (tr) => {
                // ★ 置換（差し替え）：最新訳を保持 → 本文再描画
                this.lastTr = String(tr || '').trim();

                // ★ front にも訳の update を通知
                this._emitTranscriptUpdate({
                    id: this.baseId,
                    userId: this.userId,
                    tr: { text: this.lastTr },
                    ts: Date.now(),
                });

                await this._updateDiscordMessage(''); // delta無しでも再描画（訳だけ差し替え）
            }
        });
    }

    _onEndStream() {
        if (this.closed) return;
        this.closed = true;

        try { this._endSegment(false); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        // ★ ここを追加：このセッションで使ったメッセージ参照を捨てる
        try {
            this.sentMsgRef = null;
            USER_MSG_REF.delete(this.userId);
        } catch { }

        setTimeout(() => { this._dispose(); }, 50);
    }

    _dispose() {
        try { this.trBuffer?.dispose?.(); } catch { }
        this.trBuffer = null;
        // USER_MSG_REF は共有キャッシュとして維持
    }
}
