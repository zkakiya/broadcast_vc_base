// src/utils/dictionary.js
import fs from 'fs';
import path from 'path';

const DICT_PATH = path.resolve(process.cwd(), 'apps/dictionary.json');

/** ---------- small helpers ---------- */
function stripJsonc(x) {
    if (!x) return x;
    // /* ... */ コメント除去
    x = x.replace(/\/\*[\s\S]*?\*\//g, '');
    // // 行コメント除去（ただし "://" のようなURL中は温存したいので雑にコロン直後は除外）
    x = x.replace(/(^|[^:])\/\/.*$/gm, '$1');
    // 末尾カンマ除去
    x = x.replace(/,\s*([}\]])/g, '$1');
    return x.trim();
}
const norm = (s) => String(s || '').trim().toLowerCase();

/** ---------- module-level cache ---------- */
let _cache = {
    mtimeMs: null,          // ファイルの更新時刻
    raw: null,              // パース後のオブジェクト { people, replace }
    peopleSet: null,        // 小文字正規化済み Set
    replaceRules: null,     // コンパイル済み置換ルール [{ re:RegExp, to:string }] or [{ str:string, to:string }]
    hotwordPrompt: null,    // buildPeopleHotwordPrompt のキャッシュ
    logPrintedOnce: false,  // 初回ログの制御
};

function readIfChanged() {
    let stat;
    try { stat = fs.statSync(DICT_PATH); } catch { stat = null; }
    const mtimeMs = stat?.mtimeMs ?? null;

    const changed = (
        !_cache.mtimeMs ||
        _cache.mtimeMs !== mtimeMs ||
        _cache.raw === null
    );

    if (!changed) return false;

    let people = [], replace = [];
    try {
        if (stat && fs.existsSync(DICT_PATH)) {
            const raw = fs.readFileSync(DICT_PATH, 'utf8');
            const txt = stripJsonc(raw);
            const j = JSON.parse(txt);
            people = Array.isArray(j?.people) ? j.people : [];
            replace = Array.isArray(j?.replace) ? j.replace : [];
        }
    } catch (e) {
        if (!process.env.ASR_DICT_QUIET) {
            console.warn('[asr-dict] load failed:', e.message);
        }
        people = []; replace = [];
    }

    // people -> 小文字正規化Set
    const peopleSet = new Set();
    for (const p of people) {
        if (p?.name) peopleSet.add(norm(p.name));
        for (const a of (p?.aliases || [])) peopleSet.add(norm(a));
    }

    // replace -> 事前コンパイル
    // 形式:
    //  - { "from": "re:pattern", "to": "X", "flags": "iu" }
    //  - { "from": "foo", "to": "bar" }  // 素の文字列置換
    const replaceRules = [];
    for (const r of replace) {
        const from = r?.from;
        if (!from) continue;
        const to = (r?.to ?? '');

        if (typeof from === 'string' && from.startsWith('re:')) {
            const patt = from.slice(3);
            const flags = typeof r?.flags === 'string' ? r.flags : 'gu';
            try {
                const re = new RegExp(patt, flags);
                replaceRules.push({ re, to });
            } catch {
                // パターン不正時は素置換にフォールバック
                replaceRules.push({ str: patt, to });
            }
        } else {
            replaceRules.push({ str: String(from), to });
        }
    }

    _cache.mtimeMs = mtimeMs;
    _cache.raw = { people, replace };
    _cache.peopleSet = peopleSet;
    _cache.replaceRules = replaceRules;
    _cache.hotwordPrompt = null; // people が変わったので無効化

    if (!process.env.ASR_DICT_QUIET) {
        // 初回 or 変更時のみログ
        console.log(`[asr-dict] loaded people=${people.length} replace=${replace.length} from ${DICT_PATH}`);
    }
    return true;
}

// オプション：WATCH=1 で監視してホットリロード
if (process.env.ASR_DICT_WATCH === '1') {
    try {
        fs.watch(DICT_PATH, { persistent: false }, () => {
            // 変更の可能性 → 次回アクセス時に readIfChanged が拾う
            _cache.mtimeMs = null;
        });
    } catch { }
}

/** ---------- public API ---------- */

// 旧API互換：生データが欲しいとき
export function loadUserDictionary() {
    readIfChanged();
    return _cache.raw || { people: [], replace: [] };
}

// 文字列置換（辞書反映）
export function applyUserDictionary(text) {
    if (!text) return text;
    readIfChanged();

    const rules = _cache.replaceRules || [];
    let out = text;

    for (const r of rules) {
        try {
            if (r.re) {
                out = out.replace(r.re, r.to);
            } else if (r.str != null) {
                // 全一致置換（split-join は巨大文字列で速い）
                const needle = String(r.str);
                if (needle) out = out.split(needle).join(r.to);
            }
        } catch {
            // 何か起きても落とさない
            continue;
        }
    }
    return out;
}

// initial_prompt 用（人名をプロンプトに並べる）
// repeats は環境変数 ASR_DICT_HOTWORD_REPEATS を既定値に
export function buildPeopleHotwordPrompt({ repeats } = {}) {
    readIfChanged();

    const rep = Number.isFinite(repeats)
        ? Math.max(1, Math.floor(repeats))
        : Math.max(1, Math.floor(Number(process.env.ASR_DICT_HOTWORD_REPEATS ?? 2)));

    if (_cache.hotwordPrompt && _cache.hotwordPrompt.rep === rep) {
        return _cache.hotwordPrompt.text; // キャッシュ
    }

    const names = new Set();
    for (const p of (_cache.raw?.people || [])) {
        const n = String(p?.name || '').trim();
        if (n) names.add(n);
        for (const a of (p?.aliases || [])) {
            const aa = String(a || '').trim();
            if (aa) names.add(aa);
        }
    }
    if (!names.size) {
        _cache.hotwordPrompt = { rep, text: '' };
        return '';
    }
    const base = `固有名詞: ${[...names].join(', ')}`;
    const text = Array.from({ length: rep }, () => base).join('。') + '。';
    _cache.hotwordPrompt = { rep, text };
    return text;
}

// “人名を保護”したい箇所向けのセット（大小区別せず）
// 小文字正規化した token を突っ込んで has() 判定してください。
export function getPersonProtectSet() {
    readIfChanged();
    return _cache.peopleSet || new Set();
}

// おまけ：保護判定ヘルパ（そのまま文字列を投げられる）
export function shouldProtectToken(token) {
    if (!token) return false;
    const set = getPersonProtectSet();
    return set.has(norm(token));
}
