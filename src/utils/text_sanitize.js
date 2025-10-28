// src/utils/text_sanitize.js
// ASR出力の簡易ノイズ除去＆連続文字の収縮

// “連続同一文字”を何個まで許すか（例: 3 = 「えええ」まではOK）
const KEEP_RUN = Number(process.env.ASR_REPEAT_KEEP_RUN || 3);

// “単一文字の連続だけ”で構成される場合に捨てる閾値（例: 15）
const DROP_PURE_REPEAT = Number(process.env.ASR_DROP_PURE_REPEAT || 15);

// “ユニーク文字”の最小数（単語の多様性がなさすぎる場合に捨てる）
const MIN_UNIQUE = Number(process.env.ASR_MIN_UNIQUE_CHARS || 3);

// “連続収縮”の対象となる文字クラス（かな・カナ・長音・半角カナ等）
const JP_REP_CLASS = /[ぁ-んァ-ンーｧ-ﾝﾞﾟ｡｢｣､･]/;

// 句読点や読点・カンマで“リスト化”されているテキストを正規化
function normalizeCommaList(t) {
    // 区切り: 読点・カンマ・中点・空白
    const parts = t.split(/[、,・\s]+/).filter(Boolean);

    // 連続同一語の収縮（例: ヨネダ, ヨネダ, ヨネダ → ヨネダ×N ではなく1個）
    const deduped = [];
    let last = null, run = 0;
    for (const p of parts) {
        if (p === last) {
            run++;
            if (run <= 1) deduped.push(p); // 2回目以降は弾く（同語連続は1回まで）
        } else {
            last = p; run = 0;
            deduped.push(p);
        }
    }

    // 全体が「同語の羅列」に寄っている場合はさらに圧縮
    // 例: 90%以上が同じ語なら1つに潰す
    if (deduped.length >= 6) {
        const freq = new Map();
        for (const p of deduped) freq.set(p, (freq.get(p) || 0) + 1);
        const maxCount = Math.max(...freq.values());
        if (maxCount / deduped.length >= 0.9) {
            // 最頻語のみ残す
            const top = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
            return top;
        }
    }

    return deduped.join('、');
}

export function sanitizeASR(text, opts = {}) {
    if (!text) return text;
    const protect = new Set(opts.protect || []); // 人名など保護

    // 連続同一文字の圧縮（保護語の内部は触らない）
    // 1) 保護語を一時トークン化
    const tokens = [];
    let tmp = text;
    protect.forEach((w) => {
        if (!w) return;
        const tag = `\u0001P${tokens.length}\u0002`; // 不可視トークン
        tokens.push({ tag, word: w });
        const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu');
        tmp = tmp.replace(re, tag);
    });

    // 2) 一般ノイズの圧縮
    tmp = tmp
        // 同一の仮名や記号の連打を短縮
        .replace(/([ぁ-んァ-ンー…。、！？笑wW])\1{2,}/g, '$1$1')  // 3連続→2つ
        .replace(/\s{2,}/g, ' ')                                   // 空白連打
        .trim();

    // 3) トークンを戻す
    for (const { tag, word } of tokens) {
        const re = new RegExp(tag, 'g');
        tmp = tmp.replace(re, word);
    }
    // カタカナ列の内部スペース・中点を除去
    text = text.replace(/(?<=\p{Script=Katakana})[ \u3000･・]+(?=\p{Script=Katakana})/gu, '');

    return tmp;
}

export function canonicalizeForDup(text) {
    return (text || '')
        .replace(/\s+/g, '')
        .replace(/[、。,．，。]/g, '')
        .toLowerCase();
}

function toKatakana(s) {
    // ひらがな→カタカナ。全角英数はそのまま。長音・中黒・スペースは除去。
    const ZEN_LONG = /[ー−ｰ]/g;
    const ZEN_MID = /[・･]/g;
    let out = '';
    for (const ch of s) {
        const code = ch.codePointAt(0);
        // ひらがな → カタカナ
        if (code >= 0x3041 && code <= 0x3096) {
            out += String.fromCodePoint(code + 0x60);
        } else if (/[ぁ-んァ-ンｧ-ﾝA-Za-z0-9一-龥々]/.test(ch)) {
            out += ch;
        }
    }
    return out.replace(ZEN_LONG, '').replace(ZEN_MID, '').replace(/\s+/g, '');
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[m][n];
}

export function fuzzyPeopleReplace(text, peopleDict, { maxDist = 1, minLen = 2 } = {}) {
    if (!text) return text;
    if (!peopleDict || !peopleDict.length) return text;

    // 置換候補（正→正規化）を用意
    const canonList = [];
    for (const p of peopleDict) {
        const canonical = String(p.name || '').trim();
        if (!canonical) continue;
        const aliases = [canonical, ...(p.aliases || [])].map(s => String(s).trim()).filter(Boolean);
        for (const name of aliases) {
            const kata = toKatakana(name);
            if (kata.length >= minLen) canonList.push({ name, kata });
        }
    }
    if (!canonList.length) return text;

    // 簡易トークン分割（日本語+記号境界をざっくり）
    return text.replace(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Za-z0-9]+/gu, (token) => {
        const tk = toKatakana(token);
        if (tk.length < minLen) return token;

        let best = null;
        for (const c of canonList) {
            const d = levenshtein(tk, c.kata);
            if (d <= maxDist) {
                const sim = 1 - d / Math.max(tk.length, c.kata.length);
                if (!best || sim > best.sim) best = { ...c, d, sim };
            }
        }
        if (best && (best.d <= maxDist || best.sim >= 0.85)) {
            // “最も近い”ものに置換（元の大小や句読点は維持）
            return best.name;
        }
        return token;
    });
}