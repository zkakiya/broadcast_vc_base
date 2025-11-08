// public/app.js (full replace)
(() => {
  // ---- Global namespace ----
  if (!window.BVC) window.BVC = {};
  const GLOBAL = window.BVC;

  // ==== Metrics (new) ====
  // 二重読込でも上書きされないよう既存を温存
  GLOBAL.metrics = GLOBAL.metrics || {
    transcripts: 0,
    updates: 0,
    last: null,
    lastAt: null,
    connectCount: 0,
    disconnectCount: 0,
  };
  // 外部から簡単に参照するための関数（コンソールで BVCgetMetrics() ）
  window.BVCgetMetrics = function () {
    const m = GLOBAL.metrics;
    // 参照時に最新を返すだけ
    return JSON.parse(JSON.stringify(m));
  };
  // ついでにリセット
  GLOBAL.resetMetrics = function () {
    GLOBAL.metrics.transcripts = 0;
    GLOBAL.metrics.updates = 0;
    GLOBAL.metrics.last = null;
    GLOBAL.metrics.lastAt = null;
    GLOBAL.metrics.connectCount = 0;
    GLOBAL.metrics.disconnectCount = 0;
  };

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
  // 既に接続がある場合は使い回し
  GLOBAL.socket = GLOBAL.socket || io();

  GLOBAL.socket.on('connect', () => {
    GLOBAL.metrics.connectCount += 1;
    console.log('[app] socket connected', GLOBAL.socket.id);
  });
  GLOBAL.socket.on('disconnect', () => {
    GLOBAL.metrics.disconnectCount += 1;
    console.log('[app] disconnected');
  });

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
  GLOBAL.POSITION_CONFIG = GLOBAL.POSITION_CONFIG || {};
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
  const speakers = GLOBAL.speakers || new Map(); // id -> { el, name, color, pos }
  GLOBAL.speakers = speakers;
  GLOBAL.currentActiveId = GLOBAL.currentActiveId || null;

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

    deck.appendChild(el);

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

  // ---- Wire socket events (dedup & metrics) ----
  // _wired は GLOBAL 側に保持して二重登録を防ぐ
  if (typeof GLOBAL._wired === 'undefined') GLOBAL._wired = false;

  GLOBAL.wireSocket = (handlers) => {
    if (GLOBAL._wired) return;
    GLOBAL._wired = true;

    const s = GLOBAL.socket;
    if (!s) { console.error('[app] GLOBAL.socket missing'); return; }

    const { onTranscript, onUpdate } = handlers || {};

    // 低レベルでログ＋カウンタ（onTranscript/onUpdate 無くても回る）
    s.on('transcript', (p) => {
      GLOBAL.metrics.transcripts += 1;
      GLOBAL.metrics.last = p;
      GLOBAL.metrics.lastAt = Date.now();
      console.log('[recv] transcript', p);
      onTranscript && onTranscript(p);
    });

    s.on('transcript_update', (p) => {
      GLOBAL.metrics.updates += 1;
      GLOBAL.metrics.last = p;
      GLOBAL.metrics.lastAt = Date.now();
      console.log('[recv] transcript_update', p);
      onUpdate && onUpdate(p);
    });

    // 互換: ハンドラがあればイベントを直接も配線（重複しないよう注意）
    if (onTranscript) s.on('transcript_for_handler', onTranscript);
    if (onUpdate) s.on('transcript_update_for_handler', onUpdate);
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
