// src/core/schema.js
export function normalizeTranscript(p) {
    return {
        id: String(p.id),
        userId: String(p.userId),
        name: String(p.name || 'Speaker'),
        text: String(p.text || ''),
        lang: p.lang || 'ja',
        side: p.side,
        color: p.color,
        avatar: p.avatar,
        icon: p.icon,
        ts: typeof p.ts === 'number' ? p.ts : Date.now(),
    };
}
