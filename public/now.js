(() => {
  const socket = io();
  const nowEl = document.getElementById('now');
  const q = new URLSearchParams(location.search);

  const font = Number(q.get('font') || 36);
  const pfpMode = (q.get('pfp') || 'none');   // いまは none 運用
  const pfpSize = Number(q.get('avatar') || 64);
  const fadeSec = Number(q.get('fade') || 30); // ← フェード開始までの秒数（既定30）

  let fadeTimer = null;

  function startFadeTimer() {
    // 既存タイマーがあればクリア
    if (fadeTimer) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    // フェードクラスを外してから、fadeSec 後に付け直す
    nowEl.classList.remove('is-fading');
    if (fadeSec > 0) {
      fadeTimer = setTimeout(() => {
        nowEl.classList.add('is-fading');
      }, fadeSec * 1000);
    }
  }

  function render(e){
    nowEl.className = `bubble ${e.side || 'left'}`;
    nowEl.innerHTML = '';

    // アイコンは現在OFFだが、将来のために残しておく（pfp=none なら描画されない）
    const src = pfpMode === 'icon' ? (e.icon||e.avatar)
              : pfpMode === 'avatar' ? (e.avatar||e.icon) : null;
    if (src && pfpSize > 0) {
      const img = document.createElement('img');
      img.className = 'pfp';
      img.src = src; img.alt = e.name || 'speaker';
      img.width = pfpSize; img.height = pfpSize;
      img.decoding = 'async'; img.loading = 'lazy';
      nowEl.appendChild(img);
    }

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

    // 新しい発話が来たらフェードタイマーをリセットして再スタート
    startFadeTimer();
  }

  socket.on('transcript', render);

  // 任意: 手動でリセットしたい場合（例: 'r' キーで再表示）
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r') {
      nowEl.classList.remove('is-fading');
      startFadeTimer();
    }
  });
})();
