// public/app.js

(() => {
  // ===== 初期設定 / DOM =====
  const POS_URL = '/position.json';
  let POSITION_CONFIG = window.POSITION_CONFIG || {};
  try {
    const j = await fetch(POS_URL).then(r => r.ok ? r.json() : ({}));
    POSITION_CONFIG = { ...POSITION_CONFIG, ...j };
  } catch { }
  const qs = new URLSearchParams(location.search);
  let VIEW_MODE = (window.VIEW_MODE || 'both').toLowerCase(); // latest|timeline|avatars|both
  const FONT = Number(qs.get('font') || 36);
  const FADE_SEC = Number(qs.get('fade') || 30);

  const avatarsEl = document.getElementById('avatars');
  const nowEl = document.getElementById('now');
  const timelineEl = document.getElementById('timeline');

  // テスト用UI
  const viewSel = document.getElementById('viewSel');
  const fontSel = document.getElementById('fontSel');
  if (viewSel) {
    viewSel.value = VIEW_MODE;
    viewSel.onchange = () => {
      VIEW_MODE = viewSel.value;
      applyViewMode();
      history.replaceState(null, '', `?view=${VIEW_MODE}&font=${fontSel.value}`);
    };
  }
  if (fontSel) {
    fontSel.value = FONT;
    fontSel.onchange = () => {
      const v = Number(fontSel.value || 36);
      nowEl?.style?.setProperty('--font-size', `${v}px`);
      const tr = nowEl?.querySelector('.text'); if (tr) tr.style.fontSize = `${v}px`;
    };
  }

  function applyViewMode() {
    const showAv = VIEW_MODE === 'avatars' || VIEW_MODE === 'both';
    const showLatest = VIEW_MODE === 'latest' || VIEW_MODE === 'both';
    const showTimeline = VIEW_MODE === 'timeline';

    if (avatarsEl) avatarsEl.classList.toggle('hidden', !showAv);
    if (document.getElementById('latestWrap')) document.getElementById('latestWrap').classList.toggle('hidden', !showLatest);
    if (timelineEl) timelineEl.classList.toggle('hidden', !showTimeline);
  }
  applyViewMode();

  // ===== Socket.IO =====
  if (typeof io !== 'function') {
    console.error('[app] socket.io client not found');
    return;
  }
  const socket = io();
  socket.on('connect', () => console.log('[app] socket connected', socket.id));

  // ===== 固定配置（now.js からの移植・編集可） =====
  const POSITION_CONFIG = window.POSITION_CONFIG || {
    '272380840434991104': { x: 78, y: 41, scale: 1.0, src: '/avatars/kakiya_still.png', name: 'カキヤ', side: 'right', color: '#aa8555' },
    '463714335596740638': { x: -10, y: 5, scale: 1.05, src: '/avatars/yoneda_still.png', name: 'ヨネダ', side: 'left', color: '#d85' },
    '682709913335890031': { x: -20, y: 35, scale: 1.1, src: '/avatars/haracternick_still.png', name: 'Haracternick', side: 'left', color: '#5575dd' },
  };

  const speakers = new Map(); // id -> { el, name, color, pos }
  let currentActiveId = null;

  function asId(v) { return String(v) }
  function autoPosition(side = 'left') {
    const col = side === 'right' ? 85 : 15;
    const row = 50;
    return { x: col, y: row, scale: 1 };
  }
  function ensureDeckAvatar(e) {
    if (!avatarsEl) return null;
    const id = asId(e.userId);
    let rec = speakers.get(id);
    if (rec) return rec;

    const cfg = POSITION_CONFIG[id] || null;
    const pos = cfg || autoPosition(e.side || 'left');
    const src = (cfg && cfg.src) || e.icon || e.avatar || '';

    const el = document.createElement('img');
    el.className = 'deck-avatar dimmed';
    el.src = src; el.alt = (e.name || cfg?.name || 'speaker');
    el.decoding = 'async'; el.loading = 'lazy';

    el.style.position = 'absolute';
    el.style.left = `${pos.x}%`; el.style.top = `${pos.y}%`;
    el.style.transform = `translate(-50%,-50%) scale(${pos.scale || 1})`;

    avatarsEl.appendChild(el);

    rec = { el, name: e.name || cfg?.name || '', color: e.color || cfg?.color || '', pos };
    speakers.set(id, rec);
    return rec;
  }
  function setActive(userId) {
    const id = asId(userId);
    for (const [, r] of speakers) {
      r.el.classList.remove('active', 'pulse');
      r.el.classList.add('dimmed');
      r.el.style.filter = 'grayscale(100%) saturate(.3) brightness(.9)';
      r.el.style.opacity = '.6';
    }
    let r = speakers.get(id);
    if (!r) r = ensureDeckAvatar({ userId: id, side: 'left' });
    if (r) {
      r.el.classList.remove('dimmed');
      r.el.classList.add('active', 'pulse');
      r.el.style.filter = 'none';
      r.el.style.opacity = '1';
      currentActiveId = id;
    }
  }

  // ===== LATEST（バブル） =====
  let fadeTimer = null;
  function startFadeTimer() {
    if (!nowEl) return;
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    nowEl.classList.remove('is-fading');
    if (FADE_SEC > 0) {
      fadeTimer = setTimeout(() => {
        nowEl.classList.add('is-fading');
        if (currentActiveId && speakers.has(currentActiveId)) {
          const r = speakers.get(currentActiveId);
          r.el.classList.remove('active', 'pulse');
          r.el.classList.add('dimmed');
          r.el.style.filter = 'grayscale(100%) saturate(.3) brightness(.9)';
          r.el.style.opacity = '.6';
          currentActiveId = null;
        }
      }, FADE_SEC * 1000);
    }
  }
  function renderBubble(e) {
    if (!nowEl) return;
    nowEl.className = `bubble ${e.side || 'left'}`;
    nowEl.innerHTML = '';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.name || '';
    if (e.color) name.style.color = e.color;

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = e.text || '';
    text.style.fontSize = `${Number(fontSel?.value || FONT)}px`;

    nowEl.appendChild(name);
    nowEl.appendChild(text);

    if (e.tr?.text) {
      const tr = document.createElement('div');
      tr.className = 'tr';
      tr.textContent = e.tr.text;
      nowEl.appendChild(tr);
    }
    // POSITION_CONFIG[id]?.x があればそれを使い、なければ側ごとの既定
    const cfg = POSITION_CONFIG[id] || {};
    nowEl.style.setProperty('--tail-x', (typeof cfg.x === 'number') ? `${cfg.x}%` : (e.side === 'right' ? '88%' : '12%'));
  }

  // ===== TIMELINE（既存 timeline.js の安全マージを統合） =====
  /** @type {Map<string, {id:string,userId?:string,name?:string,side?:'left'|'right',color?:string,avatar?:string,icon?:string,text:string,tr?:{to?:string,text?:string,mode?:'replace'}, revUpdated:number,trUpdated:number,ts?:number}>} */
  const entriesById = new Map();
  const LIST_LIMIT = Number(qs.get('limit') || 10);

  function normSide(e) {
    const s = String(e.side || '').toLowerCase();
    if (s === 'l' || s === 'left') return 'left';
    if (s === 'r' || s === 'right') return 'right';
    const uid = String(e.userId || '');
    let h = 0; for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
    return (h & 1) === 0 ? 'left' : 'right';
  }
  function upsertEntry(partial, kind) {
    const now = Date.now();
    const id = String(partial.id || '');
    if (!id) return;

    const cur = entriesById.get(id) || { id, text: '', revUpdated: 0, trUpdated: 0 };
    for (const f of ['userId', 'name', 'side', 'color', 'avatar', 'icon', 'ts']) {
      if (partial[f] !== undefined && partial[f] !== null) cur[f] = partial[f];
    }
    cur.side = normSide(cur);

    if (kind === 'transcript') {
      const revTs = Number(partial.ts || now);
      if (revTs >= cur.revUpdated) {
        cur.text = String(partial.text || '');
        cur.revUpdated = revTs;
      }
    } else if (kind === 'append') {
      cur.text = (cur.text || '') + String(partial.append || '');
      cur.revUpdated = now;
    }

    if (partial.tr) {
      const trTs = now;
      if (trTs >= cur.trUpdated) {
        if (partial.tr.mode === 'replace') {
          cur.tr = { ...partial.tr };
        } else {
          const prev = cur.tr?.text || '';
          cur.tr = { ...partial.tr, text: prev + String(partial.tr.text || '') };
        }
        cur.trUpdated = trTs;
      }
    }

    entriesById.set(id, cur);
    requestRenderTimeline();
  }
  function materializeTimeline() {
    const arr = Array.from(entriesById.values());
    arr.sort((a, b) => {
      const ta = Math.max(a.ts || 0, a.revUpdated || 0, a.trUpdated || 0);
      const tb = Math.max(b.ts || 0, b.revUpdated || 0, b.trUpdated || 0);
      return ta - tb;
    });
    return arr.slice(-LIST_LIMIT);
  }
  let needRenderTL = false;
  function requestRenderTimeline() {
    if (needRenderTL) return;
    needRenderTL = true;
    requestAnimationFrame(() => {
      needRenderTL = false;
      renderTimeline();
    });
  }
  function renderTimeline() {
    if (!timelineEl) return;
    const items = materializeTimeline();
    timelineEl.innerHTML = '';
    for (const e of items) {
      const row = document.createElement('div');
      row.className = `entry side-${e.side || 'left'}`;

      const imgSrc = e.icon || e.avatar;
      if (imgSrc) {
        const img = document.createElement('img');
        img.className = 'pfp';
        img.src = imgSrc; img.alt = e.name || 'speaker';
        img.decoding = 'async'; img.loading = 'lazy';
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
      timelineEl.appendChild(row);
    }
    timelineEl.scrollTop = timelineEl.scrollHeight;
  }

  // ===== 受信（イベント名・訳“replace”は既存と互換） =====
  socket.on('transcript', (payload) => {
    const id = asId(payload.userId);
    // avatars/latest
    ensureDeckAvatar({ ...payload, userId: id });
    setActive(id);
    renderBubble({ ...payload, userId: id });
    startFadeTimer();
    // timeline
    upsertEntry(payload, 'transcript');
  });

  socket.on('transcript_update', (payload) => {
    const { id, append, tr } = payload || {};
    if (!id) return;
    if (append) upsertEntry({ id, append }, 'append');

    // 既存の“訳は replace 優先”に合わせる:contentReference[oaicite:4]{index=4}
    if (tr) {
      upsertEntry({ id, tr }, 'update');
      // latest の訳も追加表示（置換）
      if (nowEl && nowEl.querySelector('.tr')) {
        nowEl.querySelector('.tr').textContent = tr.text;
      } else if (nowEl) {
        const el = document.createElement('div');
        el.className = 'tr';
        el.textContent = tr.text;
        nowEl.appendChild(el);
      }
    }
  });

  // ===== 初期デッキのプリロード（任意） =====
  Object.entries(POSITION_CONFIG).forEach(([uid, cfg]) => {
    ensureDeckAvatar({
      userId: asId(uid),
      name: cfg.name, side: cfg.side, color: cfg.color, avatar: cfg.src, icon: cfg.src,
    });
  });

  // デバッグ：?demo=1 でローカル生成
  if (qs.get('demo') === '1') {
    setInterval(() => {
      const ids = Object.keys(POSITION_CONFIG);
      const pick = ids[Math.floor(Math.random() * ids.length)];
      const cfg = POSITION_CONFIG[pick];
      const demo = {
        id: `demo-${Date.now()}`,
        userId: pick,
        name: cfg.name,
        side: cfg.side,
        color: cfg.color,
        text: 'demo ' + Math.random().toString(36).slice(2, 7),
        ts: Date.now(),
      };
      ensureDeckAvatar(demo);
      setActive(demo.userId);
      renderBubble(demo);
      startFadeTimer();
      upsertEntry(demo, 'transcript');
    }, 1800);
  }
})();
