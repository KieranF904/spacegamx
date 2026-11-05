// Netcode Lab server: the lab's authoritative world (labserver.js) at 60 Hz, its WebSocket at /ws, and the lab's page.
//   node server/server.js            then open http://localhost:3120/
//   PORT=3120 HOST=127.0.0.1 SEED=20261103   (defaults)
// The simulation files are the same ones the page loads (shared.js runs them here); nothing is built.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');
const NL = require('./shared');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3120;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_CLIENTS = 32;
const MAX_MSGS_PER_SEC = 600;

const lab = new NL.LabServer({ now: performance.now(), seed: Number(process.env.SEED) || 20261103 });
const TICK_MS = NL.LabServer.consts.TICK_MS;
const MAX_BOTS = 24;

// --------------------------------------------------------------------------------------------------- the page
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
const PAGES = new Set(['index.html', 'offline.html', 'sim.js', 'net.js', 'world.js', 'proto.js', 'labserver.js', 'labclient.js',
  'harness.js', 'lab.js', 'styles.js', 'app.js']);
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, tick: lab.W.tick, clients: [...lab.clients.values()].filter((c) => c.ready).length, bots: lab.bots.size, tickMs: lab.perf.ms }));
    return;
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!PAGES.has(name)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(ROOT, name), (err, body) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  });
});

// ------------------------------------------------------------------------------------------------- the socket
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: false });
wss.on('connection', (ws) => {
  if ([...lab.clients.values()].length >= MAX_CLIENTS) { ws.close(1013, 'full'); return; }
  const cid = lab.connect((buf) => { if (ws.readyState === 1) ws.send(buf, { binary: typeof buf !== 'string' }); });
  let n = 0, since = performance.now();
  ws.on('message', (data, isBinary) => {
    const now = performance.now();
    if (now - since > 1000) { since = now; n = 0; }
    if (++n > MAX_MSGS_PER_SEC) { ws.close(1008, 'too many messages'); return; }
    if (!isBinary) {
      const s = data.toString();
      // (bots are capped for the whole server, so one page can't fill the box)
      if (s.includes('"bots"') && lab.bots.size >= MAX_BOTS) return;
      lab.recv(cid, s, now);
    } else lab.recv(cid, new Uint8Array(data.buffer, data.byteOffset, data.byteLength), now);
  });
  ws.on('close', () => lab.disconnect(cid));
  ws.on('error', () => {});
});

// --------------------------------------------------------------------------------------------------- the clock
// Each tick runs when its time comes (start + n x 16.67 ms); the timer only wakes the loop, it doesn't set the pace.
function loop() {
  lab.update(performance.now());
  const next = lab.start + (lab.W.tick + 1) * TICK_MS;
  setTimeout(loop, Math.max(0, next - performance.now() - 0.5));
}
httpServer.listen(PORT, HOST, () => {
  console.log(`netcode lab on http://${HOST}:${PORT}/ (ws at /ws), seed ${lab.seed}`);
  loop();
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { wss.close(); httpServer.close(); process.exit(0); });
