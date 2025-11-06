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
import { RmsGate } from './rms_gate.js';          // ★ 追加

const VAD_SILENCE_MS = CFG.asr.vadSilenceMs;
const UTTER_MAX_MS = CFG.asr.utterMaxMs;
const SEG_GAP_MS = CFG.asr.segGapMs;

const PHRASE_WINDOW_MS = CFG.asr.phraseWindowMs;
const PHRASE_MAX_KEEP = CFG.asr.phraseMaxKeep;

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
        this.gate = null;                         // ★ 追加：手前VAD

        this.recentCanon = []; // { canon, ts }
        this.lastText = { text: null, ts: 0 };

        this.sentMsgRef = null;
        this.trBuffer = null;
        this.closed = false;
        this._ending = false;                     // ★ 追加：多重_end防止
    }

    start() {
        // Discord 受信ストリーム（AfterSilence は維持）
        this.opusStream = this.receiver.subscribe(this.userId, {
            end: { behavior: 1 /* AfterSilence */, duration: VAD_SILENCE_MS },
        });
        this.opusStream.setMaxListeners(0);

        this.opusStream
            .on('error', (e) => console.error('opusStream error:', e))
            .once('end', () => this._onEndStream());

        this._startSegment();
    }

    _startSegment() {
        this._ending = false;                    // ★ reset
        this.segIndex += 1;
        this.segStart = Date.now();
        this.baseId = this.baseId || `${this.userId}-${this.segStart}`;

        this.wavPath = path.join(this.recordingsDir, `${this.userId}-${this.segStart}-${this.segIndex}.wav`);
        this.decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });
        // ★ ここが重要：必ず mkdir -p してから FileWriter を開く
        try {
            fs.mkdirSync(path.dirname(this.wavPath), { recursive: true });
        } catch { }
        try {
            this.wavWriter = new wav.FileWriter(this.wavPath, { sampleRate: 48000, channels: 1 });
        } catch (e) {
            if (e?.code === 'ENOENT') {
                // 極まれに競合で失敗する場合のワンモアトライ
                try {
                    fs.mkdirSync(path.dirname(this.wavPath), { recursive: true });
                    this.wavWriter = new wav.FileWriter(this.wavPath, { sampleRate: 48000, channels: 1 });
                } catch (e2) {
                    console.error('wavWriter open failed:', e2);
                    // 書けないならこのセグメントはスキップ
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


        // ★ 追加：RMSベースのノイズゲート（手前VAD）
        this.gate = new RmsGate({
            sampleRate: 48000,
            frameMs: Number(process.env.VAD_FRAME_MS ?? 20),
            openDb: Number(process.env.VAD_OPEN_DB ?? -38), // 開く閾値（大きいほど開きにくい）
            closeDb: Number(process.env.VAD_CLOSE_DB ?? -45), // 閉じる閾値（小さいほど閉じやすい）
            hangMs: Number(process.env.VAD_HANG_MS ?? 400), // 無音継続で閉じる時間
        });

        // ★ 手前VADが閉じた＝「一区切り」の合図 → セグメントを強制終了して再開
        this.gate.on('segmentEnd', () => {
            // 既存の AfterSilence が働かない常時入力ケースでも終話できる
            if (!this._ending) {
                this._ending = true;
                // ここで今のセグメントを確実に閉じる
                try { this.decoder?.unpipe?.(this.gate); } catch { }
                try { this.gate?.unpipe?.(this.wavWriter); } catch { }
                try { this.wavWriter?.end(); } catch { }
                // 以降は通常の _endSegment 流れに委ねる
                this._endSegment(true);
            }
        });

        // ★ 配線：Opus→PCM→Gate→WAV
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

    _endSegment(forced = false) {
        if (!this.wavWriter) return;

        // 物理配線は gate.on('segmentEnd') で既に切っている可能性がある
        try { this.decoder?.unpipe?.(this.gate); } catch { }
        try { this.gate?.unpipe?.(this.wavWriter); } catch { }
        try { this.wavWriter.end(); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        const thisWav = this.wavPath;
        this.wavWriter = null; this.decoder = null; this.wavPath = null; this.gate = null;

        console.log(`[seg] end user=${this.userId} forced=${forced}`);

        setTimeout(async () => {
            try {
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

                    // ① 時間窓デュープ
                    const canon = canonicalizeForDup(cleanedText);
                    this.recentCanon = this.recentCanon.filter(x => now - x.ts <= PHRASE_WINDOW_MS);
                    if (this.recentCanon.some(x => x.canon === canon)) return;
                    this.recentCanon.push({ canon, ts: now });
                    if (this.recentCanon.length > PHRASE_MAX_KEEP) this.recentCanon.shift();

                    // ② 直近完全一致デュープ
                    if (this.lastText.text === cleanedText && now - this.lastText.ts < 3000) return;
                    this.lastText = { text: cleanedText, ts: now };

                    // 発話者・UI初回flush
                    const sp = getSpeaker(this.userId);
                    const speakerName = sp?.name || 'Speaker';
                    const speakerSide = sp?.side;
                    const speakerColor = sp?.color;
                    const speakerAvatar = sp?.avatar;
                    const speakerIcon = sp?.icon;
                    const translateTarget = sp?.translateTo || CFG?.translate?.defaultTarget;

                    if (!this.firstFlushDone) {
                        this.firstFlushDone = true;
                        if (this.io) {
                            this.io.emit('transcript', {
                                id: this.baseId,
                                userId: this.userId,
                                name: speakerName,
                                side: speakerSide,
                                color: speakerColor,
                                avatar: speakerAvatar,
                                icon: speakerIcon,
                                text: cleanedText,
                                lang: sp?.lang || 'ja',
                                ts: now,
                            });
                        }
                    } else {
                        if (this.io) {
                            this.io.emit('transcript_update', { id: this.baseId, append: cleanedText });
                        }
                    }

                    // Discord 原文
                    await this._sendDiscordOriginal(speakerName, cleanedText);

                    // 訳：クラス化バッファで “replace” 反映
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

        if (forced) this._scheduleNextSegment();
    }
    _scheduleNextSegment() {
        setTimeout(() => this._startSegment(), SEG_GAP_MS);
    }

    async _sendDiscordOriginal(speakerName, cleanedText) {
        try {
            const textChannel = await this.client.channels.fetch(CFG.discord.textChannelId);
            if (!textChannel || !textChannel.isTextBased()) return;
            if (!this.sentMsgRef) {
                this.sentMsgRef = await textChannel.send(`**${speakerName}**: ${cleanedText}`);
            } else {
                const cur = this.sentMsgRef.content ?? '';
                const next = cur + '\n' + cleanedText;
                try {
                    await this.sentMsgRef.edit(next);
                } catch {
                    this.sentMsgRef = await textChannel.send(cleanedText);
                }
            }
        } catch (e) {
            console.error('❌ Failed to send message:', e);
        }
    }

    _ensureTrBuffer(target) {
        if (this.trBuffer) return;
        this.trBuffer = new TranslationBuffer({
            id: this.baseId,
            target,
            io: this.io,
            onTranslated: async (tr) => {
                if (!this.sentMsgRef) return;
                const cur = this.sentMsgRef.content ?? '';
                const next = `${cur}\n> _${tr}_`;
                try {
                    await this.sentMsgRef.edit(next);
                } catch {
                    try {
                        const ch = await this.client.channels.fetch(CFG.discord.textChannelId);
                        if (ch && ch.isTextBased()) {
                            this.sentMsgRef = await ch.send(`> _${tr}_`);
                        }
                    } catch (e) {
                        console.warn('[voice_session] failed to fallback-send tr:', e?.message || e);
                    }
                }
            }
        });
    }

    _onEndStream() {
        if (this.closed) return;
        this.closed = true;

        try { this._endSegment(false); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        setTimeout(() => { this._dispose(); }, 50);
    }

    _dispose() {
        try { this.trBuffer?.dispose?.(); } catch { }
        this.trBuffer = null;
        this.sentMsgRef = null;
    }
}
