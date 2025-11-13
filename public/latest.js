// public/latest.js
(() => {
  const G = window.BVC;
  if (!G) { console.error('[latest] app not initialized'); return; }

  const nowEl = document.getElementById('now');
  if (!nowEl) { console.error('[latest] #now missing'); return; }

  // いま画面に出している発話（セグメント）の baseId / userId
  let currentBaseId = null;
  let currentUserId = null;

  // baseId ごとの「これまでの途中経過テキスト」
  const partialBuffer = Object.create(null);

  function renderBubble(e) {
    const id = G.asId(e.userId ?? e.user ?? currentUserId);
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

  // 共通：バブル表示＋アバター更新＋フェードタイマー
  function showBubble(payload) {
    const id = G.asId(payload.userId ?? payload.user ?? currentUserId);
    currentUserId = id;

    // デッキ上のアバター状態更新
    G.ensureDeckAvatar({ ...payload, userId: id });
    G.setActive(id);

    nowEl.classList.remove('is-fading');
    renderBubble({ ...payload, userId: id });

    // 一定時間後にフェード
    G.startFadeTimer(() => {
      nowEl.classList.add('is-fading');
    });
  }

  // Whisper確定（transcript / transcript_final）
  function onTranscript(payload) {
    const baseId = payload.id || payload.baseId || null;
    currentBaseId = baseId;

    // 確定時点でバッファも上書き
    if (baseId) {
      partialBuffer[baseId] = payload.text || '';
    }

    showBubble(payload);
  }

  // パーシャル（transcript_update / transcript_partial）
  function onPartial(p) {
    if (!p || !p.baseId) return;

    const baseId = p.baseId;

    // まだ確定が来ていない場合は、最初の partial の baseId を採用
    if (!currentBaseId) {
      currentBaseId = baseId;
    }
    // 現在表示中とは別の発話IDなら無視（古いセグメント）
    if (baseId !== currentBaseId) return;

    const incoming = (p.text || '').trim();
    if (!incoming) return;

    let prev = partialBuffer[baseId] || '';

    if (!prev) {
      // まだ何もない → そのまま採用
      prev = incoming;
    } else if (incoming.startsWith(prev)) {
      // Whisper が「前回＋続きを全部言い直した」パターン
      // → 新しいほうが長いので入れ替え
      prev = incoming;
    } else if (!prev.includes(incoming)) {
      // 全く別の断片が来た場合は後ろに足す
      // （句読点があればスペース無し、それ以外はスペース挟むなど適当に）
      const sep = /[。、]$/.test(prev) ? '' : ' ';
      prev = `${prev}${sep}${incoming}`;
    }
    // それ以外（完全重複など）は prev のまま

    partialBuffer[baseId] = prev;

    // 積み上がった全文で描画
    showBubble({ ...p, text: prev });
  }

  // 訳の更新（translation_update）
  function onUpdate(upd) {
    const { id, tr } = upd || {};
    if (!id || id !== currentBaseId) return;
    if (!tr?.text) return;

    const trEl = nowEl.querySelector('.tr');
    if (trEl) {
      trEl.textContent = tr.text;
    } else {
      const el = document.createElement('div');
      el.className = 'tr';
      el.textContent = tr.text;
      nowEl.appendChild(el);
    }
    // フェード延長はしない（必要ならここで startFadeTimer を呼ぶ）
  }

  // ソケット配線
  G.wireSocket({ onTranscript, onPartial, onUpdate });
})();
