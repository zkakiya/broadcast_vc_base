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

// === プロセス内・ユーザー毎の同時起動ガード ===
// userId -> { iid: string, started: boolean }
const ACTIVE_SESS = new Map();

// === 発話（セグメント）単位の多重開始ガード ===
// userId -> { baseId: string, startedAt: number }
const ACTIVE_SEG = new Map();

// ★ baseId（＝発話）ごとに Discord メッセ参照を保持
const BASE_MSG_REF = new Map(); // baseId -> Message
// baseId ごとの送信/更新ロック
const BASE_MSG_LOCK = new Map();

// CFG.asr の安全デフォルト
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

        // ★ 発話（baseId）は _startSegment ごとに毎回新規発行する
        this.baseId = null;
        this.firstFlushDone = false;

        this.wavPath = null;
        this.wavWriter = null;
        this.decoder = null;
        this.forceTimer = null;

        this.recentCanon = []; // { canon, ts }
        this.lastText = { text: null, ts: 0 };

        // この発話用のメッセ参照（baseId 決定後に使う）
        this.sentMsgRef = null;

        this.trBuffer = null;
        this.closed = false;
        this._subscribed = false;       // 購読開始済みフラグ
        this._lastDecryptErrAt = 0;     // 復号失敗のレート制限用
        // 表示用の累積
        this.origText = '';
        this.lastTr = '';
        this.speakerName = '';
        // ★ インスタンス識別子（ログ・レース回避用）
        this._iid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        if (process.env.WHISPER_DEBUG === '1') console.log('[vs:ctor]', this.userId, this._iid);
    }

    start() {
        if (process.env.WHISPER_DEBUG === '1') console.log('[vs:ctor]', this.userId, this._iid)
        // === ユーザー単位の同時起動ガード ===
        const act = ACTIVE_SESS.get(this.userId);
        if (act && act.started && act.iid !== this._iid) {
            console.warn(`[voice] duplicate session suppressed user=${this.userId} iid=${this._iid} already=${act.iid}`);
            return; // 先着のみ有効化
        }
        // 自分をアクティブ登録
        ACTIVE_SESS.set(this.userId, { iid: this._iid, started: true });

        // === VoiceConnection が Ready になるのを確認して即購読 ===
        const conn = this.receiver?.voiceConnection;
        const waitReady = () => entersState(conn, VoiceConnectionStatus.Ready, 20_000);
        waitReady().finally(() => this._subscribeAndStart());

        // 再接続（Ready→Connecting→Ready）時は「未購読状態」に戻し、次の _subscribeAndStart で復旧
        conn?.on?.('stateChange', async (_oldS, newS) => {
            if (newS.status !== VoiceConnectionStatus.Ready) {
                this._subscribed = false;
            }
        });
    }

    _subscribeAndStart() {
        if (this._subscribed) {
            if (process.env.WHISPER_DEBUG === '1')
                console.log('[vs:subscribe] already subscribed, skip', this.userId);

            return;
        }
        this._subscribed = true;
        if (process.env.WHISPER_DEBUG === '1')
            console.log('[vs:subscribe] subscribing', this.userId);

        // 既存ストリームがあれば片付け
        try { this.opusStream?.removeAllListeners?.(); } catch { }
        this.opusStream = this.receiver.subscribe(this.userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: VAD_SILENCE_MS },
        });
        this.opusStream.setMaxListeners(0);

        // 復号失敗のレート制限付きハンドラ（多発ログ抑制 & 自動復旧）
        this.opusStream.on('error', async (e) => {
            const msg = String(e?.message || '');
            const now = Date.now();
            const isDecrypt = msg.includes('DecryptionFailed') || msg.includes('UnencryptedWhenPassthroughDisabled');
            if (!isDecrypt || now - this._lastDecryptErrAt > 2000) {
                // 2秒に1回だけ詳細ログ
                console.error('opusStream error:', e);
                this._lastDecryptErrAt = now;
            }
            // Ready を待って再購読（鍵確立や再接続後）
            try {
                const conn = this.receiver?.voiceConnection;
                await entersState(conn, VoiceConnectionStatus.Ready, 10_000);
                this._subscribed = false;
                this._subscribeAndStart();
            } catch (err) {
                // 次の speaking/start で再購読させる
                this._subscribed = false;
            }
        });

        this.opusStream.once('end', () => this._onEndStream());
        this._startSegment();
    }

    _startSegment() {
        // === 発話（baseId）多重開始ガード ===
        const segGuard = ACTIVE_SEG.get(this.userId);
        if (segGuard) {
            console.warn(`[seg] duplicate-start suppressed user=${this.userId} prevBase=${segGuard.baseId}`);
            return; // 未完了の発話がある間は新規 start を拒否（保守的）
        }

        if (process.env.WHISPER_DEBUG === '1') console.log('[seg:start]', { user: this.userId, iid: this._iid, seg: this.segIndex + 1, baseId: this.baseId });
        this.segIndex += 1;
        this.segStart = Date.now();

        // ★★★ ここが最重要：毎セグメントで必ず新しい baseId を発行
        this.baseId = `${this.userId}-${this.segStart}`;
        // 発話アクティブ登録（end で必ず解放する）
        ACTIVE_SEG.set(this.userId, { baseId: this.baseId, startedAt: this.segStart });
        // ★ 発話ローカル状態をクリア（発話ごとに1メッセージにするため）
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

        this.opusStream
            .pipe(this.decoder)
            .on('error', (e) => console.error('decoder error:', e))
            .pipe(this.wavWriter)
            .on('error', (e) => console.error('wavWriter error:', e));

        if (this.forceTimer) clearTimeout(this.forceTimer);
        this.forceTimer = setTimeout(() => this._endSegment(true), UTTER_MAX_MS);
    }

    _endSegment(forced = false) {
        if (process.env.WHISPER_DEBUG === '1') console.log('[seg:end]', { user: this.userId, iid: this._iid, baseId: this.baseId });
        if (!this.wavWriter) return;
        const durMs = Date.now() - this.segStart;
        const tooShort = durMs < MIN_SEG_MS;

        try { this.decoder?.unpipe?.(this.wavWriter); } catch { }
        try { this.wavWriter.end(); } catch { }
        if (this.forceTimer) { clearTimeout(this.forceTimer); this.forceTimer = null; }

        const thisWav = this.wavPath;
        this.wavWriter = null; this.decoder = null; this.wavPath = null;

        console.log(`[seg] end user=${this.userId} baseId=${this.baseId} forced=${forced} dur=${durMs}ms short=${tooShort}`);

        // ★ ここが重要：ASRの前にセグメント重複ガードを解放する（次の発話を塞がない）
        {
            const g = ACTIVE_SEG.get(this.userId);
            if (g && g.baseId === this.baseId) ACTIVE_SEG.delete(this.userId);
        }
        // （誤用防止）この発話の baseId はここで無効化
        const endedBaseId = this.baseId;
        this.baseId = null;


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

                    if (!this.firstFlushDone) {
                        this.firstFlushDone = true;
                        this.speakerName = speakerName;
                        if (this.io) {
                            this.io.emit('transcript', {
                                id: endedBaseId,
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
                    }

                    // Discord メッセ本文は endedBaseId（この発話のID）で固定
                    await this._updateDiscordMessage(cleanedText, endedBaseId);
                    // 訳は確定後に開始・差し替え
                    const trEnabled = (CFG?.translate?.enabled ?? true);
                    if (trEnabled && translateTarget) {
                        // ← この発話の baseId を翻訳バッファに渡す
                        this._ensureTrBuffer(translateTarget, endedBaseId);
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

    async _updateDiscordMessage(delta, idOverride) {
        const id = idOverride ?? this.baseId;
        if (!id) {
            // 万一IDが取れない場合は送信スキップ（ロック汚染防止）
            console.warn('[discord] skip update: no baseId');
            return;
        }

        // baseId 単位で直列化
        while (BASE_MSG_LOCK.get(id)) {
            await new Promise(r => setTimeout(r, 10));
        }
        BASE_MSG_LOCK.set(id, true);

        try {
            const textChannel = await this.client.channels.fetch(CFG.discord.textChannelId);
            if (!textChannel || !textChannel.isTextBased()) return;

            this.sentMsgRef = this.sentMsgRef || BASE_MSG_REF.get(id) || null;

            const d = String(delta || '').trim();
            this.origText = d ? (this.origText ? `${this.origText} ${d}`.trim() : d) : this.origText;

            const base = `**${this.speakerName || 'Speaker'}**: ${this.origText}`;
            const body = this.lastTr ? `${base}\n> _${this.lastTr}_` : base;

            // === Discord は「新規→確定1回のみ」：既に送信済みなら編集しない ===
            // === Discord メッセージ：初回は send、その後は edit で上書き ===
            if (this.sentMsgRef) {
                // 本文 or 訳が変わったときは既存メッセージを編集
                await this.sentMsgRef.edit(body);
            } else {
                this.sentMsgRef = await textChannel.send(body);
                BASE_MSG_REF.set(id, this.sentMsgRef);
                setTimeout(() => {
                    if (BASE_MSG_REF.get(id) === this.sentMsgRef) BASE_MSG_REF.delete(id);
                }, 60_000); // 投稿後1分で参照を開放（任意）
            }

            BASE_MSG_REF.set(id, this.sentMsgRef);
        } catch (e) {
            console.error('❌ Failed to update message:', e);
        } finally {
            BASE_MSG_LOCK.set(id, false);
        }
    }

    _ensureTrBuffer(target, idForEmit) {
        if (this.trBuffer) return;

        // この発話で固定する ID（endedBaseId 優先、なければ現在の baseId）
        const id = idForEmit || this.baseId || null;

        this.trBuffer = new TranslationBuffer({
            id,
            target,
            io: this.io,
            onTranslated: async (tr) => {
                // 最新訳を保持
                this.lastTr = String(tr || '').trim();

                // Discord メッセージを訳付きで更新
                // delta は空文字にして、本文は this.origText / this.lastTr から組み立て
                try {
                    await this._updateDiscordMessage('', id);
                } catch (e) {
                    console.error('❌ Failed to update translated message:', e);
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
        this._subscribed = false; // 次回発話で再購読できるように
    }

    _dispose() {
        try { this.trBuffer?.dispose?.(); } catch { }
        this.trBuffer = null;
        // BASE_MSG_REF は baseId 単位で自然寿命。ここでは触らない。

        // === 自分が現役ならアクティブ登録を解除 ===
        const act = ACTIVE_SESS.get(this.userId);
        if (act && act.iid === this._iid) {
            ACTIVE_SESS.delete(this.userId);
        }
        if (process.env.WHISPER_DEBUG === '1') console.log('[vs:dispose]', this.userId, this._iid);
    }
}
// === 自己診断ガードはクラス定義「後」に置く（初期化前参照を避ける）===
try {
    if (process.env.WHISPER_DEBUG === '1') {
        const must = ['start', '_subscribeAndStart', '_startSegment', '_endSegment', '_updateDiscordMessage'];
        const miss = must.filter((fn) => typeof VoiceSession.prototype[fn] !== 'function');
        if (miss.length) {
            console.error('[guard] voice_session shape mismatch:', miss);
            // throw はしない：開発時の注意喚起に留める
        }
    }
} catch { /* noop: 診断は非致命 */ }
