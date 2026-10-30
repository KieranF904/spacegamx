// The render daemon: one headless Chrome kept open on the asset viewer (client/viewer.html?ui=0), and a local API that
// renders through it. The viewer page does the drawing; this drives it and reads the canvas back.
//   npm run render-daemon                      (or let `npm run render` start it)
//   GET  /render?asset=ship:sparrow-t&zoom=2&flames=0.8&scale=2   → image/png (any viewer param; w, h: canvas size)
//   GET  /ui?asset=...&w=1600&h=1000                              → image/png of the whole viewer page, panels and all
//   GET  /assets?q=laser                                          → [{ id, label, group }]
//   GET  /status                                                  → { pid, chromePid, vitePid, base, renders, logs }
//   GET  /tab  → { id, ws }: a tab of this Chrome lent for a live game shot (one at a time, others wait); /tab/close?id= returns it
//   POST /shutdown                                                → stops (Chrome, and its own Vite if it started one)
// 127.0.0.1 only. Uses the dev server on 5273 if it's up, else starts its own frozen one (vite.render.config.ts, port
// RENDER_VITE_PORT=5299); RENDER_VITE=own always starts its own. Port RENDER_PORT (5281). Quits after RENDER_IDLE_MIN (default 2)
// minutes unused (never while a tab is lent). Its state (pids, port) is in <tmp>/space-render-daemon[-<port>].json.
import { createServer } from 'http';
import { spawn } from 'child_process';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { launch, kill } from './cdp.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const client = resolve(here, '../../client');
const PORT = Number(process.env.RENDER_PORT ?? 5281);
const VITE_PORT = Number(process.env.RENDER_VITE_PORT ?? 5299);
// (2 min: a batch keeps it warm; it mustn't sit on Kieran's machine between uses)
const IDLE_MS = Number(process.env.RENDER_IDLE_MIN ?? 2) * 60000;
export const STATE = join(tmpdir(), `space-render-daemon${PORT === 5281 ? '' : `-${PORT}`}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const up = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; } };

// Already running?
if (existsSync(STATE)) {
  try {
    const s = JSON.parse(readFileSync(STATE, 'utf8'));
    if (await up(`http://127.0.0.1:${s.port}/status`)) { log(`already running: pid ${s.pid} on 127.0.0.1:${s.port}`); process.exit(0); }
  } catch {}
}

// The dev server: 5273's, or our own frozen one
let vite = null, base = null;
if (process.env.RENDER_VITE !== 'own' && await up('http://localhost:5273/viewer.html')) base = 'http://localhost:5273';
else {
  log(`starting own Vite on ${VITE_PORT}`);
  vite = spawn(process.execPath, [join(client, 'node_modules/vite/bin/vite.js'), '--config', join(here, 'vite.render.config.ts')], { cwd: client, stdio: 'ignore', env: { ...process.env, RENDER_VITE_PORT: String(VITE_PORT) } });
  base = `http://127.0.0.1:${VITE_PORT}`;
  for (let i = 0; i < 120 && !(await up(`${base}/viewer.html`)); i++) await sleep(500);
  if (!(await up(`${base}/viewer.html`))) { kill(vite.pid); throw new Error('own Vite did not come up'); }
}
log(`viewer at ${base}/viewer.html`);

const page = await launch({ width: 1600, height: 1000 });
let renders = 0, last = Date.now(), closing = false;

// Live game shots (boss-shots/shoot.mjs) borrow a tab in this Chrome rather than start their own: one at a time, the rest
// wait their turn, so there is only ever this one browser. A lease nobody returns is taken back after LEASE_MS.
const LEASE_MS = 20 * 60000;
let lease = null, leaseQueue = Promise.resolve();
const cdp = (path, method = 'GET') => fetch(`http://127.0.0.1:${page.port}${path}`, { method }).then((r) => r.json());
async function lend() {
  let release;
  const turn = leaseQueue;
  leaseQueue = new Promise((r) => (release = r));
  await turn;
  const tab = await cdp('/json/new?about:blank', 'PUT');
  lease = { id: tab.id, release, timer: setTimeout(() => giveBack(tab.id), LEASE_MS) };
  return tab;
}
async function giveBack(id) {
  if (!lease || lease.id !== id) return false;
  clearTimeout(lease.timer);
  const { release } = lease;
  lease = null;
  try { await fetch(`http://127.0.0.1:${page.port}/json/close/${id}`); } catch {}
  release();
  last = Date.now();
  return true;
}

/** The page open on the viewer, its handle ready (after a reload too: 5273's HMR may reload it) */
async function open(query = 'ui=0') {
  await navigate(`${base}/viewer.html?${query}`);
}
/** Load a page and wait for the new viewer (not the old page's, still there until the new one replaces it) */
async function navigate(url) {
  try { await page.evaluate('window.__leaving = true'); } catch {}
  await page.send('Page.navigate', { url });
  await viewerReady();
}
async function viewerReady(timeout = 60000) {
  const t0 = Date.now();
  for (;;) {
    try { if (await page.evaluate('!window.__leaving && !!window.__viewer && window.__viewer.ready.then(() => true)', 20000)) return; } catch {}
    if (Date.now() - t0 > timeout) throw new Error('viewer did not load: ' + page.logs.slice(-5).join(' | '));
    await sleep(250);
  }
}
await open();
log('viewer ready');

// One shot at a time
let queue = Promise.resolve();
const serial = (fn) => { const r = queue.then(fn, fn); queue = r.catch(() => {}); return r; };

async function render(query) {
  const q = new URLSearchParams(query);
  q.set('ui', '0');
  if (!q.has('w')) q.set('w', '1280');
  if (!q.has('h')) q.set('h', '800');
  const w = Number(q.get('w')), h = Number(q.get('h'));
  await page.send('Emulation.setDeviceMetricsOverride', { width: Math.max(w, 320), height: Math.max(h, 240), deviceScaleFactor: 1, mobile: false });
  const call = `window.__viewer.render(${JSON.stringify(q.toString())})`;
  let r;
  try { await viewerReady(); r = await page.evaluate(call); }
  catch (e) { log('render failed, reloading the viewer:', e.message); await open(); r = await page.evaluate(call); }
  return r;
}

async function uiShot(query) {
  const q = new URLSearchParams(query);
  const w = Number(q.get('w') ?? 1600), h = Number(q.get('h') ?? 1000);
  q.delete('w'); q.delete('h'); q.set('ui', '1');
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await navigate(`${base}/viewer.html?${q}`);
  await page.evaluate(`window.__viewer.show(${JSON.stringify(q.toString())})`);
  await sleep(600);
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  await open();
  return Buffer.from(shot.data, 'base64');
}

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  log('shutting down');
  page.close();
  if (vite) kill(vite.pid);
  try { if (JSON.parse(readFileSync(STATE, 'utf8')).pid === process.pid) rmSync(STATE); } catch {}
  setTimeout(() => process.exit(code), 300);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  last = Date.now();
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body, null, 1)); };
  try {
    if (url.pathname === '/status') return json(200, { pid: process.pid, chromePid: page.proc.pid, vitePid: vite?.pid ?? null, base, port: PORT, renders, logs: page.logs.slice(-20) });
    if (url.pathname === '/shutdown') { json(200, { ok: true }); return shutdown(0); }
    if (url.pathname === '/tab') { const t = await lend(); log(`lent tab ${t.id}`); return json(200, { id: t.id, ws: t.webSocketDebuggerUrl }); }
    if (url.pathname === '/tab/close') { const ok = await giveBack(url.searchParams.get('id')); log(`tab back ${url.searchParams.get('id')}`); return json(200, { ok }); }
    if (url.pathname === '/assets') return json(200, await serial(() => page.evaluate(`window.__viewer.assets(${JSON.stringify(url.searchParams.get('q') ?? '')})`)));
    if (url.pathname === '/render') {
      const t0 = Date.now();
      const r = await serial(() => render(url.search.slice(1)));
      renders++;
      const png = Buffer.from(r.png.slice(r.png.indexOf(',') + 1), 'base64');
      log(`render ${url.searchParams.get('asset') ?? ''} ${r.w}×${r.h} in ${Date.now() - t0} ms${r.settled ? '' : ' (not settled)'} · ${r.info}`);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'X-Viewer-Info': encodeURIComponent(r.info), 'X-Viewer-Settled': String(r.settled) });
      return res.end(png);
    }
    if (url.pathname === '/ui') {
      const png = await serial(() => uiShot(url.search.slice(1)));
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
      return res.end(png);
    }
    json(404, { error: 'GET /render?asset=…, /ui, /assets?q=, /tab, /tab/close?id=, /status; POST /shutdown' });
  } catch (e) {
    json(500, { error: String(e?.message ?? e), logs: page.logs.slice(-10) });
  }
});
server.on('error', (e) => { log('server error', e.message); shutdown(1); });
server.listen(PORT, '127.0.0.1', () => {
  writeFileSync(STATE, JSON.stringify({ pid: process.pid, port: PORT, chromePid: page.proc.pid, vitePid: vite?.pid ?? null, base }));
  log(`render daemon pid ${process.pid} on http://127.0.0.1:${PORT} (Chrome pid ${page.proc.pid}${vite ? `, own Vite pid ${vite.pid}` : ''})`);
});
setInterval(() => { if (!lease && Date.now() - last > IDLE_MS) { log('idle'); shutdown(0); } }, 30000).unref();
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => shutdown(0));
process.on('exit', () => { if (!closing) { page.close(); if (vite) kill(vite.pid); } });
