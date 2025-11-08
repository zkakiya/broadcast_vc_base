// src/web/server.js
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { CFG } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express
const app = express();
const httpServer = createServer(app);

// Socket.IO
export const io = new SocketIOServer(httpServer, {
  cors: { origin: CFG.corsOrigin || '*' },
});

io.on('connection', (sock) => {
  console.log('[ws] connected', sock.id);
  sock.on('disconnect', (r) => console.log('[ws] disconnected', sock.id, r));
});

// 静的ファイルの配信（例: now.html）
const pubDir = path.join(__dirname, '../../public');
app.get('/', (_, res) => res.redirect('/now.html'));
app.use(express.static(pubDir));

// ヘルスチェックエンドポイント
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    mode: CFG.mode,
    http: { port: CFG.port, wsPort: CFG.wsPort },
    asr: { impl: CFG.asr.impl, model: CFG.asr.model, device: CFG.asr.device },
    translate: { provider: CFG.translate.provider },
  });
});

// 起動関数（⚠️ io を返すように変更）
export function startWebServer(port = CFG.port) {
  httpServer.listen(port, () => {
    console.log(`🌍 Subtitles page: http://localhost:${port}/`);
  });
  return io;
}

app.use(express.static(pubDir, {
  maxAge: '7d',
  etag: true,
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));