// public/latest.js
(() => {
  const G = window.BVC;
  if (!G) { console.error('[latest] app not initialized'); return; }

  const nowEl = document.getElementById('now');
  if (!nowEl) { console.error('[latest] #now missing'); return; }

  function renderBubble(e) {
    const id = G.asId(e.userId);
    const cfg = G.POSITION_CONFIG[id] || {};
    const displayName = e.name || cfg.name || '';
    const displaySide = e.side || cfg.side || 'left';
    const displayColor = e.color || cfg.color || '';

    nowEl.className = `bubble ${displaySide}`;
    nowEl.innerHTML = '';

    // 吹き出しの“しっぽ”位置（%）
    if (typeof cfg.x === 'number') {
      nowEl.style.setProperty('--tail-x', `${cfg.x}%`);
    } else {
      nowEl.style.setProperty('--tail-x', displaySide === 'right' ? '88%' : '12%');
    }

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = displayName;
    if (displayColor) name.style.color = displayColor;

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = e.text || '';
    text.style.fontSize = `${G.fontPx}px`;

    nowEl.appendChild(name);
    nowEl.appendChild(text);

    if (e.tr?.text) {
      const tr = document.createElement('div');
      tr.className = 'tr';
      tr.textContent = e.tr.text;
      nowEl.appendChild(tr);
    }
  }

  function onTranscript(payload) {
    const id = G.asId(payload.userId);
    G.ensureDeckAvatar({ ...payload, userId: id });
    G.setActive(id);

    nowEl.classList.remove('is-fading');
    renderBubble({ ...payload, userId: id });

    G.startFadeTimer(() => {
      nowEl.classList.add('is-fading');
    });
  }

  function onUpdate(upd) {
    const { id, tr } = upd || {};
    if (!id || !tr?.text) return;
    const trEl = nowEl.querySelector('.tr');
    if (trEl) trEl.textContent = tr.text;
    else {
      const el = document.createElement('div');
      el.className = 'tr';
      el.textContent = tr.text;
      nowEl.appendChild(el);
    }
    // フェード延長はしない（好みで呼び出してOK）
  }

  G.wireSocket({ onTranscript, onUpdate });
})();
