// public/latest.js
(() => {
  const G = window.BVC;
  if (!G) {
    console.error('[latest] app not initialized');
    return;
  }

  const nowEl = document.getElementById('now');
  if (!nowEl) {
    console.error('[latest] #now missing');
    return;
  }

  // 直近の確定発話があるかどうかだけを持つ（id は使わない）
  let hasCurrent = false;

  function renderBubble(e) {
    const id = G.asId(e.userId ?? e.user);
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
      nowEl.style.setProperty(
        '--tail-x',
        displaySide === 'right' ? '88%' : '12%'
      );
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
  }

  // ---- 確定テキスト ----
  function onTranscript(payload) {
    const id = G.asId(payload.userId ?? payload.user);

    // アバター側を更新
    G.ensureDeckAvatar({ ...payload, userId: id });
    G.setActive(id);

    hasCurrent = true;

    nowEl.classList.remove('is-fading');
    renderBubble({ ...payload, userId: id });

    // 一定時間後にフェード
    G.startFadeTimer(() => {
      nowEl.classList.add('is-fading');
    });
  }

  // ---- 訳の更新 ----
  function onUpdate(upd) {
    // このブランチでは「訳専用」として扱う
    if (!upd || !upd.tr || typeof upd.tr.text !== 'string') return;
    if (!hasCurrent) return; // まだ何も表示していないときは無視

    let trEl = nowEl.querySelector('.tr');
    if (!trEl) {
      trEl = document.createElement('div');
      trEl.className = 'tr';
      nowEl.appendChild(trEl);
    }
    trEl.textContent = upd.tr.text;
  }

  // 今回はストリーミング ASR を使わないので onPartial は渡さない
  G.wireSocket({ onTranscript, onUpdate });
})();
