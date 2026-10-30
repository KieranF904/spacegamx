// The VPS's resource use, live, on this PC (deploy/vps/monitor sets up the other end):
//   node scripts/vpsmon/server.mjs        (or: npm run monitor)
// Streams the box's stats over SSH as the locked-down `vpsmon` account (its own key, ~/.ssh/vpsmon_ed25519: it can only
// read stats), and serves the dashboard to this machine alone: on 127.0.0.1, its stats behind a token made fresh each run
// (in the URL it opens), answering only requests addressed to it (no other site can reach it through the browser).
import { createServer } from 'http';
import { spawn, exec } from 'child_process';
import { randomBytes, timingSafeEqual } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VPSMON_PORT ?? 8971);
const HOST = process.env.VPSMON_HOST ?? 'brotherk3d.com';
const KEY = process.env.VPSMON_KEY ?? join(homedir(), '.ssh', 'vpsmon_ed25519');
/** Ten minutes of samples kept (one a second), so the page opens with history */
const KEEP = 600;
const TOKEN = randomBytes(24).toString('hex');

if (!existsSync(KEY)) { console.error(`No monitor key at ${KEY} (see deploy/vps/monitor/setup.sh)`); process.exit(1); }

const history = [];
const clients = new Set();
let status = { connected: false, since: Date.now(), error: '' };
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => { for (const c of clients) send(c, event, data); };
const setStatus = (s) => { status = { ...status, ...s, since: Date.now() }; broadcast('status', status); };

// ---- The stream from the box: reconnecting, backing off while it can't ----
let ssh = null, backoff = 2000, quitting = false;
function connect() {
  ssh = spawn('ssh', ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10', '-T', `vpsmon@${HOST}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buf = '', err = '';
  ssh.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let s;
      try { s = JSON.parse(line); } catch { continue; }
      if (!status.connected) { setStatus({ connected: true, error: '' }); backoff = 2000; }
      history.push(s);
      if (history.length > KEEP) history.shift();
      broadcast('sample', s);
    }
  });
  ssh.stderr.on('data', (d) => { err = (err + d).slice(-400); });
  ssh.on('close', () => {
    ssh = null;
    if (quitting) return;
    setStatus({ connected: false, error: err.trim().split('\n').pop() || 'connection closed' });
    setTimeout(connect, backoff);
    backoff = Math.min(30000, backoff * 2);
  });
}

// ---- The page, to this machine only ----
const tokenOk = (got) => {
  const a = Buffer.from(String(got ?? '')), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};
const FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const SECURITY = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
};
const server = createServer((req, res) => {
  // Only requests addressed to this machine by its own address (a site can't point a name of its own at it: rebinding)
  const host = req.headers.host ?? '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(421).end(); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (url.pathname === '/events') {
    // (the stats themselves: only with this run's token)
    if (!tokenOk(url.searchParams.get('k'))) { res.writeHead(403, SECURITY).end('Open the link the monitor printed when it started.'); return; }
    res.writeHead(200, { ...SECURITY, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    send(res, 'history', history);
    send(res, 'status', status);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clients.delete(res); clearInterval(ping); });
    return;
  }
  const f = FILES[url.pathname];
  if (!f) { res.writeHead(404, SECURITY).end(); return; }
  res.writeHead(200, { ...SECURITY, 'Content-Type': f[1] });
  res.end(readFileSync(join(HERE, f[0])));
});
server.listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}/?k=${TOKEN}`;
  console.log(`VPS monitor: ${link}`);
  connect();
  if (!process.env.VPSMON_NO_OPEN) {
    const open = process.platform === 'win32' ? `start "" "${link}"` : process.platform === 'darwin' ? `open "${link}"` : `xdg-open "${link}"`;
    exec(open, { windowsHide: true });
  }
});
const quit = () => { quitting = true; ssh?.kill(); server.close(); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
