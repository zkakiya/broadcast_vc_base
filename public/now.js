(() => {
  const socket = io();
  const nowEl = document.getElementById('now');
  const deck = document.getElementById('avatars');
  if (deck) deck.classList.add('avatar-deck');

  const q = new URLSearchParams(location.search);

  // ===== 表示サイズ系（既存互換） =====
  const font = Number(q.get('font') || 36);
  // const deckSize = Number(q.get('pfpsize') || 72);
  // const inactive = Number(q.get('inactive') || 0.35);
  // document.documentElement.style.setProperty('--pfp-size', `${deckSize}px`);
  // document.documentElement.style.setProperty('--pfp-inactive', `${inactive}`);

  // ===== 固定配置マップ（ここを編集して好きな位置へ） =====
  // 単位は「画面に対する％」。center基準（JSで -50% translate 済み）
  // scale は任意（1.0標準）。src を指定すれば payload の avatar/icon より優先。
  const POSITION_CONFIG = {
    // 例:
    // '272380840434991104': { x: 14,  y: 78, scale: 1.1, src: '/avatars/kakiya_still.png' },
    // '123456789012345678': { x: 86,  y: 22, scale: 1.0, src: '/avatars/yoneda_still.png' },
    // '999999999999999999': { x: 50,  y: 50, scale: 1.2, src: '/avatars/haracternick_still.png' },
    '272380840434991104': {
      x: 70,
      y: 39,
      scale: 1.1,
      src: '/avatars/kakiya_still.png',
      mask: '/avatars/masks/kakiya_mask.png',
      name: 'カキヤ',             // バブル名の初期値
      side: 'right',               // バブル左右
      color: 'rgba(170, 133, 85, 1)',              // 名前色（任意）
    },
    '123456789012345678': {
      x: -10,
      y: 5,
      scale: 1.2,
      src: '/avatars/yoneda_still.png',
      mask: '/avatars/masks/yoneda_mask.png',
      name: 'ヨネダ',
      side: 'left',
      color: '#d85',
    },
    '999999999999999999': {
      x: -15,
      y: 39,
      scale: 1.2,
      src: '/avatars/haracternick_still.png',
      mask: '/avatars/masks/haracternick_mask.png',
      name: 'Haracternick',
      side: 'left',
      color: 'rgba(85, 117, 221, 1)',
    },
  };

  // ===== スピーカーのDOMレジストリ =====
  // userId -> { el, name, color, pos, lastActiveTimer }
  const speakers = new Map();

  // フォールバック用に自動配置（設定が無い人向け：左右に積む）
  const autoNext = { left: 0, right: 0 };
  function autoPosition(side = 'left') {
    const slot = autoNext[side]++;
    const col = side === 'right' ? 85 : 15; // x[%]
    const row = 20 + slot * 18;             // y[%]
    return { x: col, y: Math.min(row, 85), scale: 1 };
  }

  // 固定アバターを用意 or 取得
  function ensureDeckAvatar(e) {
    const id = String(e.userId);
    let rec = speakers.get(id);
    if (rec) return rec;

    // 表示情報
    const cfg = POSITION_CONFIG[id] || null;
    const pos = cfg || autoPosition(e.side || 'left');

    // 画像ソースは config.src > payload.icon > payload.avatar の順
    const src = (cfg && cfg.src) || e.icon || e.avatar || '';

    const el = document.createElement('img');
    el.className = 'deck-avatar';
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
    if (cfg?.clip) {
      el.dataset.clip = '1';
      el.style.setProperty('--clip-path', cfg.clip);
    }

    deck?.appendChild(el);

    rec = {
      el,
      name: e.name || cfg?.name,
      color: e.color || cfg?.color,
      pos,
      lastActiveTimer: null
    };
    speakers.set(id, rec);
    return rec;
  }

  // active の切替（他はinactiveへ）
  const ACTIVE_COOLDOWN_MS = Number(q.get('active_ms') || 1200); // 発話後に戻す時間
  function setActive(userId) {
    const id = String(userId);

    // 全員 inactive
    for (const [, rec] of speakers) {
      rec.el.classList.remove('active', 'pulse');
      if (rec.lastActiveTimer) { clearTimeout(rec.lastActiveTimer); rec.lastActiveTimer = null; }
    }
    // 対象を active
    const rec = speakers.get(id);
    if (!rec) return;

    rec.el.classList.add('active', 'pulse');
    rec.lastActiveTimer = setTimeout(() => {
      rec.el.classList.remove('active', 'pulse');
    }, ACTIVE_COOLDOWN_MS);
  }

  function renderBubble(e) {
    nowEl.className = `bubble ${e.side || 'left'}`;
    nowEl.innerHTML = '';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.name || '';
    if (e.color) name.style.color = e.color;

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

  // フェード（既存の仕組みを維持）
  const fadeSec = Number(q.get('fade') || 30);
  let fadeTimer = null;
  function startFadeTimer() {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    nowEl.classList.remove('is-fading');
    if (fadeSec > 0) {
      fadeTimer = setTimeout(() => nowEl.classList.add('is-fading'), fadeSec * 1000);
    }
  }

  // now.js の初期化末尾あたりに追加
  function preloadDeck() {
    // クエリでサイズ/不透明度を反映しているなら既存処理のままでOK
    Object.entries(POSITION_CONFIG).forEach(([userId, cfg]) => {
      ensureDeckAvatar({
        userId,
        name: cfg.name,
        side: cfg.side,
        color: cfg.color,
        avatar: cfg.src, // 画像
        icon: cfg.src,   // どちらでも表示できるように
        text: '',        // 初期は空
      });
    });
  }
  preloadDeck();

  socket.on('transcript', (payload) => {
    // 1) 固定アバター確保＆配置
    ensureDeckAvatar(payload);
    // 2) 発話者を強調
    setActive(payload.userId);
    // 3) 最新バブル
    renderBubble(payload);
    // 4) フェード
    startFadeTimer();
  });

})();
