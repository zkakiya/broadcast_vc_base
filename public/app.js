(() => {
  const socket = io();
  const timeline = document.getElementById('timeline');
  const now = document.getElementById('now');

  const params = new URLSearchParams(location.search);
  const limit = Number(params.get('limit') || 8);
  const font = Number(params.get('font') || 36);
  const avatarMode = (params.get('pfp') || 'none'); // 'none' | 'icon' | 'avatar'
  const avatarSize = Number(params.get('avatar') || 64); // pfpがnoneでも値は保持だけ
  now.style.fontSize = `${font}px`;

  const entries = [];

  function render() {
    timeline.innerHTML = '';
    const slice = entries.slice(-limit);

    for (const e of slice) {
      const row = document.createElement('div');
      row.className = `entry side-${e.side || 'left'}`;

      // ★ 軽量アイコン／フル立ち絵／非表示を切替
      const pfpSrc =
        avatarMode === 'icon'   ? (e.icon || e.avatar) :
        avatarMode === 'avatar' ? (e.avatar || e.icon) : null;

      if (pfpSrc && avatarSize > 0) {
        const img = document.createElement('img');
        img.className = 'avatar';
        img.src = pfpSrc;
        img.alt = e.name || 'speaker';
        img.width = avatarSize;
        img.height = avatarSize;
        img.decoding = 'async';
        img.loading = 'lazy';
        img.referrerPolicy = 'no-referrer';
        row.appendChild(img);
      }

      const bubble = document.createElement('div');
      bubble.className = 'bubble';

      if (e.name) {
        const name = document.createElement('div');
        name.className = 'name';
        if (e.color) name.style.color = e.color;
        name.textContent = e.name;
        bubble.appendChild(name);
      }

      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = e.text || '';
      bubble.appendChild(text);

      if (e.tr && e.tr.text) {
        const tr = document.createElement('div');
        tr.className = 'tr';
        tr.textContent = e.tr.text;
        bubble.appendChild(tr);
      }

      row.appendChild(bubble);
      timeline.appendChild(row);
    }

    const last = entries[entries.length - 1];
    if (last) {
      now.className = `bubble big side-${last.side || 'left'}`;
      now.innerHTML = '';
      if (last.name) {
        const name = document.createElement('div');
        name.className = 'name';
        if (last.color) name.style.color = last.color;
        name.textContent = last.name;
        now.appendChild(name);
      }
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = last.text || '';
      now.appendChild(text);
      if (last.tr?.text) {
        const tr = document.createElement('div');
        tr.className = 'tr';
        tr.textContent = last.tr.text;
        now.appendChild(tr);
      }
    } else {
      now.textContent = '';
    }
  }

  socket.on('transcript', (payload) => { entries.push(payload); render(); });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'c') { entries.length = 0; render(); }
  });
})();
