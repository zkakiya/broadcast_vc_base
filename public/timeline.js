// public/timeline.js
(() => {
  const socket = io();
  const root = document.getElementById('timeline');
  const q = new URLSearchParams(location.search);
  const limit = Number(q.get('limit') || 10);
  const pfpMode = (q.get('pfp') || 'none');    // 'none' | 'icon' | 'avatar'
  const pfpSize = Number(q.get('avatar') || 48);
  const entries = [];

  function normSide(e) {
    const s = String(e.side || '').toLowerCase();
    if (s === 'l' || s === 'left') return 'left';
    if (s === 'r' || s === 'right') return 'right';
    const uid = String(e.userId || '');
    let h = 0; for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) | 0;
    return (h & 1) === 0 ? 'left' : 'right';
  }

  function render() {
    root.innerHTML = '';
    const items = entries.slice(-limit);
    for (const e of items) {
      const row = document.createElement('div');
      row.className = `entry side-${e.side || 'left'}`;
      row.dataset.id = e.id;

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

      const trEl = document.createElement('div');
      trEl.className = 'tr';
      trEl.textContent = e.tr?.text || '';
      bubble.appendChild(trEl);

      row.appendChild(bubble);
      root.appendChild(row);
    }
    root.scrollTop = root.scrollHeight;
  }

  socket.on('transcript', (payload) => {
    entries.push({
      ...payload,
      side: normSide(payload),
      tr: payload.tr ? { ...payload.tr } : undefined,
      text: payload.text || ''
    });
    render();
  });

  // append / replace（翻訳）/ append（翻訳）
  socket.on('transcript_update', ({ id, append, tr }) => {
    if (!id) return;
    const idx = entries.findIndex(e => e.id === id);
    if (idx < 0) return;

    const e = entries[idx];

    if (typeof append === 'string' && append.length) {
      e.text = (e.text || '') + append;
    }
    if (tr && typeof tr.text === 'string') {
      const mode = tr.mode || 'append';
      const to = tr.to;
      if (!e.tr) e.tr = { to, text: '' };
      if (mode === 'replace') {
        e.tr = { to, text: tr.text };
      } else {
        e.tr = { to, text: (e.tr.text || '') + tr.text };
      }
    }
    entries[idx] = e;
    render();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'c') { entries.length = 0; render(); }
  });
})();
