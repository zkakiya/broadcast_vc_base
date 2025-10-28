// src/utils/dictionary.js
import fs from 'fs';
import path from 'path';

const DICT_PATH = path.resolve(process.cwd(), 'apps/dictionary.json');

function stripJsonc(x) {
    if (!x) return x;
    // /* ... */ コメント除去
    x = x.replace(/\/\*[\s\S]*?\*\//g, '');
    // // 行コメント除去
    x = x.replace(/(^|[^:])\/\/.*$/gm, '$1');
    // 末尾カンマ除去
    x = x.replace(/,\s*([}\]])/g, '$1');
    return x.trim();
}

export function loadUserDictionary() {
    try {
        if (!fs.existsSync(DICT_PATH)) return { people: [], replace: [] };
        const raw = fs.readFileSync(DICT_PATH, 'utf8');
        const txt = stripJsonc(raw);
        const j = JSON.parse(txt);
        const people = Array.isArray(j?.people) ? j.people : [];
        const replace = Array.isArray(j?.replace) ? j.replace : [];
        console.log(`[asr-dict] loaded people=${people.length} replace=${replace.length} from ${DICT_PATH}`);
        return { people, replace };
    } catch (e) {
        console.warn('[asr-dict] load failed:', e.message);
        return { people: [], replace: [] };
    }
}

export function applyUserDictionary(text) {
    if (!text) return text;
    const { replace } = loadUserDictionary();
    let out = text;
    for (const r of replace) {
        const from = r?.from;
        const to = r?.to ?? '';
        if (!from) continue;
        try {
            // 正規表現指定（{ "from": "(?i)ｏｂｓ", "to": "OBS" } 等）
            const re = from.startsWith('re:') ? new RegExp(from.slice(3), 'gu') : new RegExp(from, 'gu');
            out = out.replace(re, to);
        } catch {
            // 素の文字列置換（全一致）
            out = out.split(from).join(to);
        }
    }
    return out;
}

// initial_prompt 用（人名をプロンプトに並べる）
export function buildPeopleHotwordPrompt({ repeats = 2 } = {}) {
    const dict = loadUserDictionary();
    const names = new Set();
    for (const p of dict.people || []) {
        const n = String(p?.name || '').trim();
        if (n) names.add(n);
        for (const a of (p?.aliases || [])) {
            const aa = String(a || '').trim();
            if (aa) names.add(aa);
        }
    }
    if (!names.size) return '';
    const base = `固有名詞: ${[...names].join(', ')}`;
    return Array.from({ length: Math.max(1, repeats) }, () => base).join('。') + '。';
}

// “人名を保護”したい箇所向けのセット（大小区別せず）
export function getPersonProtectSet() {
    const dict = loadUserDictionary();
    const set = new Set();
    for (const p of dict.people || []) {
        if (p?.name) set.add(String(p.name));
        for (const a of (p.aliases || [])) set.add(String(a));
    }
    return set;
}
