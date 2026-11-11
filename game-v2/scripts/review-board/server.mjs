// Review board: Claude posts itemized questions and suggestions, Kieran answers them one by one on his phone.
//   npm run board            then open the printed http://<lan-ip>:5470/?k=<key> on the phone (same Wi-Fi)
// Claude's side is cli.mjs (post a batch, read new answers, archive). Data: review/board/board.json; the key: review/board/key.txt.
// Listens on every interface so the phone can reach it; the key in the link is the only gate, so keep it to the home network.
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { load, update, accessKey, now } from './store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.BOARD_PORT ?? 5470);
const key = accessKey();
const page = () => fs.readFileSync(path.join(here, 'index.html'), 'utf-8');

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 64_000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const k = url.searchParams.get('k') ?? req.headers['x-board-key'];
  if (k !== key) return send(res, 403, 'Open the link with its key (?k=...) printed by npm run board.', 'text/plain');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, page(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/board') return send(res, 200, load());
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const b = await readBody(req);
      const text = typeof b.text === 'string' ? b.text.slice(0, 8000) : '';
      const choice = typeof b.choice === 'string' ? b.choice.slice(0, 200) : '';
      const item = update((board) => {
        const it = board.items.find((i) => i.id === b.id);
        if (!it) return null;
        if (!text && !choice) delete it.answer;
        else it.answer = { ...(choice ? { choice } : {}), ...(text ? { text } : {}), at: now() };
        delete it.seen;
        return it;
      });
      return item ? send(res, 200, item) : send(res, 404, { error: 'no such item' });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 400, { error: String(e.message ?? e) });
  }
});

server.listen(port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log('Review board up. On your phone (same network):');
  for (const ip of ips) console.log(`  http://${ip}:${port}/?k=${key}`);
  console.log(`  (this PC: http://localhost:${port}/?k=${key})`);
});
