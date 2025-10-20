import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express
const app = express();
const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
});

// 静的配信（OBS はこのURLをブラウザソースで開く）
const pubDir = path.join(__dirname, '../../public');
app.use(express.static(pubDir));

// ヘルスチェック
app.get('/healthz', (_, res) => res.send('ok'));

// 起動
export function startWebServer(port = process.env.WEB_PORT || 3000) {
  httpServer.listen(port, () => {
    console.log(`🌍 Subtitles page: http://localhost:${port}/`);
  });
}

// すでにある静的配信のままでOK
// 任意：トップを「最新発言」へリダイレクト
app.get('/', (_, res) => res.redirect('/now.html'));