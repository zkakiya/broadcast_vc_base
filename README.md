# Broadcast VC Base

Discord VC（ボイスチャット）を自動文字起こしし、OBSブラウザソースに字幕として送出する Node.js アプリ。  
Whisper による日本語音声認識＋OpenAI API による翻訳を行い、Discord テキストチャンネルにも同時投稿します。

---

## 🔧 構成概要

project-root/
├── .env                 # 各種トークンや設定値
├── public/              # ブラウザ用UI (OBSブラウザソース)
│   ├── now.html/.js/.css     # 最新発言画面
│   ├── timeline.html/.js/.css # 発言タイムライン
│   └── avatars/              # 各話者の固定アバター画像
└── src/
    ├── discord/
    │   ├── client.js         # Discordクライアント接続
    │   ├── voice.js          # 音声取得・Whisper→翻訳→送出の中核
    │   └── transcribe.js     # Whisper (Python) 呼び出し
    ├── registry/speakers.js  # 各話者の設定（表示位置・色・翻訳先など）
    ├── utils/
    │   ├── cleanup.js        # recordings フォルダ自動掃除
    │   └── translate.js      # 翻訳API呼び出し
    ├── web/server.js         # Express + Socket.IO サーバ
    ├── index.js              # エントリポイント
    └── config.js             # 環境変数の整理

---

## ⚙️ セットアップ

1. リポジトリを取得
   ```bash
   git clone https://github.com/zkakiya/broadcast_vc_base.git
   cd broadcast_vc_base
   npm install
   ```

2. Python Whisper をセットアップ
   ```bash
   python3 -m venv ~/whisper-venv
   source ~/whisper-venv/bin/activate
   pip install git+https://github.com/openai/whisper.git
   ```

3. `.env` を作成（`.env.sample` を参考に）
   ```bash
   cp .env.sample .env
   nano .env
   ```

主な環境変数:
```env
# Discord
DISCORD_TOKEN=xxxx
GUILD_ID=xxxx
VOICE_CHANNEL_ID=xxxx
TEXT_CHANNEL_ID=xxxx

# Whisper
WHISPER_PY=/home/user/whisper-venv/bin/python
WHISPER_MODEL=small
VAD_SILENCE_MS=600
MIN_WAV_BYTES=48000

# 翻訳（OpenAI API）
TRANSLATE_ENABLED=1
OPENAI_API_KEY=sk-xxxx
TRANSLATE_TARGET_DEFAULT=en

# Webサーバ
PORT=3000

# ログ制御
LOG_LEVEL=info
SHORT_WAV_LOG=0
VOICE_DEBUG=0
```

---

## ▶️ 実行

```bash
npm run dev     # 開発モード（ログ詳細）
npm run start   # 本番モード（ログ抑制）
```

起動すると：
- Discord に BOT がログイン
- ボイスチャンネルに自動参加
- Whisper が音声をテキスト化し、OBS ページ（http://localhost:3000/）に字幕を送信
- 翻訳は非同期で追記（Discord 側はメッセージ編集で訳を追記）

---

## 💬 OBS 統合

1. OBS の「ブラウザソース」で以下のURLを追加：
   ```
   http://localhost:3000/now.html
   ```

2. CSS (`now.css`) で各話者の位置・マスク・サイズを設定：
   ```js
   const POSITION_CONFIG = {
     kakiya:  { side:'left',  scale:0.8, mask:'masks/oval.png' },
     yoneda:  { side:'right', scale:1.0, mask:'masks/star.png' },
   };
   ```

3. アクティブ発言中はアバターが明るく・彩度アップ、非発言中は暗め・半透明。

---

## 🌐 翻訳機能

- Whisper の出力を translateText() に通して OpenAI API で翻訳
- UI（OBS字幕）と Discord メッセージの両方に翻訳結果を追記
- 翻訳を止めたい場合は `.env` で
  ```
  TRANSLATE_ENABLED=0
  ```

---

## 🧹 クリーンアップ

起動時に `src/recordings/` 内の WAV を自動削除。  
`SHORT_WAV_LOG=0` で短尺スキップのログを非表示にできます。

---

## 🪶 ログレベル制御

| 環境変数 | 内容 |
|-----------|-------|
| LOG_LEVEL=debug | 詳細ログ |
| LOG_LEVEL=info  | 通常 |
| LOG_LEVEL=warn  | 警告以上のみ |
| VOICE_DEBUG=1   | VoiceStateの詳細遷移ログを有効 |
| SHORT_WAV_LOG=0 | 短尺スキップを非表示 |

---

## 🧭 今後の拡張予定

- 翻訳APIの切替（DeepL / Libre）
- OBS UI のテーマ切替（暗/明）
- タイムライン画面のフィルタリング
- Whisper バックエンドを Node 側に統合

---

© 2025 zkakiya / Broadcast VC Base
