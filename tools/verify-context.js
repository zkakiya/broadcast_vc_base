import fs from 'fs';
import crypto from 'crypto';

const targets = [
    'src/discord/voice_session.js',
    'src/discord/voice.js',
    'src/discord/client.js',
];

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

const result = {};
for (const p of targets) {
    try {
        const txt = fs.readFileSync(p, 'utf8');
        result[p] = { bytes: txt.length, sha256: sha256(txt) };
    } catch (e) {
        result[p] = { error: String(e.message) };
    }
}
console.log(JSON.stringify(result, null, 2));
