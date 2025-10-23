// 必要に応じて .env からでもOK。とりあえず固定テーブル例。
export const SPEAKERS = {
  '272380840434991104': {
    name: 'カキヤ',
    side: 'right',
    color: '#ffc955ff',
    avatar: '/avatars/kakiya_still.png', // ← ここを立ち絵に
    icon:   '/avatars/timeline/icon_kakiya.webp', // タイムライン用軽量（小さめ・WebP推奨）
    lang: 'ja',
  },
  '463714335596740638': {
    name: 'ヨネダ',
    side: 'left',
    color: '#a4ff55ff',
    avatar: '/avatars/yoneda_still.png', // ← ここを立ち絵に
    icon:   '/avatars/timeline/icon_yoneda.webp', // タイムライン用軽量（小さめ・WebP推奨）
    lang: 'ja',
  },
  '682709913335890031': {
    name: 'Haracternick',
    side: 'left',
    color: '#426effff',
    avatar: '/avatars/haracternick_still.png', // ← ここを立ち絵に
    icon:   '/avatars/timeline/icon_haracternick.webp', // タイムライン用軽量（小さめ・WebP推奨）
    lang: 'en',
  },
  // ...他の話者
};

// 未登録ユーザーのフォールバック
export function getSpeaker(userId) {
  return SPEAKERS[userId] || {
    name: `User ${userId.slice(-4)}`,
    side: 'left',
    color: '#bdc3c7',
    avatar: '/avatars/default.png',
    lang: 'ja',
  };
}

export function getSpeakerConfig(userId) {
  return SPEAKERS.get(userId) || null;
}
