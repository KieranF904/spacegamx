/**
 * The native asset renderer: one warm service, an asset id in, a PNG out, no browser.
 *
 *   node node_modules/vite-node/vite-node.mjs -c scripts/native-render/vite.config.ts scripts/native-render/service.ts
 *   (or: node scripts/native-render/render.mjs --start)
 *
 * This process (Node) builds the asset's geometry with the game's own code (scene.ts) and keeps a Python child
 * (gl_worker.py: moderngl, a standalone GL context on the real GPU) that draws it with the game's hull shader.
 *
 *   GET /render?asset=ship:sparrow-t&zoom=fit&light=sun&bg=transparent&w=1280&h=800&scale=1&angle=0&aim=...  → PNG
 *       (the viewer's params: client/src/viewer/params.ts; timings in X-Render-* headers)
 *   GET /assets?q=word word   → JSON: the browse list (ids as above), filtered
 *   GET /health               → JSON: pids, uptime, renders, timings
 *   GET /                     → the viewer page (ui.html: displays /render's PNGs, draws nothing itself)
 *   POST /quit                → stops it (and its GL worker)
 *
 * Its port: NATIVE_RENDER_PORT, default 5311; 127.0.0.1 only. Both processes run at below-normal priority; it quits after 60 idle minutes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { constants, setPriority } from 'os';
import { SHADERS, TABLES, atlas, loadData, parseParams, scene, searchAssets, type Draw } from './scene';
import { SKY_SHADERS, skyNoise } from './sky';

const T0 = performance.now();
const PORT = Number(process.env.NATIVE_RENDER_PORT ?? 5311);
// (pythonw: no console window of its own, so no conhost beside it; PYTHON overrides)
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'pythonw' : 'python3');
try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* (not allowed: carry on) */ }

// ---- the GL worker: messages framed as u32 length + JSON, u32 length + payload

class GlWorker {
  proc: ChildProcessWithoutNullStreams;
  private waiting: ((m: { h: any; payload: Buffer }) => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor() {
    this.proc = spawn(PYTHON, ['-u', join(__dirname, 'gl_worker.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    try { setPriority(this.proc.pid!, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* */ }
    this.proc.stdout.on('data', (d: Buffer) => { this.chunks.push(d); this.have += d.length; this.drain(); });
    this.proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[gl] ${d}`));
    this.proc.on('exit', (code) => { console.error(`[native-render] GL worker exited (${code})`); process.exit(1); });
  }

  /** Chunks of what the worker has sent, joined only once a whole message could be there (a 4 MB PNG arrives in 64 KB pieces) */
  private chunks: Buffer[] = [];
  private have = 0;
  private need = 4;

  private drain(): void {
    while (this.have >= this.need) {
      const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
      this.chunks = [buf];
      const hl = buf.readUInt32LE(0);
      if (buf.length < 8 + hl) { this.need = 8 + hl; return; }
      const pl = buf.readUInt32LE(4 + hl), total = 8 + hl + pl;
      if (buf.length < total) { this.need = total; return; }
      const h = JSON.parse(buf.subarray(4, 4 + hl).toString('utf8'));
      const payload = Buffer.from(buf.subarray(8 + hl, total));
      const restBuf = buf.subarray(total);
      this.chunks = restBuf.length ? [restBuf] : [];
      this.have = restBuf.length;
      this.need = 4;
      this.waiting.shift()?.({ h, payload });
    }
  }

  /** One message out, its answer back (one at a time: the worker is one GL context) */
  ask(h: object, payload: Buffer[] = []): Promise<{ h: any; payload: Buffer }> {
    const run = () => new Promise<{ h: any; payload: Buffer }>((resolve) => {
      this.waiting.push(resolve);
      const hb = Buffer.from(JSON.stringify(h), 'utf8'), len = payload.reduce((a, b) => a + b.length, 0);
      const head = Buffer.alloc(4); head.writeUInt32LE(hb.length);
      const pl = Buffer.alloc(4); pl.writeUInt32LE(len);
      this.proc.stdin.write(Buffer.concat([head, hb, pl, ...payload]));
    });
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

/** Draws as the worker takes them: metadata (offsets into the payload) and the arrays appended to it */
function pack(list: Draw[], payload: Buffer[]): object[] {
  let off = payload.reduce((a, x) => a + x.length, 0);
  const put = (a: Float32Array | Uint32Array) => {
    const buf = Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    payload.push(buf);
    const at = off;
    off += buf.length;
    return [at, buf.length];
  };
  return list.map((d) => ({
    kind: d.kind, blend: d.blend, once: d.once, minPx: d.minPx, tex: d.tex, glow: d.glow, heat: d.heat,
    attrs: Object.fromEntries(Object.entries(d.attrs).map(([k, a]) => [k, [...put(a.data), a.size]])),
    idx: put(d.idx),
  }));
}

// ---- start up

const data = loadData();
const tData = performance.now();
const gl = new GlWorker();
const at = atlas();
const tAtlas = performance.now();
const ready = gl.ask({ op: 'init', shaders: SHADERS, tables: TABLES, atlas: { w: at.w, h: at.h } }, [Buffer.from(at.data.buffer, at.data.byteOffset, at.data.byteLength)]);
const sent = new Set<string>();
let skySent = false;
const stats = { renders: 0, errors: 0, last: {} as Record<string, unknown> };

async function render(q: string): Promise<{ png: Buffer; times: Record<string, number | string>; info: object; zoom: number }> {
  await ready;
  const p = parseParams(q);
  const t0 = performance.now();
  const { items, view: v, missing } = scene(data, p);
  const t1 = performance.now();
  const sp = new URLSearchParams(q);
  const base = { op: 'render', view: v, cs: data.tuning.cellSize, samples: Number(sp.get('samples') ?? 8), time: Number(sp.get('time') ?? 1), compress: Number(sp.get('compress') ?? 1), bloomSigma: Number(sp.get('bloomSigma') ?? 8), bloomMulA: Number(sp.get('bloomMulA') ?? 1) };
  const ask = (all: boolean) => {
    const payload: Buffer[] = [];
    const list = items.map((it) => ({ key: it.key, x: it.x, y: it.y, damage: it.damage, cs: it.built.cs, fx: pack(it.fx, payload), ...(all || !sent.has(it.key) ? { draws: pack(it.built.draws, payload) } : {}) }));
    return gl.ask({ ...base, items: list }, payload);
  };
  // The sky's shaders and noise go over once, when first asked for
  if (v.sky && !skySent) {
    const n = skyNoise();
    const r = await gl.ask({ op: 'sky', shaders: SKY_SHADERS, size: n.size }, [Buffer.from(n.data.buffer, n.data.byteOffset, n.data.byteLength)]);
    if (r.h.error) throw new Error(r.h.error);
    skySent = true;
  }
  let res = await ask(false);
  if (res.h.miss) res = await ask(true);
  for (const it of items) sent.add(it.key);
  if (res.h.error) throw new Error(`${res.h.error}
${res.h.trace ?? ''}`);
  const times = { buildMs: +(t1 - t0).toFixed(1), totalMs: +(performance.now() - t0).toFixed(1), uploadMs: res.h.uploadMs, gpuMs: res.h.gpuMs, pngMs: res.h.pngMs };
  const info = items.length === 1 ? { ...items[0].built.info, missing } : { items: items.length, vertices: items.reduce((a, i) => a + i.built.info.vertices, 0), missing };
  return { png: res.payload, times, info, zoom: v.zoom };
}

// ---- HTTP

const UI = join(__dirname, 'ui.html');
function send(res: ServerResponse, code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

// Quits after NATIVE_RENDER_IDLE_MIN idle minutes (default 60), so it never lingers
let lastUse = Date.now();
const IDLE_MS = Number(process.env.NATIVE_RENDER_IDLE_MIN ?? 60) * 60000;
setInterval(() => { if (IDLE_MS > 0 && Date.now() - lastUse > IDLE_MS) { console.log('[native-render] idle: stopping'); shutdown(); } }, 30000).unref();

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (!req.url?.startsWith('/health')) lastUse = Date.now();
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/render') {
      const r = await render(url.search);
      stats.renders++;
      stats.last = { asset: url.searchParams.get('asset'), ...r.times };
      send(res, 200, 'image/png', r.png, {
        'X-Render-Total-Ms': String(r.times.totalMs), 'X-Render-Build-Ms': String(r.times.buildMs), 'X-Render-Gpu-Ms': String(r.times.gpuMs),
        'X-Render-Png-Ms': String(r.times.pngMs), 'X-Render-Upload-Ms': String(r.times.uploadMs), 'X-Render-Info': JSON.stringify(r.info).replace(/[^ -~]/g, '?'), 'X-Render-Zoom': String(r.zoom),
        'Access-Control-Expose-Headers': 'X-Render-Total-Ms, X-Render-Info',
      });
    } else if (url.pathname === '/assets') {
      const list = searchAssets(data.assets, url.searchParams.get('q') ?? '').filter((e) => e.kind !== 'sheet');
      send(res, 200, 'application/json', JSON.stringify(list.map(({ id, kind, label, group }) => ({ id, kind, label, group }))));
    } else if (url.pathname === '/health') {
      send(res, 200, 'application/json', JSON.stringify({ ok: true, pid: process.pid, glPid: gl.proc.pid, port: PORT, uptimeS: Math.round(process.uptime()), ...stats, gl: (await ready).h }));
    } else if (url.pathname === '/' || url.pathname === '/view') {
      send(res, 200, 'text/html; charset=utf-8', readFileSync(UI));
    } else if (url.pathname === '/quit' && req.method === 'POST') {
      send(res, 200, 'application/json', '{"ok":true}');
      shutdown();
    } else send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    stats.errors++;
    send(res, 400, 'text/plain; charset=utf-8', String(e instanceof Error ? e.message : e));
  }
});

function shutdown(): void {
  gl.proc.removeAllListeners('exit');
  try { gl.proc.stdin.end(); } catch { /* */ }
  setTimeout(() => { try { gl.proc.kill(); } catch { /* */ } process.exit(0); }, 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

ready.then((r) => {
  if (r.h.error) { console.error('[native-render] GL init failed:', r.h.error, r.h.trace); process.exit(1); }
  server.listen(PORT, '127.0.0.1', () => {
    const now = performance.now();
    console.log(`[native-render] ready on http://127.0.0.1:${PORT}/ in ${Math.round(now - T0)} ms (data ${Math.round(tData - T0)}, atlas ${Math.round(tAtlas - tData)}, GL ${Math.round(now - tAtlas)}) · ${r.h.gl} · pid ${process.pid}, GL worker pid ${gl.proc.pid}`);
  });
});
