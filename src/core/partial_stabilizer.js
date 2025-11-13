// 連続する partial を「文の現在形」に統合して、OBS側は常にまとまった一塊で更新できるようにする
export class PartialStabilizer {
    constructor({ emitUpdate, emitFinal, throttleMs = 250 }) {
        this.buf = '';           // 画面に出す「現在の文」
        this.lastEmit = 0;
        this.emitUpdate = emitUpdate; // (text: string) => void
        this.emitFinal = emitFinal;   // (text: string) => void
        this.throttleMs = throttleMs;
        this._timer = null;
    }

    // 部分結果を受け取り、bufにマージしてからthrottle付きで更新通知
    onPartial(t) {
        const s = (t || '').trim();
        if (!s) return;

        // 典型パターン: 新しいpartialは「前回partialの先頭一致 + 末尾が少し伸びる」
        // そうでなければ差分を単純連結（グリーディ）
        if (s.startsWith(this.buf)) {
            this.buf = s;
        } else if (this.buf && s.length > 0) {
            // 被りをなるべく避ける簡易マージ
            const overlap = longestOverlapSuffixPrefix(this.buf, s);
            this.buf = this.buf + s.slice(overlap);
        } else {
            this.buf = s;
        }

        // 句読点が付いたら即時更新、それ以外はthrottle
        const now = Date.now();
        const hasPunc = /[。．！？!?]/.test(this.buf.slice(-1));
        if (hasPunc || now - this.lastEmit >= this.throttleMs) {
            this.lastEmit = now;
            this.emitUpdate(this.buf);
        }
    }

    // 音声区切り（end）で「文」を確定し、最終更新→final通知
    onEnd() {
        const text = this.buf.trim();
        if (text) {
            this.emitUpdate(text);
            this.emitFinal(text);
        }
        this.buf = '';
    }
}

// buf の末尾と s の先頭の最長オーバーラップを粗く求める
function longestOverlapSuffixPrefix(a, b) {
    const max = Math.min(a.length, b.length, 30); // 探索上限（過度な計算を避ける）
    for (let k = max; k > 0; k--) {
        if (a.slice(-k) === b.slice(0, k)) return k;
    }
    return 0;
}
