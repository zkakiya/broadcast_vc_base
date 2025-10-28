(() => {
  const socket = io();
  const root = document.getElementById('timeline');
  const q = new URLSearchParams(location.search);
  const limit = Number(q.get('limit') || 10);
  const pfpMode = (q.get('pfp') || 'none'); // 'none'|'icon'|'avatar'
  const pfpSize = Number(q.get('avatar') || 48);

  // すべてのエントリを id で集約
  /** @type {Map<string, {id:string,userId?:string,name?:string,side?:'left'|'right',color?:string,avatar?:string,icon?:string,text:string,tr?:{to?:string,text?:string,mode?:'replace'}, revUpdated:number,trUpdated:number,ts?:number}>} */
  const entriesById = new Map();

  // 左右デフォルト決定
  function normSide(e) {
    const s = String(e.side || '').toLowerCase();
    if (s === 'l' || s === 'left') return 'left';
    if (s === 'r' || s === 'right') return 'right';
    const uid = String(e.userId || '');
    let h = 0; for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
    return (h & 1) === 0 ? 'left' : 'right';
  }

  // 既存とマージ（本文 or 訳の後勝ち制御）
  function upsertEntry(partial, kind) {
    const now = Date.now();
    const id = String(partial.id || '');
    if (!id) return;

    const cur = entriesById.get(id) || {
      id, text: '',
      revUpdated: 0,
      trUpdated: 0,
    };

    // ベース属性は最初に来た情報を保持、以降は空でないものだけ上書き
    const fields = ['userId', 'name', 'side', 'color', 'avatar', 'icon', 'ts'];
    for (const f of fields) {
      if (partial[f] !== undefined && partial[f] !== null) cur[f] = partial[f];
    }
    cur.side = normSide(cur);

    if (kind === 'transcript') {
      // 本文は “そのまま差し替え”（サーバが flush 分をまとめてくる想定）
      // または初回 flush 用。新しい更新だけ採用。
      const revTs = Number(partial.ts || now);
      if (revTs >= cur.revUpdated) {
        cur.text = String(partial.text || '');
        cur.revUpdated = revTs;
      }
    } else if (kind === 'append') {
      // 追記は本文に追加。本文更新時刻を上げる。
      cur.text = (cur.text || '') + String(partial.append || '');
      cur.revUpdated = now;
    }

    if (partial.tr) {
      // 訳更新（replace/append いずれも “新しい更新だけ” 反映）
      // transcript_update が out-of-order でも trUpdated で守る
      const trTs = now;
      if (trTs >= cur.trUpdated) {
        if (partial.tr.mode === 'replace') {
          cur.tr = { ...partial.tr };
        } else {
          // append 指定が来る可能性も一応考慮
          const prev = cur.tr?.text || '';
          cur.tr = { ...partial.tr, text: prev + String(partial.tr.text || '') };
        }
        cur.trUpdated = trTs;
      }
    }

    entriesById.set(id, cur);
    requestRender();
  }

  // 表示配列を作る（更新時刻でソートして末尾 limit 件）
  function materialize() {
    const arr = Array.from(entriesById.values());
    // ソートキー: ts (初回) / revUpdated / trUpdated の最大
    arr.sort((a, b) => {
      const ta = Math.max(a.ts || 0, a.revUpdated || 0, a.trUpdated || 0);
      const tb = Math.max(b.ts || 0, b.revUpdated || 0, b.trUpdated || 0);
      return ta - tb;
    });
    return arr.slice(-limit);
  }

  let needRender = false;
  function requestRender() {
    if (needRender) return;
    needRender = true;
    requestAnimationFrame(() => {
      needRender = false;
      render();
    });
  }

  function render() {
    const items = materialize();
    root.innerHTML = '';
    for (const e of items) {
      const row = document.createElement('div');
      row.className = `entry side-${e.side || 'left'}`;

      const src = pfpMode === 'icon' ? (e.icon || e.avatar)
        : pfpMode === 'avatar' ? (e.avatar || e.icon) : null;
      if (src && pfpSize > 0) {
        const img = document.createElement('img');
        img.className = 'pfp';
        img.src = src; img.alt = e.name || 'speaker';
        img.width = pfpSize; img.height = pfpSize;
        img.decoding = 'async'; img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        row.appendChild(img);
      }

      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      const name = document.createElement('div');
      name.className = 'name';
      if (e.color) name.style.color = e.color;
      name.textContent = e.name || '';
      bubble.appendChild(name);

      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = e.text || '';
      bubble.appendChild(text);

      if (e.tr?.text) {
        const tr = document.createElement('div');
        tr.className = 'tr';
        tr.textContent = e.tr.text;
        bubble.appendChild(tr);
      }

      row.appendChild(bubble);
      root.appendChild(row);
    }
    // 末尾へオートスクロール
    root.scrollTop = root.scrollHeight;
  }

  // --- ソケットイベント ---
  socket.on('transcript', (payload) => {
    // 初回 flush（または差し替え）が来る
    upsertEntry(payload, 'transcript');
  });

  socket.on('transcript_update', (payload) => {
    const { id, append, tr } = payload || {};
    if (!id) return;
    if (append) {
      upsertEntry({ id, append }, 'append');
    }
    if (tr) {
      upsertEntry({ id, tr }, 'update'); // 訳の更新は常に “新しい方だけ” 反映
    }
  });

  // 運用ショートカット
  window.addEventListener('keydown', (e) => {
    if (e.key === 'c') {
      entriesById.clear();
      requestRender();
    }
  });
})();
