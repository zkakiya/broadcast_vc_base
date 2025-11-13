// src/discord/voice_session.js
import fs from 'fs';
import path from 'path';
import wav from 'wav';
import prism from 'prism-media';
import { entersState, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';

import { CFG } from '../config.js';
import { transcribeAudioGPU } from '../core/transcribe.js';
import { sanitizeASR, canonicalizeForDup } from '../utils/text_sanitize.js';
import { getPersonProtectSet } from '../utils/dictionary.js';
import { getSpeaker } from '../registry/speakers.js';
import { TranslationBuffer } from './translation_buffer.js';
import { StreamingTranscriber } from '../core/streaming_transcriber.js';
import { PartialStabilizer } from '../core/partial_stabilizer.js';

// ========== 同時起動／多重発話ガード ==========
const ACTIVE_SESS = new Map(); // userId -> { iid, started }
const ACTIVE_SEG = new Map(); // userId -> { baseId, startedAt }

// ========== Discord 投稿を時系列保証（ユーザー別） ==========
const USER_POST_Q = new Map(); // userId -> { list:[{segStart, fn}], running:boolean }
async function enqueueDiscordPost(userId, segStart, fn) {
    let q = USER_POST_Q.get(userId);
    if (!q) { q = { list: [], running: false }; USER_POST_Q.set(userId, q); }
    q.list.push({ segStart, fn });
    q.list.sort((a, b) => a.segStart - b.segStart);
    if (q.running) return;
    q.running = true;
    try {
        while (q.list.length) {
            const job = q.list.shift();
            try { await job.fn(); } catch { /* 続行 */ }
        }
    } finally {
        q.running = false;
    }
}

// ========== Discord メッセ参照とロック ==========
const BASE_MSG_REF = new Map(); // baseId -> Message
const BASE_MSG_LOCK = new Map(); // baseId -> boolean

// ========== パラメータ ==========
const VAD_SILENCE_MS = CFG.asr?.vadSilenceMs ?? 600;
const UTTER_MAX_MS = CFG.asr?.utterMaxMs ?? 12000;
const SEG_GAP_MS = CFG.asr?.segGapMs ?? 180;
const PHRASE_WINDOW_MS = CFG.asr?.phraseWindowMs ?? 6000;
const PHRASE_MAX_KEEP = CFG.asr?.phraseMaxKeep ?? 12;
const MIN_SEG_MS = Number(process.env.MIN_SEG_MS ?? 900);
const MIN_WAV_BYTES = Number(process.env.MIN_WAV_BYTES ?? 48000);

// StreamingTranscriber の負荷設定（必要に応じて .env で変更）
const STREAM_FLUSH_MS = Number(process.env.STREAM_FLUSH_MS ?? 900);
const STREAM_MIN_BYTES = Number(process.env.STREAM_MIN_BYTES ?? 65536);

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

        this.baseId = null;       // 現在の発話ID
        this.emitBaseId = null;   // UI/訳用の固定ID（finalize まで不変）
        this.firstFlushDone = false;

        this.wavPath = null;
        this.wavWriter = null;
        this.decoder = null;
        this.forceTimer = null;

        this.recentCanon = []; // { canon, ts }
        this.lastText = { text: null, ts: 0 };

        this.sentMsgRef = null;
        this.trBuffer = null;

        this.closed = false;
        this._subscribed = false;
        this._lastDecryptErrAt = 0;
        this._streamer = null;

        this.origText = '';
        this.lastTr = '';
        this.speakerName = '';

        this._lastPCMAt = 0;
        this._inactTimer = null;

        this._iid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        if (process.env.WHISPER_DEBUG === '1') console.log('[vs:ctor]', this.userId, this._iid);
    }

    start() {
        // 同一ユーザーの重複セッション抑制
        const act = ACTIVE_SESS.get(this.userId);
        if (act && act.started && act.iid !== this._iid) {
            console.warn(`[voice] duplicate session suppressed user=${this.userId} iid=${this._iid} already=${act.iid}`);
            return;
        }
        ACTIVE_SESS.set(this.userId, { iid: this._iid, started: true });

        const conn = this.receiver?.voiceConnection;
        const waitReady = () => entersState(conn, VoiceConnectionStatus.Ready, 20_000);
        waitReady().finally(() => this._subscribeAndStart());

        conn?.on?.('stateChange', (_oldS, newS) => {
            if (newS.status !== VoiceConnectionStatus.Ready) this._subscribed = false;
        });
    }

    _subscribeAndStart() {
        if (this._subscribed) {
            if (process.env.WHISPER_DEBUG === '1') console.log('[vs:subscribe] already subscribed, skip', this.userId);
            return;
        }
        this._subscribed = true;
        if (process.env.WHISPER_DEBUG === '1') console.log('[vs:subscribe] subscribing', this.userId);

        try { this.opusStream?.removeAllListeners?.(); } catch { }
        this.opusStream = this.receiver.subscribe(this.userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: VAD_SILENCE_MS },
        });
        this.opusStream.setMaxListeners(0);

        // 復号失敗は一定間隔でだけ詳細ログ＆現在セグメント中断→再購読
        this.opusStream.on('error', async (e) => {
            const msg = String(e?.message || '');
            const now = Date.now();
            const isDecrypt = msg.includes('DecryptionFailed') || msg.includes('UnencryptedWhenPassthroughDisabled');
            if (!isDecrypt || now - this._lastDecryptErrAt > 2000) {
                console.error('opusStream error:', e);
                this._lastDecryptErrAt = now;
            }
            try { await this._failCurrentSegment('decrypt'); } catch { }
            try {
                const conn = this.receiver?.voiceConnection;
                await entersState(conn, VoiceConnectionStatus.Ready, 10_000);
                this._subscribed = false;
                this._subscribeAndStart();
            } catch {
                this._subscribed = false;
            }
        });

        this.opusStream.once('end', () => this._onEndStream());
        this._startSegment();
    }

    _startSegment() {
        // 発話多重開始ガード
        const segGuard = ACTIVE_SEG.get(this.userId);
        if (segGuard) {
            console.warn(`[seg] duplicate-start suppressed user=${this.userId} prevBase=${segGuard.baseId}`);
            return;
        }

        this.segIndex += 1;
        this.segStart = Date.now();
        this.baseId = `${this.userId}-${this.segStart}`;
        this.emitBaseId = this.baseId; // ← 重要：finalize まで固定し続ける
        ACTIVE_SEG.set(this.userId, { baseId: this.baseId, startedAt: this.segStart });

        this.firstFlushDone = false;
        this.sentMsgRef = null;
        this.trBuffer = null;
        this.origText = '';
        this.lastTr = '';
        this.speakerName = '';

        this.wavPath = path.join(this.recordingsDir, `${this.userId}-${this.segStart}-${this.segIndex}.wav`);
        this.decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 48000 });

        try {
            fs.mkdirSync(path.dirname(this.wavPath), { recursive: true });
            this.wavWriter = new wav.FileWriter(this.wavPath, { sampleRate: 48000, channels: 1 });
        } catch (e) {
            console.error('wavWriter open failed:', e);
            this._scheduleNextSegment();
            return;
        }

        console.log(`[seg] start user=${this.userId} seg=${this.segIndex} baseId=${this.baseId}`);

        this.decoder.on('data', (pcm) => {
            this._lastPCMAt = Date.now();
            this._streamer?.appendPCM(pcm); // Int16LE
        });

        this.opusStream
            .pipe(this.decoder)
            .on('error', (e) => console.error('decoder error:', e))
            .pipe(this.wavWriter)
            .on('error', (e) => console.error('wavWriter error:', e));

        if (this.forceTimer) clearTimeout(this.forceTimer);
        this.forceTimer = setTimeout(() => this._endSegment(true), UTTER_MAX_MS);

        // 疑似ストリーミング（部分：OBSのみ）
        const streamOutDir = (CFG.stream?.outDir)
            ? path.resolve(CFG.stream.outDir)
            : path.join(this.recordingsDir, '_stream');
        try { fs.mkdirSync(streamOutDir, { recursive: true }); } catch { }

        this._streamer = new StreamingTranscriber({
            flushIntervalMs: STREAM_FLUSH_MS,
            minBytes: STREAM_MIN_BYTES,
            outDir: streamOutDir,
            phraseWindowMs: PHRASE_WINDOW_MS,
            phraseMaxKeep: PHRASE_MAX_KEEP,
            onPartial: (t) => {
                if (!t) return;
                if (!this.firstFlushDone) {
                    const sp = getSpeaker(this.userId);
                    this.speakerName = sp?.name || 'Speaker';
                    this.firstFlushDone = true;
                }
                // UI に逐次上書き
                const bid = this.emitBaseId;
                if (bid) this.io?.emit('transcript_update', { user: this.userId, baseId: bid, text: t });
                this.stabilizer.onPartial(t);
            },
            onFinal: (_t) => { /* Discord は確定のみ。UI final は _endSegment 側でまとめて */ },
        });
        this._streamer.start();

        // 無音ウォッチ（VADの3倍程度）
        this._lastPCMAt = Date.now();
        clearInterval(this._inactTimer);
        const idleLimit = Math.max(3500, VAD_SILENCE_MS * 3);
        this._inactTimer = setInterval(() => {
            const idleMs = Date.now() - (this._lastPCMAt || 0);
            if (idleMs > idleLimit) {
                clearInterval(this._inactTimer);
                this._inactTimer = null;
                this._failCurrentSegment('inactivity').catch(() => { });
            }
        }, 500);
    }

    _endSegment(forced = false) {
        if (!this.wavWriter) {
            // ここまで来て writer がなければ発話ガードだけ外す
            const g = ACTIVE_SEG.get(this.userId);
            if (g && g.baseId === this.baseId) ACTIVE_SEG.delete(this.userId);
            return;
        }
        const segBaseId = this.baseId; // 以後 this.baseId は弄らない
        const segStartMs = this.segStart;

        const durMs = Date.now() - this.segStart;
        const tooShort = durMs < MIN_SEG_MS;

        try { this.decoder?.unpipe?.(this.wavWriter); } catch { }
        try { this.wavWriter.end(); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        const wavPath = this.wavPath;
        this.wavWriter = null; this.decoder = null; this.wavPath = null;

        console.log(`[seg] end user=${this.userId} baseId=${segBaseId} forced=${forced} dur=${durMs}ms short=${tooShort}`);

        // 次の発話を塞がないよう、ここでガード解放
        {
            const g = ACTIVE_SEG.get(this.userId);
            if (g && g.baseId === this.baseId) ACTIVE_SEG.delete(this.userId);
        }

        setTimeout(async () => {
            try {
                if (tooShort) { try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch { }; return; }

                // ストリーマ確定（以後 onPartial は飛ばない）
                try { await this._streamer?.finalize?.(); } catch { }
                this._streamer = null;

                const st = fs.statSync(wavPath);
                if (st.size < MIN_WAV_BYTES) {
                    if (process.env.SHORT_WAV_LOG !== '0') console.log(`(skip) short wav: ${st.size}B < ${MIN_WAV_BYTES}B`);
                    try { fs.unlinkSync(wavPath); } catch { }
                    return;
                }

                // Whisper（確定）
                const recognizedText = await transcribeAudioGPU(wavPath);
                const cleanedText = sanitizeASR(recognizedText, { protect: getPersonProtectSet() });

                if (cleanedText) {
                    const now = Date.now();
                    // デュープ抑止
                    const canon = canonicalizeForDup(cleanedText);
                    this.recentCanon = this.recentCanon.filter(x => now - x.ts <= PHRASE_WINDOW_MS);
                    if (this.recentCanon.some(x => x.canon === canon)) return;
                    this.recentCanon.push({ canon, ts: now });
                    if (this.recentCanon.length > PHRASE_MAX_KEEP) this.recentCanon.shift();

                    if (this.lastText.text === cleanedText && now - this.lastText.ts < 3000) return;
                    this.lastText = { text: cleanedText, ts: now };

                    // 発話者メタ
                    const sp = getSpeaker(this.userId);
                    const speakerName = sp?.name || 'Speaker';
                    const speakerSide = sp?.side;
                    const speakerColor = sp?.color;
                    const speakerAvatar = sp?.avatar;
                    const speakerIcon = sp?.icon;
                    const translateTarget = sp?.translateTo || CFG?.translate?.defaultTarget;

                    // UI: 初回の確定で transcript（新規バブル用）
                    if (!this.firstFlushDone) {
                        this.firstFlushDone = true;
                        this.speakerName = speakerName;
                        this.io?.emit('transcript', {
                            id: segBaseId,
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

                    // UI: 最終確定
                    this.io?.emit('transcript_final', { user: this.userId, baseId: segBaseId, text: cleanedText });
                    try { this.stabilizer.onEnd(); } catch { }

                    // Discord: ユーザー別キューで時系列投稿
                    await enqueueDiscordPost(this.userId, segStartMs, async () => {
                        await this._postDiscordOnce(cleanedText, segBaseId, speakerName);
                    });

                    // 翻訳（UI のみ差し替え。Discord 編集しない）
                    const trEnabled = (CFG?.translate?.enabled ?? true);
                    if (trEnabled && translateTarget) {
                        this._ensureTrBuffer(translateTarget, segBaseId);
                        this.trBuffer.append(cleanedText + ' ');
                    }
                }
            } catch (e) {
                console.error('❌ Whisper error:', e);
            } finally {
                try { await this._streamer?.finalize?.(); } catch { }
                this._streamer = null;
                try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch { }
                // emit 用IDはここでクリア（以降 partial を出さない）
                this.emitBaseId = null;
                // 完全にセグメント終了
                this.baseId = null;
            }
        }, 50);

        if (forced) this._scheduleNextSegment();
    }

    _scheduleNextSegment() {
        setTimeout(() => this._startSegment(), SEG_GAP_MS);
    }

    async _postDiscordOnce(text, baseId, speakerName) {
        if (!baseId) return;

        // baseId 単位で直列ロック
        while (BASE_MSG_LOCK.get(baseId)) {
            await new Promise(r => setTimeout(r, 10));
        }
        BASE_MSG_LOCK.set(baseId, true);

        try {
            const textChannel = await this.client.channels.fetch(CFG.discord.textChannelId);
            if (!textChannel || !textChannel.isTextBased()) return;

            this.sentMsgRef = this.sentMsgRef || BASE_MSG_REF.get(baseId) || null;

            const d = String(text || '').trim();
            this.origText = d ? (this.origText ? `${this.origText} ${d}`.trim() : d) : this.origText;

            const base = `**${speakerName || this.speakerName || 'Speaker'}**: ${this.origText}`;
            const body = this.lastTr ? `${base}\n> _${this.lastTr}_` : base;

            // 「新規1回のみ」— 既に送っていれば編集しない
            if (!this.sentMsgRef) {
                this.sentMsgRef = await textChannel.send(body);
                BASE_MSG_REF.set(baseId, this.sentMsgRef);
                // 任意：少し後に参照を弱める
                setTimeout(() => {
                    if (BASE_MSG_REF.get(baseId) === this.sentMsgRef) BASE_MSG_REF.delete(baseId);
                }, 60_000);
            }
        } catch (e) {
            console.error('❌ Failed to post message:', e);
        } finally {
            BASE_MSG_LOCK.set(baseId, false);
        }
    }

    _ensureTrBuffer(target, idForEmit) {
        if (this.trBuffer) return;
        const id = idForEmit || this.emitBaseId || this.baseId;
        this.trBuffer = new TranslationBuffer({
            id,
            target,
            io: this.io,
            onTranslated: async (tr) => {
                this.lastTr = String(tr || '').trim();
                // Discord 側は編集しない（UI 側に反映されればOK）
            }
        });
    }

    async _failCurrentSegment(reason = 'abort') {
        const baseId = this.baseId;
        if (process.env.WHISPER_DEBUG === '1') console.warn('[seg:abort]', { user: this.userId, baseId, reason });

        try { this.decoder?.unpipe?.(this.wavWriter); } catch { }
        try { this.wavWriter?.end?.(); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }
        if (this._inactTimer) { clearInterval(this._inactTimer); this._inactTimer = null; }
        try { await this._streamer?.finalize?.(); } catch { }
        this._streamer = null;

        const wav = this.wavPath;
        this.decoder = null; this.wavWriter = null; this.wavPath = null;
        try { if (wav && fs.existsSync(wav)) fs.unlinkSync(wav); } catch { }

        const g = ACTIVE_SEG.get(this.userId);
        if (g && g.baseId === baseId) ACTIVE_SEG.delete(this.userId);

        this._scheduleNextSegment();
    }

    _onEndStream() {
        if (this.closed) return;
        this.closed = true;

        try { this._endSegment(false); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }
        if (this._inactTimer) { clearInterval(this._inactTimer); this._inactTimer = null; }

        // 念のため
        const g = ACTIVE_SEG.get(this.userId);
        if (g && g.baseId === this.baseId) ACTIVE_SEG.delete(this.userId);

        setTimeout(() => { this._dispose(); }, 50);
        this._subscribed = false;
    }

    _dispose() {
        try { this.trBuffer?.dispose?.(); } catch { }
        this.trBuffer = null;

        const act = ACTIVE_SESS.get(this.userId);
        if (act && act.iid === this._iid) ACTIVE_SESS.delete(this.userId);

        if (process.env.WHISPER_DEBUG === '1') console.log('[vs:dispose]', this.userId, this._iid);
    }
}

// 形状チェック（開発支援）
try {
    if (process.env.WHISPER_DEBUG === '1') {
        const must = ['start', '_subscribeAndStart', '_startSegment', '_endSegment', '_postDiscordOnce'];
        const miss = must.filter((fn) => typeof VoiceSession.prototype[fn] !== 'function');
        if (miss.length) console.error('[guard] voice_session shape mismatch:', miss);
    }
} catch { }
