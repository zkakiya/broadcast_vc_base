// src/utils/dictionary.js
import fs from 'fs';
import path from 'path';

let cached = null;

function stripCommentsAndTrailingCommas(src) {
    // remove /* ... */ comments
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    // remove // ... comments (till end of line)
    src = src.replace(/(^|[^:])\/\/.*$/gm, '$1');
    // remove trailing commas in objects and arrays
    src = src
        .replace(/,\s*([}\]])/g, '$1') // , } or , ]
        .replace(/,\s*(\n|\r)\s*([}\]])/g, '$1$2'); // multiline safety
    return src;
}

function parseJSONC(str) {
    const cleaned = stripCommentsAndTrailingCommas(str);
    return JSON.parse(cleaned);
}

// 置換（単純 or 正規表現）を配列に正規化
function normalize(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) &&
        (Array.isArray(raw.people) || Array.isArray(raw.replace))) {
        return {
            people: Array.isArray(raw.people) ? raw.people : [],
            replace: (Array.isArray(raw.replace) ? raw.replace : []).map(r => ({
                regex: !!r.regex,
                from: typeof r.from === 'string' ? r.from : String(r.from ?? ''),
                flags: typeof r.flags === 'string' ? r.flags : 'gu',
                to: typeof r.to === 'string' ? r.to : String(r.replace ?? ''),
            })).filter(r => r.regex ? r.from.trim() !== '' : r.from !== ''), // ★ 空パターン除外
        };
    }

    const people = [];
    const replace = [];
    for (const item of Array.isArray(raw) ? raw : []) {
        if (item && (item.name || item.aliases)) {
            people.push({
                name: String(item.name || '').trim(),
                aliases: Array.isArray(item.aliases) ? item.aliases.map(a => String(a)) : [],
            });
            continue;
        }
        if (item && typeof item === 'object') {
            if (item.regex) {
                const from = String(item.regex || '').trim();
                if (from !== '') {
                    replace.push({
                        regex: true,
                        from,
                        flags: String(item.flags || 'gu'),
                        to: typeof item.to === 'string' ? item.to : String(item.replace ?? ''),
                    });
                }
                continue;
            }
            if (Array.isArray(item.match)) {
                const to = typeof item.to === 'string' ? item.to : String(item.replace ?? '');
                for (const m of item.match) {
                    const from = String(m ?? '');
                    if (from !== '') replace.push({ from, to });
                }
                continue;
            }
            const from = String(item.from ?? '');
            const to = typeof item.to === 'string' ? item.to : String(item.replace ?? '');
            if (from !== '') replace.push({ from, to });
        }
    }
    return { people, replace };
}

export function loadUserDictionary() {
    if (cached) return cached;
    const p = path.resolve('apps/dictionary.json');
    try {
        const rawText = fs.readFileSync(p, 'utf8');
        const raw = parseJSONC(rawText);
        cached = normalize(raw);
        console.log(`[asr-dict] loaded people=${cached.people.length} replace=${cached.replace.length} from ${p}`);
    } catch (e) {
        console.warn('[asr-dict] load failed:', e?.message || e);
        cached = { people: [], replace: [] };
    }
    return cached;
}

export function getPersonHotwords() {
    const d = loadUserDictionary();
    const words = new Set();
    for (const p of d.people) {
        if (p.name) words.add(String(p.name));
        for (const a of (p.aliases || [])) words.add(String(a));
    }
    return Array.from(words);
}

export function getPersonProtectSet() {
    const d = loadUserDictionary();
    const set = new Set();
    for (const p of d.people) {
        if (p.name) set.add(String(p.name));
        for (const a of (p.aliases || [])) set.add(String(a));
    }
    return set;
}

export function applyUserDictionary(text) {
    const d = loadUserDictionary();
    if (!text) return text;

    // 単語置換（正規表現 / リテラル）
    for (const r of d.replace) {
        try {
            if (r.regex) {
                const pat = String(r.from || '').trim();
                if (!pat) continue;                 // ★ 空は無視
                const re = new RegExp(pat, r.flags || 'gu');
                const to = typeof r.to === 'string' ? r.to : String(r.to ?? '');
                text = text.replace(re, to);
            } else {
                const from = String(r.from ?? '');
                if (from === '') continue;          // ★ 空は無視（split('')事故防止）
                const to = typeof r.to === 'string' ? r.to : String(r.to ?? '');
                // 速い全置換
                if (text.includes(from)) text = text.split(from).join(to);
            }
        } catch {
            /* 無効ルールは黙ってスキップ */
        }
    }

    // people: エイリアス → 正規表記
    for (const p of d.people) {
        const canon = String(p.name || '').trim();
        if (!canon) continue;
        for (const a of (p.aliases || [])) {
            const alias = String(a || '');
            if (!alias) continue;
            try {
                const re = new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
                text = text.replace(re, canon);
            } catch { }
        }
    }

    return text;
}
