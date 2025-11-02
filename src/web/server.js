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
export const io = new SocketIOServer(httpServer, {
  cors: { origin: CFG.corsOrigin || '*' },
});

// 静的配信（OBS はこのURLをブラウザソースで開く）
const pubDir = path.join(__dirname, '../../public');
// ルートを先に握る（ index.html があっても確実に now.html を出す ）
app.get('/', (_, res) => res.redirect('/now.html'));
app.use(express.static(pubDir));

// ヘルスチェック
app.get('/healthz', async (_req, res) => {
  res.json({
    ok: true,
    mode: CFG.mode,
    http: { port: CFG.port, wsPort: CFG.wsPort },
    asr: { impl: CFG.asr.impl, model: CFG.asr.model, device: CFG.asr.device },
    translate: { provider: CFG.translate.provider },
  });
});
// 起動
export function startWebServer(port = CFG.port) {
  httpServer.listen(port, () => {
    console.log(`🌍 Subtitles page: http://localhost:${port}/`);
  });
}