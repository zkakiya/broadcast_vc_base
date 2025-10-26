// src/solo/recorder.js
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { transcribeAudioGPU } from '../core/transcribe.js';
import { translateText } from '../utils/translate.js';

let ioRef = null;
export function setIo(io) { ioRef = io; }

const INBOX = process.env.SOLO_INPUT_DIR || path.join(process.cwd(), 'src/solo/inbox');

const SOLO = {
    userId: process.env.SOLO_USER_ID || 'solo',
    name: process.env.SOLO_NAME || 'Speaker',
    avatar: process.env.SOLO_AVATAR || '',
    icon: process.env.SOLO_ICON || '',
    color: process.env.SOLO_COLOR || '#36a2ff',
    side: (process.env.SOLO_SIDE || 'L'),
    translateTo: process.env.SOLO_TRANSLATE_TO || '',
};

function emitTranscript(text) {
    const id = `${SOLO.userId}-${Date.now()}`;
    const payload = {
        id,
        userId: SOLO.userId,
        name: SOLO.name,
        avatar: SOLO.avatar,
        icon: SOLO.icon,
        color: SOLO.color,
        side: SOLO.side,
        text,
        lang: 'ja',
        ts: Date.now(),
    };
    ioRef && ioRef.emit('transcript', payload);

    if (SOLO.translateTo) {
        translateText({ text, target: SOLO.translateTo })
            .then(tr => tr && ioRef.emit('transcript_update', { id, tr: { to: SOLO.translateTo, text: tr } }))
            .catch(() => { });
    }
}

export async function startSoloRecorder() {
    if (!fs.existsSync(INBOX)) fs.mkdirSync(INBOX, { recursive: true });
    console.log('[solo] watching:', INBOX);

    const watcher = chokidar.watch(INBOX, {
        persistent: true,
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });

    watcher.on('add', async (file) => {
        try {
            if (!/\.wav$/i.test(file)) return;
            const st = fs.statSync(file);
            if (st.size < (Number(process.env.MIN_WAV_BYTES || 48000))) {
                try { fs.unlinkSync(file); } catch { }
                return;
            }
            const text = await transcribeAudioGPU(file);
            if (text && text.trim()) emitTranscript(text.trim());
        } catch (e) {
            console.warn('[solo] transcribe error:', e?.message || e);
        } finally {
            try { fs.unlinkSync(file); } catch { }
        }
    });
}
