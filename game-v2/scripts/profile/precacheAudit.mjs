// Pre-cache audit (measurement only; docs/audits/precache-everything.md). Three parts:
//   node scripts/profile/precacheAudit.mjs download <dist dir>            sizes of every built file: raw, gzip as nginx
//                                                                        serves it (level 1), gzip 6 and brotli 11
//   node scripts/profile/precacheAudit.mjs generators <page url> <profile dir>
//                                                                        a scratch dev page that runs every asset-cache
//                                                                        generator (client/_precache_scratch.html, removed after)
//   node scripts/profile/precacheAudit.mjs shaders <client url> <profile dir>
//                                                                        a first visit on a fresh profile: requests made,
//                                                                        programs linked, GL memory, then the guest join;
//                                                                        Chrome closed cleanly and its GPU caches measured
// One headless Chrome (killed by PID in a finally), on the profile dir given (made fresh; delete it afterwards).
import { spawn, execFileSync } from 'child_process';
import { readdirSync, statSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { gzipSync, brotliCompressSync, constants as Z } from 'zlib';

const CHROME = process.env.CHROME ?? 'C:/Users/Kieran/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [mode, a1, a2] = process.argv.slice(2);

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
const dirSize = (d) => (existsSync(d) ? walk(d).reduce((t, f) => t + statSync(f).size, 0) : 0);

if (mode === 'download') {
  const GZ = /\.(js|css|html|json|svg|txt|map)$/;
  const rows = walk(a1).map((p) => {
    const b = readFileSync(p), rel = relative(a1, p).replace(/\\/g, '/');
    const text = GZ.test(p) && !p.endsWith('.map');
    // nginx: gzip on, gzip_comp_level default 1, only text types, from 1024 bytes
    const nginx = text && b.length >= 1024 ? gzipSync(b, { level: 1 }).length : b.length;
    return { file: rel, raw: b.length, nginx, gzip6: gzipSync(b, { level: 6 }).length, br: brotliCompressSync(b, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length };
  });
  console.log(JSON.stringify(rows));
  process.exit(0);
}

async function launch(profile, width = 1440, height = 900) {
  mkdirSync(profile, { recursive: true });
  const port = 9900 + Math.floor(Math.random() * 90);
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, '--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu',
    `--window-size=${width},${height}`, `--user-data-dir=${profile}`, '--no-first-run', '--mute-audio', '--renderer-process-limit=1', '--disable-extensions',
    '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-default-browser-check', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' });
  console.error('chrome pid', proc.pid);
  let ws, browserWs;
  for (let i = 0; i < 75 && !ws; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
      browserWs = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch {}
  }
  if (!ws) { kill(proc.pid); throw new Error('no chrome'); }
  console.error('attached');
  if (ws.readyState !== 1) await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expression, timeout = 600000) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  // Closes Chrome the way a user would (so it writes its caches out), then makes sure it's gone
  const close = async () => {
    try {
      const b = new WebSocket(browserWs);
      await new Promise((r, j) => { b.addEventListener('open', r); b.addEventListener('error', j); });
      b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      for (let i = 0; i < 50; i++) { await sleep(200); if (proc.exitCode !== null) break; }
    } catch {}
    kill(proc.pid);
  };
  return { proc, send, ev, events, close };
}
function kill(pid) { try { execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

/** The GPU-side caches in a Chrome profile */
const gpuCaches = (profile) => Object.fromEntries(['GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'Default/GPUCache', 'Default/DawnGraphiteCache', 'Default/DawnWebGPUCache', 'Default/IndexedDB', 'Default/Cache', 'Default/Code Cache']
  .map((d) => [d, dirSize(join(profile, d))]));

if (mode === 'generators') {
  const b = await launch(a2);
  try {
    console.error('enabling'); await b.send('Runtime.enable'); await b.send('Page.enable'); console.error('navigating');
    await b.send('Page.navigate', { url: a1 }); console.error('navigated');
    for (let i = 0; i < 1500; i++) {
      await sleep(400);
      const s = await b.ev(`window.__R ? JSON.stringify({ n: window.__R.rows.length, done: !!window.__done }) : null`).catch(() => null);
      if (i % 25 === 0) console.error('progress', s);
      if (s && JSON.parse(s).done) break;
    }
    console.log(await b.ev('JSON.stringify(window.__R)'));
    const ex = b.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
    if (ex.length) console.error('exceptions', ex.slice(0, 5));
  } finally { await b.close(); }
  process.exit(0);
}

// In every document from its start: program links (with KHR_parallel_shader_compile the wait shows on whichever
// query comes first), and live GL memory: textures by their storage calls, buffers by bufferData, renderbuffers
const PROBE = `(() => {
  const S = window.__PA = { programs: 0, linkCalls: 0, waitMs: 0, tex: new Map(), buf: new Map(), rb: new Map(), peak: 0 };
  const P = WebGL2RenderingContext.prototype;
  const lp = P.linkProgram; S.first = 0; S.lastDone = 0; S.done = new WeakSet(); P.linkProgram = function (p) { S.linkCalls++; if (!S.first) S.first = performance.now(); return lp.call(this, p); };
  const gp = P.getProgramParameter; P.getProgramParameter = function (p, n) { const t = performance.now(); const r = gp.call(this, p, n); S.waitMs += performance.now() - t; if ((n === 0x91B1 || n === this.LINK_STATUS) && r && !S.done.has(p)) { S.done.add(p); S.lastDone = performance.now(); } return r; };
  const bpp = (fmt, type) => {
    const gl = WebGL2RenderingContext;
    if (type === gl.FLOAT) return fmt === gl.RGBA || fmt === gl.RGBA32F ? 16 : fmt === gl.RG32F ? 8 : 4;
    if (type === gl.HALF_FLOAT) return fmt === gl.RGBA || fmt === gl.RGBA16F ? 8 : 4;
    if (fmt === gl.RED || fmt === gl.R8 || fmt === gl.ALPHA || fmt === gl.LUMINANCE) return 1;
    if (fmt === gl.RG || fmt === gl.RG8) return 2;
    if (fmt === gl.RGBA16F) return 8; if (fmt === gl.RGBA32F) return 16;
    return 4;
  };
  const bound = new WeakMap(); // gl -> { unit -> { target -> tex } }
  const cur = (gl) => { let b = bound.get(gl); if (!b) bound.set(gl, (b = { unit: 0, t: {} })); return b; };
  const at = P.activeTexture; P.activeTexture = function (u) { cur(this).unit = u; return at.call(this, u); };
  const bt = P.bindTexture; P.bindTexture = function (t, tex) { cur(this).t[cur(this).unit + ':' + t] = tex; return bt.call(this, t, tex); };
  const texOf = (gl, target) => { const tg = target >= 0x8515 && target <= 0x851A ? gl.TEXTURE_CUBE_MAP : target; return cur(gl).t[cur(gl).unit + ':' + tg]; };
  const note = () => { let t = 0; for (const v of S.tex.values()) t += v; for (const v of S.buf.values()) t += v; for (const v of S.rb.values()) t += v; if (t > S.peak) S.peak = t; };
  const ti = P.texImage2D; P.texImage2D = function (...a) {
    const tex = texOf(this, a[0]); let w, h, fmt, type;
    if (a.length >= 8) { w = a[3]; h = a[4]; fmt = a[2]; type = a[7]; } else { const src = a[5]; w = src.width ?? src.videoWidth ?? src.displayWidth; h = src.height ?? src.videoHeight ?? src.displayHeight; fmt = a[2]; type = a[4]; }
    if (tex && a[1] === 0) { S.tex.set(tex, (w * h * bpp(fmt, type)) * (a[0] === this.TEXTURE_2D ? 1 : 1) + (a[0] !== this.TEXTURE_2D ? (S.tex.get(tex) || 0) : 0)); note(); }
    return ti.apply(this, a);
  };
  const ts = P.texStorage2D; P.texStorage2D = function (target, levels, fmt, w, h) { const tex = texOf(this, target); if (tex) { let t = 0, x = w, y = h; for (let i = 0; i < levels; i++) { t += x * y * bpp(fmt, 0); x = Math.max(1, x >> 1); y = Math.max(1, y >> 1); } S.tex.set(tex, t); note(); } return ts.call(this, target, levels, fmt, w, h); };
  const gm = P.generateMipmap; P.generateMipmap = function (t) { const tex = texOf(this, t); if (tex && S.tex.has(tex)) { S.tex.set(tex, Math.round(S.tex.get(tex) * 4 / 3)); note(); } return gm.call(this, t); };
  const dt = P.deleteTexture; P.deleteTexture = function (t) { S.tex.delete(t); return dt.call(this, t); };
  const bb = new WeakMap(); const bbuf = P.bindBuffer; P.bindBuffer = function (t, b) { let m = bb.get(this); if (!m) bb.set(this, (m = {})); m[t] = b; return bbuf.call(this, t, b); };
  const bd = P.bufferData; P.bufferData = function (t, d, u, ...r) { const b = (bb.get(this) || {})[t]; if (b) { S.buf.set(b, typeof d === 'number' ? d : (d?.byteLength ?? 0)); note(); } return bd.call(this, t, d, u, ...r); };
  const db = P.deleteBuffer; P.deleteBuffer = function (b) { S.buf.delete(b); return db.call(this, b); };
  let rbb = null; const brb = P.bindRenderbuffer; P.bindRenderbuffer = function (t, r) { rbb = r; return brb.call(this, t, r); };
  const rs = P.renderbufferStorageMultisample; P.renderbufferStorageMultisample = function (t, s, f, w, h) { if (rbb) { S.rb.set(rbb, w * h * 4 * Math.max(1, s)); note(); } return rs.call(this, t, s, f, w, h); };
  const rs1 = P.renderbufferStorage; P.renderbufferStorage = function (t, f, w, h) { if (rbb) { S.rb.set(rbb, w * h * 4); note(); } return rs1.call(this, t, f, w, h); };
  window.__PAsum = () => { const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0); return { programs: S.linkCalls, firstLink: Math.round(S.first), lastDone: Math.round(S.lastDone), waitMs: Math.round(S.waitMs), texN: S.tex.size, texMB: +(sum(S.tex) / 1048576).toFixed(1), bufN: S.buf.size, bufMB: +(sum(S.buf) / 1048576).toFixed(1), rbMB: +(sum(S.rb) / 1048576).toFixed(1), peakMB: +(S.peak / 1048576).toFixed(1), big: [...S.tex.values()].sort((a, b) => b - a).slice(0, 12).map((v) => +(v / 1048576).toFixed(2)) }; };
})()`;

if (mode === 'shaders') {
  const profile = a2;
  console.error('profile', profile);
  const b = await launch(profile);
  const out = { before: gpuCaches(profile) };
  try {
    await b.send('Runtime.enable'); await b.send('Page.enable'); await b.send('Network.enable');
    await b.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    const t0 = Date.now();
    await b.send('Page.navigate', { url: a1 });
    for (let i = 0; i < 150; i++) { await sleep(100); if (await b.ev(`!!document.querySelector('.guest-button')`).catch(() => false)) break; }
    out.loginAt = Date.now() - t0;
    // the warm-up behind the sign-in screen: until no program has been linked for 3 s
    let last = -1, still = 0;
    for (let i = 0; i < 120 && still < 6; i++) { await sleep(500); const n = (await b.ev('window.__PAsum()')).programs; still = n === last ? still + 1 : 0; last = n; }
    out.atLogin = await b.ev('window.__PAsum()');
    out.atLoginMs = Date.now() - t0;
    const reqs = () => b.events.filter((e) => e.method === 'Network.loadingFinished' || e.method === 'Network.responseReceived');
    const urlOf = new Map(); for (const e of b.events) if (e.method === 'Network.responseReceived') urlOf.set(e.params.requestId, e.params.response.url);
    out.requestsAtLogin = [...urlOf.values()];
    // the guest, and joining the first server
    await b.ev(`(async () => { const w = (ms) => new Promise((r) => setTimeout(r, ms)); document.querySelector('.guest-button').click(); await w(3000);
      const j = [...document.querySelectorAll('button')].find((x) => /join/i.test(x.innerText)); if (j) j.click(); return !!j; })()`);
    await sleep(15000);
    out.inGame = await b.ev('window.__PAsum()');
    const gl = await b.ev(`(() => { const c = [...document.querySelectorAll('canvas')]; return c.map((x) => [x.width, x.height]); })()`);
    out.canvases = gl;
    urlOf.clear(); for (const e of b.events) if (e.method === 'Network.responseReceived') urlOf.set(e.params.requestId, e.params.response.url);
    out.requestsInGame = [...urlOf.values()];
    void reqs;
  } finally { await b.close(); }
  await sleep(1500);
  out.after = gpuCaches(profile);
  console.log(JSON.stringify(out));
  process.exit(0);
}
