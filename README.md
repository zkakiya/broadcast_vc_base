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

## アーキテクチャ

本プロジェクトは「Discord VC → Whisper → 翻訳 → OBSブラウザ表示」を行う配信用システムです。  
Node.js（メイン処理）＋ Python（ASRワーカー）で構成されています。

---

### 1. 実行スクリプト & 主要依存

**起動スクリプト**
| モード | コマンド |
|:--|:--|
| 開発（共通） | `npm run dev` → `NODE_ENV=development node src/index.js` |
| 本番 | `npm start` → `NODE_ENV=production node src/index.js` |
| マルチVCモード | `npm run dev:multi` → `.env.shared + .env.multi` |
| ソロ入力モード | `npm run dev:solo` → `.env.shared + .env.solo` |

**主要依存**
- Discord連携：`discord.js`, `@discordjs/voice`, `@discordjs/opus`
- 音声処理：`prism-media`, `wav`
- Web/配信：`express`, `socket.io`, `ws`
- 環境・補助：`dotenv`, `dotenv-cli`, `chokidar`

---

### 2. ディレクトリ構成

```
src/
  index.js                 # エントリポイント（環境読込 → Discord & Web起動）
  env/load.js              # .env 群ロード
  web/server.js            # Express + Socket.IO 配信サーバ
  discord/
    client.js              # Discordクライアント
    voice.js               # VC音声受信 (Opus→PCM→WAV)
  core/
    transcribe.js          # ASR制御 (faster-whisper 呼出)
    fw_worker.py           # Whisperワーカー (GPU対応)
    fw_runner.py           # Pythonランナー
    asr/worker.js          # Nodeワーカー (ASRキュー)
    schema.js, log.js
  utils/
    translate.js           # 翻訳API呼出
    dictionary.js          # 辞書適用（人名保護等）
    text_sanitize.js       # 正規化処理
    limiter.js, logger.js
  registry/speakers.js     # 話者メタ管理
  solo/                    # ソロ入力モード
public/
  timeline.html/.js/.css   # タイムライン表示
  latest.html/.js/.css     # 最新発言表示（アバター固定）
  now.html/.js/.css        # 軽量表示
  avatars/                 # アバター素材
  css/                     # スキン・共通スタイル
  position.config.json     # 配置設定
apps/
  .env.shared / .env.multi / .env.solo / .env.example
  dictionary.json          # 人名辞書
```

---

### 3. モード構成 (.env)

| ファイル | 役割 |
|:--|:--|
| `.env` | ルート共通 |
| `apps/.env.shared` | 共通設定（Discord Token 等） |
| `apps/.env.multi` | マルチVCモード |
| `apps/.env.solo` | 単体テストモード |

例：
```bash
MODE=multi
WHISPER_IMPL=faster
WHISPER_MODEL=small
FASTER_WHISPER_DEVICE=cuda
FW_COMPUTE_TYPE=float16
WHISPER_LANG=ja
FW_WORKER=1
ASR_HINTS=ディスコード, OBS, レイテンシ
ASR_DICT_APPLY_TR=1
TRANS_TRANSLATE_THROTTLE_MS=800
```

---

### 4. データフロー概要

1. **音声入力**：`discord/voice.js`  
   Discord VCからユーザー別に音声を受信し、Opus → PCM → WAV に変換。

2. **ASR処理**：`core/transcribe.js`  
   Node側で音声をPythonワーカー（`fw_worker.py`）に送信。  
   `faster-whisper` をGPUで実行し、テキストを返す。

3. **正規化・辞書置換**：`utils/text_sanitize.js`, `utils/dictionary.js`  
   日本語特有の表記ゆれ、人名のマスキング、敬称処理を行う。

4. **翻訳**：`utils/translate.js`  
   Google Translate API等で翻訳（今後DeepL/Azure切替対応予定）。

5. **配信**：`web/server.js`  
   Socket.IOで`public/`ブラウザへ送信。  
   `timeline.html`, `latest.html`, `now.html`がそれぞれOBS向けUIを表示。

---

### 5. 出力UI構成

| ページ | 内容 |
|:--|:--|
| `timeline.html` | 発話履歴を縦リスト表示。ログ／字幕用途。 |
| `latest.html` | 最新発言＋アバター固定。左右配置＋フェード表示。 |
| `now.html` | 最小限UI（発話中のみ簡易表示）。 |
| `position.config.json` | 各アバター位置・話者マッピング。 |

---

### 6. Whisper & GPU構成

- `faster-whisper` をPythonワーカーとして常駐。  
- `FW_WORKER=1` で単一ワーカー（将来的に並列化対応）。  
- CUDA検出後、`torch 2.5.x + cu121` を想定。  
- Nodeから`child_process`または`worker_threads`でジョブキュー管理。

---

### 7. 特徴・運用ポイント

- モード切替（multi / solo）により Discord VC・単体録音の両対応。
- `apps/dictionary.json` に敬称あり/なし両対応の人名辞書。
- ASR → 翻訳間の遅延：平均0.8〜1.2秒（GPU環境時）。
- `timeline.js` ではID単位マージ＋欠落防止ロジック済み。
- `.env`に`ASR_HINTS`を指定可能（ホットワード強化）。

---

### 8. 次フェーズ予定

- 翻訳APIアダプタ化（DeepL / Azure対応）
- latest UI強化（固定配置 + フェードアウト）
- Whisperモデル自動切替（small / medium）
- PM2またはDockerによる永続運用
- `/healthz` APIによる稼働監視

---

（以上）

© 2025 zkakiya / Broadcast VC Base
