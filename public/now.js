(() => {
  // ---- 安全ログヘルパー ----
  const log = (...a) => console.log('[now]', ...a);
  const warn = (...a) => console.warn('[now]', ...a);
  const err = (...a) => console.error('[now]', ...a);

  // ---- DOM 取得（ガード付き）----
  const nowEl = document.getElementById('now');
  const deck = document.getElementById('avatars');
  if (!nowEl) { err('missing #now element'); return; }
  if (!deck) { warn('missing #avatars element (avatars will not render)'); }

  // ---- Socket 接続（存在チェック）----
  if (typeof io !== 'function') { err('socket.io client "io" not found'); return; }
  const socket = io();
  socket.on('connect', () => log('socket connected', socket.id));

  // ---- クエリ & CSS 反映 ----
  const q = new URLSearchParams(location.search);
  const font = Number(q.get('font') || 36);
  // const deckSize = Number(q.get('pfpsize') || 72);
  // const inactive = Number(q.get('inactive') || 0.35);
  // document.documentElement.style.setProperty('--pfp-size', `${deckSize}px`);
  // document.documentElement.style.setProperty('--pfp-inactive', `${inactive}`);

  // ===== 固定配置マップ（ここを編集して好きな位置へ） =====
  // 単位は「画面に対する％」。center基準（JSで -50% translate 済み）
  // scale は任意（1.0標準）。src を指定すれば payload の avatar/icon より優先。
  const POSITION_CONFIG = window.POSITION_CONFIG || {
    // 例:
    // '272380840434991104': { x: 14,  y: 78, scale: 1.1, src: '/avatars/kakiya_still.png' },
    // '123456789012345678': { x: 86,  y: 22, scale: 1.0, src: '/avatars/yoneda_still.png' },
    // '999999999999999999': { x: 50,  y: 50, scale: 1.2, src: '/avatars/haracternick_still.png' },
    '272380840434991104': {
      x: 70,
      y: 41,
      scale: 1.0,
      src: '/avatars/kakiya_still.png',
      mask: '/avatars/masks/kakiya_mask.png',
      name: 'カキヤ',             // バブル名の初期値
      side: 'right',               // バブル左右
      color: 'rgba(170, 133, 85, 1)',              // 名前色（任意）
    },
    '123456789012345678': {
      x: -10,
      y: 5,
      scale: 1.05,
      src: '/avatars/yoneda_still.png',
      mask: '/avatars/masks/yoneda_mask.png',
      name: 'ヨネダ',
      side: 'left',
      color: '#d85',
    },
    '999999999999999999': {
      x: -15,
      y: 35,
      scale: 1.1,
      src: '/avatars/haracternick_still.png',
      mask: '/avatars/masks/haracternick_mask.png',
      name: 'Haracternick',
      side: 'left',
      color: 'rgba(85, 117, 221, 1)',
    },
  };


  // ---- 内部状態 ----
  const asId = v => String(v);
  const speakers = new Map(); // id -> { el, name, color, pos }
  let currentActiveId = null;

  // ---- 自動配置（POSITION_CONFIGに無い人用）----
  const autoNext = { left: 0, right: 0 };
  function autoPosition(side = 'left') {
    const slot = autoNext[side]++;
    const col = side === 'right' ? 85 : 15; // x %
    const row = 20 + slot * 18;             // y %
    return { x: col, y: Math.min(row, 85), scale: 1 };
  }

  // ---- アバターDOM生成（必要時のみ）----
  function ensureDeckAvatar(e) {
    const id = asId(e.userId);
    let rec = speakers.get(id);
    if (rec) return rec;

    // 表示情報
    const cfg = POSITION_CONFIG[id] || null;
    const pos = cfg || autoPosition(e.side || 'left');

    // 画像ソースは config.src > payload.icon > payload.avatar の順
    const src = (cfg && cfg.src) || e.icon || e.avatar || '';

    if (!deck) return null; // デッキが無いならスキップ

    const el = document.createElement('img');
    el.className = 'deck-avatar dimmed'; // 初期は非アクティブ風
    el.src = src;
    el.alt = (e.name || cfg?.name || 'speaker');
    el.decoding = 'async';
    el.loading = 'lazy';

    el.style.left = `${pos.x}%`;
    el.style.top = `${pos.y}%`;
    if (pos.scale) el.style.setProperty('--scale', pos.scale);

    // マスク（オプトイン）
    if (cfg?.mask) {
      el.dataset.mask = '1';
      el.style.setProperty('--mask-image', `url('${cfg.mask}')`);
    }
    // クリップ（任意）
    if (cfg?.clip) {
      el.dataset.clip = '1';
      el.style.setProperty('--clip-path', cfg.clip);
    }

    deck.appendChild(el);

    rec = {
      el,
      name: e.name || cfg?.name || '',
      color: e.color || cfg?.color || '',
      pos,
    };
    speakers.set(id, rec);
    return rec;
  }

  // ---- ハイライト制御（最新発言が表示されている間は維持）----
  function setActive(userId) {
    const id = asId(userId);
    // まず全員 dimmed
    for (const [, r] of speakers) {
      r.el.classList.remove('active', 'pulse');
      r.el.classList.add('dimmed');
    }
    // 対象だけ active
    let r = speakers.get(id);
    if (!r) {
      r = ensureDeckAvatar({ userId: id, side: 'left' });
    }
    if (r) {
      r.el.classList.remove('dimmed');
      r.el.classList.add('active', 'pulse');
      currentActiveId = id;
    }
  }

  // ---- 最新バブル描画（安全実装）----
  function renderBubble(e) {
    const id = asId(e.userId);
    const cfg = POSITION_CONFIG[id] || {};
    const displayName = e.name || cfg.name || '';
    const displaySide = e.side || cfg.side || 'left';
    const displayColor = e.color || cfg.color || '';

    nowEl.className = `bubble ${displaySide}`;
    nowEl.innerHTML = '';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = displayName;
    if (displayColor) name.style.color = displayColor;

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = e.text || '';
    text.style.fontSize = `${font}px`;

    nowEl.appendChild(name);
    nowEl.appendChild(text);

    if (e.tr?.text) {
      const tr = document.createElement('div');
      tr.className = 'tr';
      tr.textContent = e.tr.text;
      nowEl.appendChild(tr);
    }
  }

  // ---- フェード（フェード開始で強調解除）----
  const fadeSec = Number(q.get('fade') || 30);
  let fadeTimer = null;
  function startFadeTimer() {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    nowEl.classList.remove('is-fading');
    if (fadeSec > 0) {
      fadeTimer = setTimeout(() => {
        nowEl.classList.add('is-fading');
        if (currentActiveId && speakers.has(currentActiveId)) {
          const r = speakers.get(currentActiveId);
          r.el.classList.remove('active', 'pulse');
          r.el.classList.add('dimmed');
          currentActiveId = null;
        }
      }, fadeSec * 1000);
    }
  }

  // ---- 初期表示（全員出す）----
  function preloadDeck() {
    if (!deck) return;
    Object.entries(POSITION_CONFIG).forEach(([uid, cfg]) => {
      ensureDeckAvatar({
        userId: asId(uid),
        name: cfg.name,
        side: cfg.side,
        color: cfg.color,
        avatar: cfg.src,
        icon: cfg.src,
      });
    });
  }
  preloadDeck();

  // ---- 受信ハンドラ ----
  socket.on('transcript', (payload) => {
    try {
      const id = asId(payload.userId);
      // 1) アバター準備
      ensureDeckAvatar({ ...payload, userId: id });
      // 2) ハイライト
      setActive(id);
      // 3) バブル
      renderBubble({ ...payload, userId: id });
      // 4) フェード管理
      startFadeTimer();
    } catch (e) {
      err('render failed:', e);
    }
  });

  // 後追いの翻訳だけ受け取る（表示は維持）
  socket.on('transcript_update', (upd) => {
    try {
      if (!upd?.tr?.text) return;
      // 既存バブルに翻訳行を足す（作り直さない）
      const tr = document.createElement('div');
      tr.className = 'tr';
      tr.textContent = upd.tr.text;
      nowEl.appendChild(tr);
      // フェードタイマーは延長しない（好みで startFadeTimer() を呼んでもOK）
    } catch (e) {
      console.error('[now] update failed:', e);
    }
  });

  // ---- デバッグAPI（URLに ?demo=1 を付けると発火）----
  if (q.get('demo') === '1') {
    setInterval(() => {
      const ids = Object.keys(POSITION_CONFIG);
      const pick = ids[Math.floor(Math.random() * ids.length)] || 'debug';
      const cfg = POSITION_CONFIG[pick] || { name: 'Debug', side: 'left', color: '#fff' };
      const demo = {
        userId: asId(pick),
        name: cfg.name || 'Debug',
        side: cfg.side || 'left',
        color: cfg.color || '#fff',
        text: 'demo lorem ipsum ' + Math.random().toString(36).slice(2, 7),
        ts: Date.now(),
      };
      socket.emit && log('demo emit local'); // ログ
      // ローカルで直接処理（サーバを経由しないデモ）
      ensureDeckAvatar(demo);
      setActive(demo.userId);
      renderBubble(demo);
      startFadeTimer();
    }, 2000);
  }
})();
