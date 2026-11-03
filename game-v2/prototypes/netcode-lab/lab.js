// Netcode Lab: the real-server page. Connects to the lab server over a WebSocket (or runs the same server in the page),
// feeds your keys and mouse to the chosen client (labclient.js), draws its view and shows the readouts.
(function (NL) {
'use strict';
const { Sim, World: Wo, Proto: Pr, LabClient, Harness } = NL;
const { IN } = Sim;
const $ = (id) => document.getElementById(id);
const store = { get(k, d) { try { return localStorage.getItem('netlab.' + k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem('netlab.' + k, v); } catch {} } };

const cfg = { addLat: 0, addJit: 0, pred: true, ghost: false, every: false, zoom: 0.42 };
function defaultUrl() {
  if (location.protocol === 'file:') return 'ws://localhost:3120/ws';
  const u = new URL('ws', location.href);
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

// ------------------------------------------------------------------------------------------------------- input
// Live keys and mouse; each sample reports which of thrust / turn / fire changed, with the time of the first event behind it
const live = { keys: new Set(), btn: 0, ax: 300, ay: 0, helm: false, fKey: 0, fAim: 0, fBtn: 0 };
const MOVE_KEYS = { KeyW: IN.W, KeyA: IN.A, KeyS: IN.S, KeyD: IN.D, KeyQ: IN.Q, KeyE: IN.E, ShiftLeft: IN.BOOST, ShiftRight: IN.BOOST };
const input = {
  prev: null,
  sample(t) {
    let b = live.helm ? IN.HELM : 0;
    for (const k of live.keys) b |= MOVE_KEYS[k] || 0;
    if (live.btn & 1) b |= IN.GUN;
    if (live.btn & 2) b |= IN.TURRET;
    if (live.keys.has('Space')) b |= IN.GUN | IN.TURRET;
    const aim = Pr.quantAim(Math.round(Math.atan2(live.ay, live.ax) * Sim.RAD) & 0xFFFF);
    // (cursor distance in 32s: it only sets the turret's aim point, which sits 8 units off centre, so finer is noise)
    const inp = { b, aim, dist: Pr.quantDist(Math.min(4000, Math.hypot(live.ax, live.ay)), 32), seq: 0 };
    const changes = [], p = this.prev;
    if (p) {
      const moveMask = live.helm ? (IN.W | IN.S | IN.Q | IN.E | IN.BOOST) : (IN.W | IN.A | IN.S | IN.D | IN.BOOST);
      if ((b & moveMask) !== (p.b & moveMask)) changes.push({ kind: 'thrust', t: live.fKey || t });
      const turned = live.helm ? (b & (IN.A | IN.D)) !== (p.b & (IN.A | IN.D)) : Math.abs(Sim.wrapBA(aim - p.aim)) > 1092;
      if (turned) changes.push({ kind: 'turn', t: (live.helm ? live.fKey : live.fAim) || t });
      if (b & ~p.b & (IN.GUN | IN.TURRET)) changes.push({ kind: 'fire', t: live.fBtn || t });
    }
    this.prev = { b, aim: p && !changes.some((c) => c.kind === 'turn') && !live.helm ? p.aim : aim };
    live.fKey = live.fAim = live.fBtn = 0;
    return { inp, changes };
  },
};
const typing = (e) => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  const c = e.code;
  if (MOVE_KEYS[c] || c === 'Space') {
    e.preventDefault();
    if (!live.keys.has(c)) { live.keys.add(c); if (c === 'Space') live.fBtn ||= e.timeStamp; else live.fKey ||= e.timeStamp; }
    return;
  }
  if (e.repeat) return;
  const act = { KeyP: 'predBtn', KeyG: 'ghostBtn', KeyH: 'helmBtn', KeyB: 'fightBtn', KeyC: 'connectBtn' }[c];
  if (act) $(act).click();
});
window.addEventListener('keyup', (e) => { if (live.keys.has(e.code)) { live.keys.delete(e.code); if (e.code === 'Space') live.fBtn ||= e.timeStamp; else live.fKey ||= e.timeStamp; } });
window.addEventListener('blur', () => { live.keys.clear(); live.btn = 0; });
const cv = $('game');
let mouse = null;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  live.ax = (mouse.x - r.width / 2) / cfg.zoom; live.ay = (mouse.y - r.height / 2) / cfg.zoom;
  live.fAim ||= e.timeStamp;
});
cv.addEventListener('mousedown', (e) => { e.preventDefault(); live.btn |= e.button === 0 ? 1 : e.button === 2 ? 2 : 0; live.fBtn ||= e.timeStamp; });
window.addEventListener('mouseup', (e) => { live.btn &= ~(e.button === 0 ? 1 : e.button === 2 ? 2 : 0); });
cv.addEventListener('wheel', (e) => { e.preventDefault(); cfg.zoom = Math.max(0.12, Math.min(1.2, cfg.zoom * (e.deltaY > 0 ? 0.9 : 1.1))); }, { passive: false });

// -------------------------------------------------------------------------------------------------- connection
/** Added latency and jitter on top of the real link, each way, keeping messages in order */
class Lag {
  constructor() { this.lastOut = 0; this.lastIn = 0; }
  sched(fn, key) {
    const now = performance.now();
    if (!cfg.addLat && !cfg.addJit && this[key] <= now) { fn(); return; }
    const t = Math.max(this[key], now + cfg.addLat + Math.random() * cfg.addJit);
    this[key] = t;
    setTimeout(fn, t - now);
  }
  out(fn) { this.sched(fn, 'lastOut'); }
  in(fn) { this.sched(fn, 'lastIn'); }
}
let conn = null;
function setStatus(txt, cls) { const s = $('status'); s.textContent = txt; s.className = cls || ''; }
function disconnect() {
  if (!conn) return;
  if (conn.ws) { conn.ws.onclose = null; try { conn.ws.close(); } catch {} }
  conn = null;
}
function connect(offline) {
  disconnect();
  const mode = $('mode').value, name = $('name').value || 'pilot';
  store.set('name', name); store.set('mode', mode);
  const Cls = mode === 'current' ? LabClient.CurClient : LabClient.LsClient;
  const opts = { src: input, name, pred: cfg.pred, every: cfg.every };
  if (offline) {
    const h = new Harness({ now: performance.now() });
    const peer = h.add((send) => new Cls(Object.assign({ send }, opts)), 20 + cfg.addLat, cfg.addJit);
    conn = { kind: 'offline', client: peer.client, h, peer, t0: performance.now() };
    peer.client.start();
    setStatus('in-page server (20 ms each way + added)', 'ok');
    return;
  }
  const url = $('url').value.trim() || defaultUrl();
  store.set('url', url);
  let ws;
  try { ws = new WebSocket(url); } catch (e) { setStatus('bad address: ' + e.message, 'bad'); return; }
  ws.binaryType = 'arraybuffer';
  const lag = new Lag();
  const client = new Cls(Object.assign({ send: (buf) => lag.out(() => { if (ws.readyState === 1) ws.send(buf); }) }, opts));
  conn = { kind: 'ws', client, ws, lag, t0: performance.now() };
  setStatus('connecting to ' + url);
  ws.onopen = () => { client.start(); setStatus('connected: ' + url, 'ok'); };
  ws.onmessage = (ev) => { const d = typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data); lag.in(() => client.recv(d, performance.now())); };
  ws.onclose = (ev) => setStatus(`closed (${ev.code}${ev.reason ? ' ' + ev.reason : ''}): press Connect`, 'bad');
  ws.onerror = () => setStatus('could not connect to ' + url, 'bad');
}

// ----------------------------------------------------------------------------------------------------- controls
function bindRange(id, key, fmt) {
  const el = $(id), out = $(id + 'o');
  el.value = cfg[key]; out.textContent = fmt(cfg[key]);
  el.addEventListener('input', () => {
    cfg[key] = Number(el.value); out.textContent = fmt(cfg[key]);
    if (conn && conn.h) conn.h.setLatency(conn.peer, 20 + cfg.addLat, cfg.addJit);
  });
}
bindRange('addLat', 'addLat', (v) => `+${v} ms`);
bindRange('addJit', 'addJit', (v) => `0-${v} ms`);
$('url').value = store.get('url', defaultUrl());
$('name').value = store.get('name', 'pilot ' + Math.floor(Math.random() * 900 + 100));
$('mode').value = store.get('mode', 'lockstep');
$('every').addEventListener('change', (e) => { cfg.every = e.target.checked; });
$('mode').addEventListener('change', () => { if (conn) connect(conn.kind === 'offline'); $('mode').blur(); });
const toggles = {
  connectBtn: () => connect(false),
  offlineBtn: () => connect(true),
  predBtn: () => { cfg.pred = !cfg.pred; if (conn && 'predOn' in conn.client) conn.client.predOn = cfg.pred; },
  ghostBtn: () => { cfg.ghost = !cfg.ghost; },
  helmBtn: () => { live.helm = !live.helm; live.fKey ||= performance.now(); },
  fightBtn: () => conn && conn.client.command('botfight', { side: Math.floor(Math.random() * 3) - 1 }),
  bots4Btn: () => conn && conn.client.command('bots', { n: 4 }),
  clearBtn: () => conn && conn.client.command('clearbots'),
  injHp: () => inject('hp'), injAway: () => inject('away'), injInto: () => inject('into'), injSilent: () => inject('silent'),
  injDrop: () => inject('drop'), injDelay: () => inject('delay'),
};
let flash = null;
function inject(kind) {
  if (!conn || !conn.client.inject) { flash = { txt: 'debug drift needs the lockstep style', at: performance.now() }; return; }
  const r = conn.client.inject(kind, performance.now());
  flash = { txt: r ? `injected: ${kind}${r.key !== undefined && r.key !== null ? ` on ${entName(r.key)}` : ''}` : `nothing to inject ${kind} into right now`, at: performance.now() };
}
for (const [id, fn] of Object.entries(toggles)) $(id).addEventListener('click', (e) => { fn(); sync(); e.currentTarget.blur(); });
function sync() {
  $('predBtn').classList.toggle('on', cfg.pred);
  $('ghostBtn').classList.toggle('on', cfg.ghost);
  $('helmBtn').classList.toggle('on', live.helm);
}

// ------------------------------------------------------------------------------------------------------ drawing
const COL = { me: '#5fd3ff', player: '#f5a83a', drone: '#ef6a5a', freighter: '#5fd18a', pull: '#d77cff' };
function entName(key) {
  if (key < 0) return `rock ${-1 - key}`;
  const c = conn && conn.client, s = c && c.slotOf ? c.slotOf.get(key) : undefined;
  return s !== undefined ? `slot ${s} (uid ${key})` : `uid ${key}`;
}
function fit() {
  const dpr = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}
function rockPath(ctx, R) {
  ctx.beginPath();
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * Math.PI * 2, k = 0.82 + ((R.id * 7 + i * 13) % 10) / 50;
    const x = R.x + Math.cos(a) * R.r * k, y = R.y + Math.sin(a) * R.r * k;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}
function shipPath(ctx, s) {
  const r = Wo.KINDS[s.kind].r;
  ctx.beginPath();
  if (s.kind === 'drone') { ctx.moveTo(r, 0); ctx.lineTo(0, r * 0.8); ctx.lineTo(-r * 0.8, 0); ctx.lineTo(0, -r * 0.8); }
  else if (s.kind === 'freighter') { ctx.moveTo(r * 1.1, 0); ctx.lineTo(r * 0.5, r * 0.55); ctx.lineTo(-r, r * 0.55); ctx.lineTo(-r, -r * 0.55); ctx.lineTo(r * 0.5, -r * 0.55); }
  else { ctx.moveTo(r * 1.15, 0); ctx.lineTo(-r * 0.8, r * 0.75); ctx.lineTo(-r * 0.45, 0); ctx.lineTo(-r * 0.8, -r * 0.75); }
  ctx.closePath();
}
function draw(now, dt) {
  const dpr = fit(), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0a0f13'; ctx.fillRect(0, 0, W, H);
  const c = conn && conn.client, v = c && c.ready ? c.view(now, dt) : null;
  if (!v) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#8b9ba7'; ctx.font = '14px system-ui';
    ctx.fillText(conn ? 'waiting for the server...' : 'Connect to the lab server, or run the in-page server.', 20, 30);
    return;
  }
  const me = v.ships.find((s) => s.uid === v.me);
  const cam = me ? { x: me.x, y: me.y } : (draw.cam || { x: 0, y: 0 });
  draw.cam = cam;
  const z = cfg.zoom * dpr;
  ctx.setTransform(z, 0, 0, z, W / 2 - cam.x * z, H / 2 - cam.y * z);
  const x0 = cam.x - W / 2 / z, x1 = cam.x + W / 2 / z, y0 = cam.y - H / 2 / z, y1 = cam.y + H / 2 / z, g = 250;
  ctx.lineWidth = 1 / z; ctx.strokeStyle = 'rgba(140,170,190,0.07)'; ctx.beginPath();
  for (let x = Math.ceil(x0 / g) * g; x < x1; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = Math.ceil(y0 / g) * g; y < y1; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(239,106,90,0.5)'; ctx.lineWidth = 3 / z; ctx.strokeRect(-3000, -3000, 6000, 6000);
  // Awareness
  if (me && v.aware) {
    ctx.setLineDash([10 / z, 8 / z]); ctx.strokeStyle = 'rgba(95,211,255,0.25)'; ctx.lineWidth = 1.5 / z;
    ctx.beginPath(); ctx.arc(me.x, me.y, v.aware.VIEW, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(95,211,255,0.45)'; ctx.beginPath(); ctx.arc(me.x, me.y, v.aware.AWARE, 0, Math.PI * 2); ctx.stroke();
  }
  // Rocks (from the seed; the override table says which are damaged or gone)
  for (const R of v.rocks.list) {
    if (R.x + R.r < x0 || R.x - R.r > x1 || R.y + R.r < y0 || R.y - R.r > y1) continue;
    const o = v.rockOv.get(R.id);
    rockPath(ctx, R);
    if (o && o.dead) { ctx.setLineDash([4 / z, 6 / z]); ctx.strokeStyle = 'rgba(140,150,160,0.25)'; ctx.lineWidth = 1 / z; ctx.stroke(); ctx.setLineDash([]); continue; }
    const f = o ? o.hp / R.hp : 1;
    ctx.fillStyle = `rgba(${110 + (1 - f) * 90},${100 - (1 - f) * 30},${90 - (1 - f) * 40},0.55)`; ctx.fill();
    ctx.strokeStyle = 'rgba(170,160,150,0.6)'; ctx.lineWidth = 1.2 / z; ctx.stroke();
  }
  // Confirmed ghost
  if (cfg.ghost && v.ghost) for (const s of v.ghost) {
    if (s.dead) continue;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.a / Sim.RAD); shipPath(ctx, s);
    ctx.setLineDash([6 / z, 5 / z]); ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.3 / z; ctx.stroke(); ctx.restore();
  }
  // Loot
  ctx.font = `${11 / z}px ui-monospace, Consolas, monospace`;
  for (const l of v.loot || []) {
    ctx.beginPath(); ctx.moveTo(l.x, l.y - 9); ctx.lineTo(l.x + 9, l.y); ctx.lineTo(l.x, l.y + 9); ctx.lineTo(l.x - 9, l.y); ctx.closePath();
    ctx.fillStyle = '#f2c14e'; ctx.fill();
    if (l.pulled) { ctx.strokeStyle = COL.pull; ctx.lineWidth = 2 / z; ctx.beginPath(); ctx.arc(l.x, l.y, 16, 0, Math.PI * 2); ctx.stroke(); }
    if (l.slot !== undefined) { ctx.fillStyle = 'rgba(242,193,78,0.85)'; ctx.fillText(String(l.slot), l.x + 12, l.y - 10); }
  }
  // Shells
  ctx.lineCap = 'round';
  for (const p of v.shells) {
    ctx.strokeStyle = p.mine ? COL.me : '#ffd7a0'; ctx.lineWidth = 3.5 / Math.sqrt(z);
    ctx.beginPath(); ctx.moveTo(p.x - p.vx * 1.4, p.y - p.vy * 1.4); ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  // Ships
  for (const s of v.ships) {
    if (s.dead) continue;
    const col = s.uid === v.me ? COL.me : COL[s.kind], r = Wo.KINDS[s.kind].r;
    ctx.save(); ctx.translate(s.x, s.y); ctx.rotate(s.a / Sim.RAD);
    shipPath(ctx, s); ctx.fillStyle = col + '33'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = 2 / z; ctx.stroke();
    if (s.kind !== 'drone') { ctx.rotate((s.tur || 0) / Sim.RAD); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 0.7, 0); ctx.lineWidth = 3 / z; ctx.stroke(); }
    ctx.restore();
    if (s.pulled) { ctx.strokeStyle = COL.pull; ctx.lineWidth = 2.5 / z; ctx.beginPath(); ctx.arc(s.x, s.y, r + 14, 0, Math.PI * 2); ctx.stroke(); }
    const hpMax = Wo.KINDS[s.kind].hp;
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(s.x - 30, s.y - r - 22, 60, 5);
    ctx.fillStyle = s.hp / hpMax > 0.35 ? '#5fd18a' : '#ef6a5a'; ctx.fillRect(s.x - 30, s.y - r - 22, 60 * s.hp / hpMax, 5);
    if (s.slot !== undefined) { ctx.fillStyle = s.pulled ? COL.pull : 'rgba(221,229,234,0.8)'; ctx.fillText(`${s.slot}`, s.x + r + 6, s.y - r - 8); }
  }
  for (const k of v.sparks) {
    const f = Math.min(1, (now - k.at) / 300);
    ctx.strokeStyle = k.kill ? `rgba(255,140,90,${1 - f})` : `rgba(255,230,160,${1 - f})`; ctx.lineWidth = 2 / z;
    ctx.beginPath(); ctx.arc(k.x, k.y, (k.kill ? 20 : 8) + 30 * f, 0, Math.PI * 2); ctx.stroke();
  }
  // Screen space: crosshair, minimap, banner
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = W / dpr, ch = H / dpr;
  if (mouse) {
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5; ctx.beginPath();
    ctx.arc(mouse.x, mouse.y, 9, 0, Math.PI * 2); ctx.moveTo(mouse.x - 15, mouse.y); ctx.lineTo(mouse.x - 5, mouse.y); ctx.moveTo(mouse.x + 5, mouse.y); ctx.lineTo(mouse.x + 15, mouse.y);
    ctx.moveTo(mouse.x, mouse.y - 15); ctx.lineTo(mouse.x, mouse.y - 5); ctx.moveTo(mouse.x, mouse.y + 5); ctx.lineTo(mouse.x, mouse.y + 15); ctx.stroke();
  }
  const M = 150, mx = cw - M - 10, my = ch - M - 10, k = M / 6000;
  ctx.fillStyle = 'rgba(10,15,19,0.8)'; ctx.fillRect(mx, my, M, M); ctx.strokeStyle = 'rgba(140,170,190,0.4)'; ctx.lineWidth = 1; ctx.strokeRect(mx, my, M, M);
  const mp = (x, y) => [mx + (x + 3000) * k, my + (y + 3000) * k];
  for (const s of v.ships) { if (s.dead) continue; const [px, py] = mp(s.x, s.y); ctx.fillStyle = s.uid === v.me ? COL.me : COL[s.kind]; ctx.fillRect(px - 1.5, py - 1.5, 3, 3); }
  if (me && v.aware) { const [px, py] = mp(me.x, me.y); ctx.strokeStyle = 'rgba(95,211,255,0.6)'; ctx.beginPath(); ctx.arc(px, py, v.aware.AWARE * k, 0, Math.PI * 2); ctx.stroke(); }
  ctx.font = '600 13px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'top';
  const line = (txt, y, col) => { ctx.fillStyle = 'rgba(10,15,19,0.7)'; const m = ctx.measureText(txt).width; ctx.fillRect(8, y - 2, m + 8, 18); ctx.fillStyle = col; ctx.fillText(txt, 12, y); };
  const st = c.stats(now);
  const style = st.mode === 'lockstep' ? `LOCKSTEP · own prediction ${c.predOn ? 'ON' : 'OFF'}` : 'CURRENT STYLE · snapshots';
  line(style, 8, '#dde5ea');
  if (st.mode === 'lockstep') {
    if (st.behind > 3) line(`catching up: ${st.behind} ticks behind (${st.queued} bundles queued)`, 28, '#f2c14e');
    if (st.holding) line(`holding ${st.holding} messages (debug delay)`, 48, '#f2c14e');
  }
  if (flash && now - flash.at < 2500) line(flash.txt, ch - 26, '#d77cff');
  if (me) {
    ctx.font = '12px ui-monospace, Consolas, monospace';
    const sc = `kills ${me.kills}  deaths ${me.deaths}  cargo ${me.cargo}`;
    ctx.fillStyle = '#8b9ba7'; ctx.fillText(sc, cw / 2 - ctx.measureText(sc).width / 2, 10);
    if (me.dead) { ctx.font = '600 16px system-ui'; ctx.fillStyle = '#ef6a5a'; ctx.fillText('destroyed: respawning', cw / 2 - 80, ch / 2 - 60); }
  }
}

// ---------------------------------------------------------------------------------------------------- readouts
const f0 = (x) => (x === undefined || x === null || isNaN(x) ? '-' : Math.round(x).toString());
const avg = (a) => (a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const last = (a) => (a && a.length ? a[a.length - 1] : NaN);
const bps = (x) => (x >= 1000 ? `${(x / 1000).toFixed(2)} KB/s` : `${Math.round(x)} B/s`);
const TK = LabClient.TICK_MS;
function readouts(now) {
  const c = conn && conn.client;
  if (!c || !c.ready) { for (const id of ['cTime', 'cDelay', 'cBw', 'cAware', 'cDesync', 'cPlayers']) $(id).innerHTML = ''; return; }
  const st = c.stats(now), ls = st.mode === 'lockstep', secs = Math.max(1, (now - conn.t0) / 1000);
  // Timing
  let h = `<h3>Timing</h3><table>
    <tr><td>round trip</td><td class="n big">${f0(st.rtt)} ms</td><td class="dim">jitter ${f0(st.jit)} ms${cfg.addLat || cfg.addJit ? ` · incl. +${cfg.addLat}/${cfg.addJit} added` : ''}</td></tr>
    <tr><td>server tick</td><td class="n">${f0(st.serverTick)}</td><td class="dim">estimated from pongs</td></tr>`;
  if (ls) {
    h += `<tr><td>own tick</td><td class="n">${f0(st.stampTick)}</td><td class="dim">your inputs are stamped for this (+${f0(st.stampTick - st.serverTick)} t)</td></tr>
      <tr><td>confirmed</td><td class="n">${f0(st.confTick)}</td><td class="dim">shown ${f0(st.dispTick)} (${f0(st.dispTick - st.confTick)} t re-simulated)</td></tr>
      <tr><td>margin</td><td class="n big">${st.margin} t</td><td class="dim">late inputs ${st.st.late}${st.info ? ` (server: ${st.info.you.late})` : ''}</td></tr>
      <tr><td>queue</td><td class="n">${st.queued}</td><td class="dim">bundles waiting · ${st.behind} t behind · worst catch-up ${st.st.catchup} t/frame</td></tr>`;
  } else {
    h += `<tr><td>predicted</td><td class="n">${f0(st.dispTick)}</td><td class="dim">lead ${st.lead} t (${f0(st.lead * TK)} ms ahead)</td></tr>
      <tr><td>others</td><td class="n">${f0(st.interp)} ms</td><td class="dim">drawn this far behind the server</td></tr>
      <tr><td>corrections</td><td class="n">${st.st.corrections}</td><td class="dim">last ${f0(st.st.lastErr)} u · max ${f0(st.st.maxErr)} u · snaps ${st.st.snaps}</td></tr>`;
  }
  $('cTime').innerHTML = h + '</table>';
  // Input to screen
  const row = (k, a) => `<td class="n">${f0(last(a))}</td><td class="n">${f0(avg(a))}</td>`;
  const meters = ls ? [['prediction on', st.delays.on], ['prediction off', st.delays.off]] : [['current', st.delay]];
  h = `<h3>Input to screen (ms: last / avg of 40)</h3><table><tr class="dim"><td></td><td colspan="2" class="n">thrust</td><td colspan="2" class="n">turn</td><td colspan="2" class="n">fire</td></tr>`;
  for (const [name, m] of meters) h += `<tr><td>${name}</td>${row('t', m.res.thrust)}${row('u', m.res.turn)}${row('f', m.res.fire)}</tr>`;
  h += '</table>';
  if (!ls) h += `<div class="dim">server has your input after ${f0(avg(st.delay.confirm))} ms</div>`;
  else h += `<div class="dim">${c.predOn ? 'on: your ship moves at once; ' : 'off: you see your input when the server confirms it (~round trip + margin); '}P toggles</div>`;
  $('cDelay').innerHTML = h;
  // Bandwidth
  const cats = (r, t) => {
    const keys = [...new Set([...Object.keys(r.cats), ...Object.keys(t.cats)])].sort((a, b) => (t.cats[b] || 0) - (t.cats[a] || 0));
    return keys.map((k) => `<tr><td>${k}</td><td class="n">${bps(r.cats[k] || 0)}</td><td class="n dim">${bps((t.cats[k] || 0) / secs)}</td></tr>`).join('');
  };
  const sum = (t) => { let p = 0; for (const k in t.cats) p += t.cats[k]; return p; };
  h = `<h3>Bandwidth (payload; now / average)</h3><table>
    <tr><td><b>down</b></td><td class="n big">${bps(st.down.payload)}</td><td class="n dim">${bps(sum(st.downTot) / secs)}</td></tr>${cats(st.down, st.downTot)}
    <tr><td class="dim">wire</td><td class="n dim">${bps(st.down.wire)}</td><td class="dim">${st.down.msgs} msg/s, incl. IP/TCP/TLS/WS headers</td></tr>
    <tr><td><b>up</b></td><td class="n big">${bps(st.up.payload)}</td><td class="n dim">${bps(sum(st.upTot) / secs)}</td></tr>${cats(st.up, st.upTot)}
    <tr><td class="dim">wire</td><td class="n dim">${bps(st.up.wire)}</td><td class="dim">${st.up.msgs} msg/s</td></tr></table>`;
  $('cBw').innerHTML = h;
  // Awareness
  const you = st.info && st.info.you;
  if (ls) {
    $('cAware').innerHTML = `<h3>Awareness</h3><table>
      <tr><td>slots</td><td class="n big">${st.slots}</td><td class="dim">${you ? `${you.quarantined} quarantined (${you.quarantineTicks} t) · ${you.rocks} rocks tracked` : ''}</td></tr>
      <tr><td>entries</td><td class="n">${st.st.entries}</td><td class="dim">exits ${st.st.exits}</td></tr>
      <tr><td>pull-ins</td><td class="n">${st.st.pullIns}</td><td class="dim">now: ${you ? you.pulled.map((u) => entName(u)).join(', ') || 'none' : '-'}</td></tr></table>`;
  } else $('cAware').innerHTML = `<h3>Awareness</h3><div class="dim">current style: everything within ${c.C ? c.C.AWARE : 1500} units comes in every snapshot (20 Hz)</div>`;
  // Desyncs
  if (ls) {
    const cn = st.st.counts;
    h = `<h3>Desyncs caught</h3><table>
      <tr><td>mismatch</td><td class="n">${cn.mismatch}</td><td>missing</td><td class="n">${cn.missing}</td><td>spurious</td><td class="n">${cn.spurious}</td></tr>
      <tr><td>hash</td><td class="n">${cn.hash}</td><td>unseen</td><td class="n">${cn.unseen}</td><td>dropped</td><td class="n">${st.dropped}</td></tr></table>
      <div class="dim">reports ${st.st.reported} sent${you ? `, server matched ${you.matched} of ${you.expected} expected` : ''}; "unseen" = hit from outside your set (one hop isn't always enough)</div><table>`;
    for (const k of st.st.caught.slice(-6).reverse()) {
      h += `<tr><td class="${k.reason === 'unseen' ? 'dim' : 'warn'}">${k.reason}</td><td>${entName(k.key)}</td><td class="n">${k.ticks} t (${f0(k.ticks * TK)} ms)</td><td class="dim">${k.inj ? `${k.inj}: fixed ${f0(k.fixMs)} ms after` : ''}</td></tr>`;
    }
    $('cDesync').innerHTML = h + '</table><div class="dim">ticks = event to detection on the server</div>';
  } else $('cDesync').innerHTML = '';
  // Players
  const inf = st.info;
  $('cPlayers').innerHTML = inf ? `<h3>Server</h3><div>${inf.players.map((p) => `${p.uid === c.uid ? '<b>' : ''}${p.name.replace(/[<&]/g, '')}${p.uid === c.uid ? '</b>' : ''} <span class="dim">${p.mode}, ${p.rtt} ms</span>`).join(' · ')}</div>
    <div class="dim">${inf.bots} bots · ${inf.srv.ships} ships · ${inf.srv.shells} shells · ${inf.srv.rockOv} rock overrides · tick ${inf.srv.tickMs} ms of CPU</div>` : '';
}

// ----------------------------------------------------------------------------------------------------- the loop
let lastFrame = performance.now(), lastRo = 0;
function frame() {
  const now = performance.now(), dt = Math.min(100, now - lastFrame);
  lastFrame = now;
  if (conn) {
    if (conn.h) conn.h.advance(now);
    conn.client.frame(now);
  }
  draw(now, dt);
  if (now - lastRo > 250) { lastRo = now; readouts(now); }
  requestAnimationFrame(frame);
}
sync();
if (location.protocol !== 'file:') connect(false);
requestAnimationFrame(frame);
NL.lab = { cfg, live, connect, get conn() { return conn; }, inject };
})(globalThis.NL);
