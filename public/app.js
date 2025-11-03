// public/app.js
(() => {
  // ===== クエリ・DOM =====
  const qs = new URLSearchParams(location.search);
  const GLOBAL = window.BVC || (window.BVC = {});
  GLOBAL.viewMode = (qs.get('view') || 'both').toLowerCase(); // latest|timeline|avatars|both
  GLOBAL.fadeSec = Number(qs.get('fade') || 30);
  GLOBAL.fontPx = Number(qs.get('font') || 36);

  // Socket.IO
  if (typeof io !== 'function') { console.error('[app] socket.io not found'); return; }
  const socket = io();
  GLOBAL.socket = socket;

  // POSITION_CONFIG 取得（window.POSITION_CONFIG→/position.json→既定）
  GLOBAL.POSITION_CONFIG = window.POSITION_CONFIG || {
    '272380840434991104': { x: 78, y: 41, scale: 1.0, src: '/avatars/kakiya_still.png', name: 'カキヤ', side: 'right', color: 'rgba(170,133,85,1)' },
    '463714335596740638': { x: -10, y: 5, scale: 1.05, src: '/avatars/yoneda_still.png', name: 'ヨネダ', side: 'left', color: '#d85' },
    '682709913335890031': { x: -20, y: 35, scale: 1.1, src: '/avatars/haracternick_still.png', name: 'Haracternick', side: 'left', color: 'rgba(85,117,221,1)' },
  };
  (async () => {
    try {
      const r = await fetch('/position.json');
      if (r.ok) {
        const j = await r.json();
        GLOBAL.POSITION_CONFIG = { ...GLOBAL.POSITION_CONFIG, ...j };
      }
    } catch { }
  })();

  // アバターデッキ管理
  const speakers = new Map(); // id -> { el, name, color, pos }
  GLOBAL.speakers = speakers;
  GLOBAL.currentActiveId = null;

  function asId(v) { return String(v) }
  GLOBAL.asId = asId;

  function autoPosition(side = 'left') { return { x: side === 'right' ? 85 : 15, y: 50, scale: 1 } }
  GLOBAL.autoPosition = autoPosition;

  function ensureDeckAvatar({ userId, side, name, color, avatar, icon }) {
    const id = asId(userId);
    const deck = document.getElementById('avatars');
    if (!deck) return null;

    let rec = speakers.get(id);
    if (rec) return rec;

    const cfg = GLOBAL.POSITION_CONFIG[id] || null;
    const pos = cfg || autoPosition(side || 'left');
    const src = (cfg && cfg.src) || icon || avatar || '';

    const el = document.createElement('img');
    el.className = 'deck-avatar dimmed';
    el.src = src;
    el.alt = (name || cfg?.name || 'speaker');
    el.decoding = 'async';
    el.loading = 'lazy';
    el.style.left = `${pos.x}%`;
    el.style.top = `${pos.y}%`;
    el.style.setProperty('--scale', pos.scale || 1);

    deck.appendChild(el);

    rec = {
      el,
      name: name || cfg?.name || '',
      color: color || cfg?.color || '',
      pos
    };
    speakers.set(id, rec);
    return rec;
  }
  GLOBAL.ensureDeckAvatar = ensureDeckAvatar;

  function setActive(userId) {
    const id = asId(userId);
    for (const [, r] of speakers) {
      r.el.classList.remove('active', 'pulse');
      r.el.classList.add('dimmed');
    }
    let r = speakers.get(id) || ensureDeckAvatar({ userId: id, side: 'left' });
    if (r) {
      r.el.classList.remove('dimmed');
      r.el.classList.add('active', 'pulse');
      GLOBAL.currentActiveId = id;
    }
  }
  GLOBAL.setActive = setActive;

  // 汎用フェード
  let fadeTimer = null;
  function startFadeTimer(onFade) {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    const sec = GLOBAL.fadeSec;
    if (sec > 0) {
      fadeTimer = setTimeout(() => {
        onFade?.();
        if (GLOBAL.currentActiveId && speakers.has(GLOBAL.currentActiveId)) {
          const r = speakers.get(GLOBAL.currentActiveId);
          r.el.classList.remove('active', 'pulse');
          r.el.classList.add('dimmed');
          GLOBAL.currentActiveId = null;
        }
      }, sec * 1000);
    }
  }
  GLOBAL.startFadeTimer = startFadeTimer;

  // 再接続ガード
  let wired = false;
  GLOBAL.wireSocket = (handlers) => {
    if (wired) return;
    wired = true;
    const { onTranscript, onUpdate } = handlers || {};
    if (onTranscript) socket.on('transcript', onTranscript);
    if (onUpdate) socket.on('transcript_update', onUpdate);
    socket.on('connect', () => console.log('[app] socket connected', socket.id));
    socket.on('disconnect', () => console.log('[app] disconnected'));
  };

  // 初期デッキのプリロード
  (function preload() {
    const deck = document.getElementById('avatars');
    if (!deck) return;
    Object.entries(GLOBAL.POSITION_CONFIG).forEach(([uid, cfg]) => {
      ensureDeckAvatar({
        userId: asId(uid),
        name: cfg.name, side: cfg.side, color: cfg.color, avatar: cfg.src, icon: cfg.src,
      });
    });
  })();
})();
