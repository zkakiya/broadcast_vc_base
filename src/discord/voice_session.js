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

// ユーザーごとに Discord の送信メッセージを共有
const USER_MSG_REF = new Map(); // userId -> Message
const USER_MSG_LOCK = new Map(); // userId -> boolean

// デフォルト
const VAD_SILENCE_MS = CFG.asr?.vadSilenceMs ?? 600;
const UTTER_MAX_MS = CFG.asr?.utterMaxMs ?? 12000;
const SEG_GAP_MS = CFG.asr?.segGapMs ?? 180;
const PHRASE_WINDOW_MS = CFG.asr?.phraseWindowMs ?? 6000;
const PHRASE_MAX_KEEP = CFG.asr?.phraseMaxKeep ?? 12;
const MIN_SEG_MS = Number(process.env.MIN_SEG_MS ?? 900);
const MIN_WAV_BYTES = Number(process.env.MIN_WAV_BYTES ?? 48000);

const nowTs = () => Date.now();
const msSince = (ts) => (ts ? (Date.now() - ts) : null);

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
        this.decoder = null;
        this.gate = null;
        this.wavWriter = null;

        this.segIndex = 0;
        this.segStart = 0;
        this.baseId = null;
        this.firstFlushDone = false;

        this.wavPath = null;
        this.forceTimer = null;

        this.recentCanon = []; // { canon, ts }
        this.lastText = { text: null, ts: 0 };

        this.sentMsgRef = USER_MSG_REF.get(this.userId) || null;

        this.trBuffer = null;
        this.closed = false;
        this._ending = false;

        this.origText = '';
        this.lastTr = '';
        this.speakerName = '';

        // 観測
        this._segBytes = 0;      // gate→wav に流れたPCM byte数
        this._segFrames = 0;     // 20msフレーム相当数（概算）
        this._firstPcmAt = 0;    // 最初のPCM到着時刻
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
                    // 物理切断
                    this._stopPipes();
                    this._endSegment(true);
                    return;
                }
                console.error('opusStream error:', e);
            })
            .once('end', () => this._onEndStream());

        this._startSegment();
    }

    _startSegment() {
        if (this.closed) return;

        this._ending = false;
        this.segIndex += 1;
        this.segStart = Date.now();
        this.baseId = this.baseId || `${this.userId}-${this.segStart}`;

        // 観測カウンタ初期化
        this._segBytes = 0;
        this._segFrames = 0;
        this._firstPcmAt = 0;

        this.wavPath = path.join(this.recordingsDir, `${this.userId}-${this.segStart}-${this.segIndex}.wav`);
        try { fs.mkdirSync(path.dirname(this.wavPath), { recursive: true }); } catch { }

        try {
            this.wavWriter = new wav.FileWriter(this.wavPath, { sampleRate: 48000, channels: 1 });
        } catch (e) {
            console.error('wavWriter open failed:', e);
            this._scheduleNextSegment();
            return;
        }

        console.log(`[seg] start user=${this.userId} seg=${this.segIndex}`);

        // VAD
        this.gate = new RmsGate({
            sampleRate: 48000,
            frameMs: Number(process.env.VAD_FRAME_MS ?? 20),
            openDb: Number(process.env.VAD_OPEN_DB ?? -38),
            closeDb: Number(process.env.VAD_CLOSE_DB ?? -45),
            hangMs: Number(process.env.VAD_HANG_MS ?? 400),
        });

        // 観測：gateのdataで流量カウント
        this.gate.on('data', (chunk) => {
            if (!chunk?.length) return;
            this._segBytes += chunk.length;
            if (!this._firstPcmAt) this._firstPcmAt = nowTs();
            // 20msフレーム概算: 48kHz * 0.02s * 2byte = 1920B
            this._segFrames = Math.round(this._segBytes / 1920);
        });

        // gate閉: セグメントを終わらせる
        this.gate.on('segmentEnd', () => {
            if (!this._ending) {
                this._ending = true;
                this._stopPipes();
                this._endSegment(true);
            }
        });

        // 配線
        this.decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

        // opusStream → decoder → gate → wavWriter
        this.opusStream
            .pipe(this.decoder)
            .on('error', (e) => console.error('decoder error:', e))
            .pipe(this.gate)
            .on('error', (e) => console.error('gate error:', e))
            .pipe(this.wavWriter)
            .on('error', (e) => console.error('wavWriter error:', e));

        // 強制終了タイマ
        if (this.forceTimer) clearTimeout(this.forceTimer);
        this.forceTimer = setTimeout(() => this._endSegment(true), UTTER_MAX_MS);
    }

    // すべての配線を安全に停止
    _stopPipes() {
        try { this.opusStream?.unpipe?.(this.decoder); } catch { }
        try { this.decoder?.unpipe?.(this.gate); } catch { }
        try { this.gate?.unpipe?.(this.wavWriter); } catch { }

        try { this.wavWriter?.end?.(); } catch { }
        try { this.decoder?.removeAllListeners?.(); } catch { }
        try { this.gate?.removeAllListeners?.(); } catch { }

        // decoder/gate は destroy して内部バッファも破棄
        try { this.decoder?.destroy?.(); } catch { }
        try { this.gate?.destroy?.(); } catch { }

        this.decoder = null;
        this.gate = null;
        this.wavWriter = null;
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
        if (!this.wavWriter && !this.decoder && !this.gate) {
            // 既に止め済み
        } else {
            this._stopPipes();
        }

        const durMs = Date.now() - this.segStart;
        const tooShort = durMs < MIN_SEG_MS;

        const thisWav = this.wavPath;
        const segBytes = this._segBytes;
        const segFrames = this._segFrames;
        const firstPcmDelay = (this._firstPcmAt ? (this._firstPcmAt - this.segStart) : null);

        this.wavPath = null;

        console.log(`[seg] end user=${this.userId} forced=${forced} dur=${durMs}ms short=${tooShort} pcmBytes=${segBytes} estFrames=${segFrames} firstPcmDelayMs=${firstPcmDelay}`);

        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        setTimeout(async () => {
            try {
                if (tooShort) { try { if (thisWav && fs.existsSync(thisWav)) fs.unlinkSync(thisWav); } catch { }; return; }

                const st = thisWav ? fs.statSync(thisWav) : null;
                if (process.env.ASR_TRACE) {
                    if (thisWav && st) console.log('[wav] stat', { path: thisWav, size: st.size });
                }
                if (!st || st.size < MIN_WAV_BYTES) {
                    if (process.env.SHORT_WAV_LOG !== '0') {
                        console.log(`(skip) short wav: ${st ? st.size : 0}B < ${MIN_WAV_BYTES}B`);
                    }
                    try { if (thisWav && fs.existsSync(thisWav)) fs.unlinkSync(thisWav); } catch { }
                    return;
                }

                const recognizedText = await transcribeAudioGPU(thisWav);
                const cleanedText = sanitizeASR(recognizedText, { protect: getPersonProtectSet() });

                if (process.env.ASR_TRACE) {
                    const rawLen = (recognizedText || '').length || 0;
                    const cleanLen = (cleanedText || '').length || 0;
                    console.log('[asr] text', { rawLen, cleanLen, text: cleanLen ? cleanedText : null });
                }

                if (cleanedText && cleanedText.length) {
                    const now = Date.now();

                    // デュープ抑制
                    const canon = canonicalizeForDup(cleanedText);
                    this.recentCanon = this.recentCanon.filter(x => now - x.ts <= PHRASE_WINDOW_MS);
                    if (this.recentCanon.some(x => x.canon === canon)) return;
                    this.recentCanon.push({ canon, ts: now });
                    if (this.recentCanon.length > PHRASE_MAX_KEEP) this.recentCanon.shift();

                    if (this.lastText.text === cleanedText && now - this.lastText.ts < 3000) return;
                    this.lastText = { text: cleanedText, ts: now };

                    // 発話者・初回flush
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
                        if (process.env.ASR_TRACE) {
                            console.log('[emit] transcript', { id: this.baseId, len: cleanedText.length });
                        }
                    } else {
                        this._emitTranscriptUpdate({
                            id: this.baseId,
                            userId: this.userId,
                            text: cleanedText,
                            ts: now,
                        });
                        if (process.env.ASR_TRACE) {
                            console.log('[emit] transcript_update', { id: this.baseId, hasText: true, hasTr: false, textLen: cleanedText.length });
                        }
                    }

                    // Discord 側は置換更新
                    if (process.env.ASR_TRACE) console.log('[discord] update', { appendLen: cleanedText.length });
                    await this._updateDiscordMessage(cleanedText);

                    // 訳
                    const trEnabled = (CFG?.translate?.enabled ?? true);
                    if (trEnabled && translateTarget) {
                        this._ensureTrBuffer(translateTarget);
                        this.trBuffer.append(cleanedText + ' ');
                    }
                } else {
                    if (process.env.ASR_TRACE) console.log('[skip] emptyText');
                }
            } catch (e) {
                console.error('❌ Whisper error:', e);
            } finally {
                try { if (thisWav && fs.existsSync(thisWav)) fs.unlinkSync(thisWav); } catch { }
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
                } catch {
                    this.sentMsgRef = await textChannel.send(body);
                    USER_MSG_REF.set(this.userId, this.sentMsgRef);
                }
            } else {
                this.sentMsgRef = await textChannel.send(body);
                USER_MSG_REF.set(this.userId, this.sentMsgRef);
            }
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
                this.lastTr = String(tr || '').trim();
                this._emitTranscriptUpdate({
                    id: this.baseId,
                    userId: this.userId,
                    tr: { text: this.lastTr },
                    ts: Date.now(),
                });
                if (process.env.ASR_TRACE) console.log('[discord] update:translation');
                await this._updateDiscordMessage('');
            }
        });
    }

    _onEndStream() {
        if (this.closed) return;
        this.closed = true;

        try { this._endSegment(false); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        // このセッションのメッセージ参照は捨てる（次会話で新規に）
        try {
            this.sentMsgRef = null;
            USER_MSG_REF.delete(this.userId);
        } catch { }

        setTimeout(() => { this._dispose(); }, 50);
    }

    _dispose() {
        try { this.trBuffer?.dispose?.(); } catch { }
        this.trBuffer = null;
    }
}
