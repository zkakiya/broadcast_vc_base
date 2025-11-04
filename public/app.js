// public/app.js (full replace)
(() => {
  // ---- Global namespace ----
  if (!window.BVC) window.BVC = {};
  const GLOBAL = window.BVC;

  // ---- URL params (fade/font/mode) ----
  const qs = new URLSearchParams(location.search);
  GLOBAL.fadeSec = Number(qs.get('fade') || 30);
  GLOBAL.fontPx = Number(qs.get('font') || 36);
  let RUN_MODE = (qs.get('mode') || '').toLowerCase(); // 'single'|'multi'|''
  GLOBAL.getMode = () => RUN_MODE;

  // ---- Socket.IO init ----
  if (typeof io !== 'function') {
    console.error('[app] socket.io client not found');
    return;
  }
  GLOBAL.socket = io();
  GLOBAL.socket.on('connect', () => console.log('[app] socket connected', GLOBAL.socket.id));
  GLOBAL.socket.on('disconnect', () => console.log('[app] disconnected'));

  // ---- Mode decide (URL > /healthz > default) ----
  async function decideMode() {
    if (RUN_MODE === 'single' || RUN_MODE === 'multi') return RUN_MODE;
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const m = (j?.mode || '').toLowerCase();
        if (m === 'single' || m === 'multi') RUN_MODE = m;
      }
    } catch { }
    if (!RUN_MODE) RUN_MODE = 'multi';
    return RUN_MODE;
  }

  // ---- Position config load (auto switch) ----
  GLOBAL.POSITION_CONFIG = {};
  async function loadPositionConfig() {
    const mode = await decideMode();
    const path = mode === 'single' ? '/position.single.json' : '/position.json';
    try {
      const r = await fetch(`${path}?v=${Date.now()}`); // cache-buster
      if (r.ok) {
        const j = await r.json();
        GLOBAL.POSITION_CONFIG = { ...GLOBAL.POSITION_CONFIG, ...j };
        console.log(`[app] position loaded: ${path}`);
        // 読み込み後に全員のアバターを初期表示（dimmed）
        renderDeckFromPosition();
      } else {
        console.warn(`[app] position file not found: ${path}`);
      }
    } catch (e) {
      console.error('[app] failed to load position file:', e);
    }
  }

  // ---- Avatars deck management ----
  const speakers = new Map(); // id -> { el, name, color, pos }
  GLOBAL.speakers = speakers;
  GLOBAL.currentActiveId = null;

  function asId(v) { return String(v); }
  GLOBAL.asId = asId;

  function autoPosition(side = 'left') {
    return { x: side === 'right' ? 85 : 15, y: 50, scale: 1 };
  }
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

    // === マスク適用部分 ===
    // 明示的にcfg.maskがある場合 → それを使用
    // 無い場合 → srcをそのままマスクとして使用（PNGのアルファを利用）
    const maskSrc = cfg?.mask || src;
    if (maskSrc) {
      el.style.webkitMaskImage = `url(${maskSrc})`;
      el.style.maskImage = `url(${maskSrc})`;
      el.style.webkitMaskRepeat = 'no-repeat';
      el.style.maskRepeat = 'no-repeat';
      el.style.webkitMaskSize = 'contain';
      el.style.maskSize = 'contain';
      el.style.webkitMaskPosition = 'center';
      el.style.maskPosition = 'center';
    }

    // === デッキに追加 ===
    deck.appendChild(el);

    // デバッグクリック：クリックでアクティブ化
    el.addEventListener('click', () => {
      setActive(id);
      startFadeTimer(() => {
        el.classList.add('dimmed');
        el.classList.remove('active');
      });
    });

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

  // ---- Fade utility ----
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

  // ---- Wire socket events (dedup) ----
  let _wired = false;
  GLOBAL.wireSocket = (handlers) => {
    if (_wired) return;
    _wired = true;
    const s = GLOBAL.socket;
    if (!s) { console.error('[app] GLOBAL.socket missing'); return; }
    const { onTranscript, onUpdate } = handlers || {};
    if (onTranscript) s.on('transcript', onTranscript);
    if (onUpdate) s.on('transcript_update', onUpdate);
  };

  // ---- Render all avatars at startup (dimmed) ----
  function renderDeckFromPosition() {
    const deck = document.getElementById('avatars');
    if (!deck) return; // page without deck
    const ids = Object.keys(GLOBAL.POSITION_CONFIG || {});
    for (const uid of ids) {
      const cfg = GLOBAL.POSITION_CONFIG[uid] || {};
      ensureDeckAvatar({
        userId: asId(uid),
        name: cfg.name,
        side: cfg.side,
        color: cfg.color,
        avatar: cfg.src,
        icon: cfg.src,
      });
      const rec = speakers.get(asId(uid));
      if (rec?.el) {
        rec.el.classList.add('dimmed');
        rec.el.classList.remove('active', 'pulse');
      }
    }
  }
  GLOBAL.renderDeckFromPosition = renderDeckFromPosition;

  // ---- Boot sequence ----
  loadPositionConfig(); // async (will call renderDeckFromPosition when loaded)
})();
