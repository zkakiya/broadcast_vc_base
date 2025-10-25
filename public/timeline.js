(() => {
  const socket = io();
  const root = document.getElementById('timeline');
  const q = new URLSearchParams(location.search);
  const limit = Number(q.get('limit') || 10);
  const pfpMode = (q.get('pfp') || 'none');    // 既定:なし。'icon'|'avatar'も可
  const pfpSize = Number(q.get('avatar') || 48);
  const entries = [];

  // side未指定のとき、userIdで左右を安定化
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
      // スクロールを末尾へ
      root.scrollTop = root.scrollHeight;
    }
  }

  socket.on('transcript', (payload) => { entries.push(payload); render(); });

  // 訳の追記：同じ id のエントリに tr を反映して再描画
  socket.on('transcript_update', ({ id, tr }) => {
    if (!id) return;
    const idx = entries.findIndex(e => e.id === id);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], tr: tr ? { ...tr } : undefined };
      render();
    }
  });

  // 運用ショートカット（任意）
  window.addEventListener('keydown', (e) => {
    if (e.key === 'c') { entries.length = 0; render(); }
  });
})();
