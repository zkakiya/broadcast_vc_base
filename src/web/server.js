import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { CONFIG } from '../config.js';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Express
const app = express();
const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: { origin: CONFIG.corsOrigin || '*' },
});

// 静的配信（OBS はこのURLをブラウザソースで開く）
const pubDir = path.join(__dirname, '../../public');
// ルートを先に握る（ index.html があっても確実に now.html を出す ）
app.get('/', (_, res) => res.redirect('/now.html'));
app.use(express.static(pubDir));

// ヘルスチェックなどはこのあとでOK
app.get('/healthz', (_, res) => res.send('ok'));

// 起動
export function startWebServer(port = CONFIG.webPort) {
  httpServer.listen(port, () => {
    console.log(`🌍 Subtitles page: http://localhost:${port}/`);
  });
}