// Netcode Lab: the page. Records your keys and mouse with their timestamps, feeds them to one or two Worlds (one per
// pane, each a different network style), draws each pane from its client's view, and shows the readouts.
(function (NL) {
'use strict';
const { Sim, Net, Styles } = NL;
const { IN } = Sim;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------------------------------------------- settings
const cfg = {
  seed: 20261103, tickRate: 60, snapRate: 20, lat: [40, 40], linkLat: true, jitter: 0, loss: 0,
  curDelay: 2, lockAuto: true, lockDelay: 6, rbDelay: 2, rbMaxPred: 30,
  botFires: true, drones: true, side: true, ghost: false,
};
const STYLE_DESC = {
  current: 'server-authoritative; your ship predicted and checked against snapshots, others drawn in the past',
  lockstep: 'only inputs travel; your input waits D ticks for everyone; the screen shows confirmed ticks only',
  rollback: 'lockstep inputs, but runs ahead guessing the other player and rewinds when a guess was wrong',
};
const PRESETS = [['LAN', 10], ['Regional', 40], ['Cross-country', 80], ['Overseas', 150], ['Bad', 250]];

// ---------------------------------------------------------------------------------------------- input recording
// Every key and mouse change goes in a log with its event timestamp. Each World samples the log at its own tick times,
// so a key pressed between two ticks is first seen by the tick after it, and the delay readout runs from the real event.
const live = { keys: new Set(), btn: 0, ax: 300, ay: 0, helm: false };
const log = [];
let logBase = 0;   // log index of log[0]
function record(e) { log.push(e); }

const MOVE_KEYS = { KeyW: IN.W, KeyA: IN.A, KeyS: IN.S, KeyD: IN.D, KeyQ: IN.Q, KeyE: IN.E, ShiftLeft: IN.BOOST, ShiftRight: IN.BOOST };

class Reader {
  constructor() {
    this.i = logBase + log.length;
    this.keys = new Set(live.keys); this.btn = live.btn; this.ax = live.ax; this.ay = live.ay; this.helm = live.helm;
    this.prev = null; this.firstKey = 0; this.firstAim = 0; this.firstBtn = 0;
  }
  apply(e) {
    if (e.type === 'key') {
      if (e.down) this.keys.add(e.code); else this.keys.delete(e.code);
      if (e.code === 'Space') { if (!this.firstBtn) this.firstBtn = e.t; } else if (!this.firstKey) this.firstKey = e.t;
    } else if (e.type === 'btn') { this.btn = e.btn; if (!this.firstBtn) this.firstBtn = e.t; }
    else if (e.type === 'aim') { this.ax = e.ax; this.ay = e.ay; if (!this.firstAim) this.firstAim = e.t; }
    else if (e.type === 'helm') { this.helm = e.on; if (!this.firstKey) this.firstKey = e.t; }
  }
  /** The input as of time t, and which of thrust / turn / fire changed since the last sample (with the event time behind it) */
  sample(t) {
    while (this.i - logBase < log.length && log[this.i - logBase].t <= t) this.apply(log[this.i++ - logBase]);
    let b = this.helm ? IN.HELM : 0;
    for (const k of this.keys) b |= MOVE_KEYS[k] || 0;
    if (this.btn & 1) b |= IN.GUN;
    if (this.btn & 2) b |= IN.TURRET;
    if (this.keys.has('Space')) b |= IN.GUN | IN.TURRET;
    const aim = Net.quantAim(Math.round(Math.atan2(this.ay, this.ax) * Sim.RAD) & 0xFFFF);
    const inp = { b, aim, dist: Net.quantDist(Math.min(4000, Math.hypot(this.ax, this.ay))), seq: 0 };
    const changes = [], p = this.prev;
    if (p) {
      const moveMask = this.helm ? (IN.W | IN.S | IN.Q | IN.E | IN.BOOST) : (IN.W | IN.A | IN.S | IN.D | IN.BOOST);
      if ((b & moveMask) !== (p.b & moveMask)) changes.push({ kind: 'thrust', t: this.firstKey || t });
      const turned = this.helm ? (b & (IN.A | IN.D)) !== (p.b & (IN.A | IN.D)) : Math.abs(Sim.wrapBA(aim - p.aim)) > 1092;   // 6 degrees
      if (turned) changes.push({ kind: 'turn', t: (this.helm ? this.firstKey : this.firstAim) || t });
      if (b & ~p.b & (IN.GUN | IN.TURRET)) changes.push({ kind: 'fire', t: this.firstBtn || t });
    }
    // (A small mouse drift doesn't count as a turn; keep comparing against the aim at the last counted one)
    this.prev = { b, aim: p && !changes.some((c) => c.kind === 'turn') && !this.helm ? p.aim : aim };
    this.firstKey = this.firstAim = this.firstBtn = 0;
    return { inp, changes };
  }
}

// --------------------------------------------------------------------------------------------------------- panes
const panesEl = $('panes'), tpl = $('paneTpl');
const panes = ['current', 'lockstep'].map((style) => {
  const el = tpl.content.firstElementChild.cloneNode(true);
  panesEl.appendChild(el);
  const p = { style, el, canvas: el.querySelector('canvas.game'), sel: el.querySelector('select.style'), desc: el.querySelector('.desc'),
    c1: el.querySelector('.c1'), c2: el.querySelector('.c2'), c3: el.querySelector('.c3'), bw: el.querySelector('canvas.bw'), dl: el.querySelector('canvas.dl'),
    world: null, cam: { x: 0, y: 0 }, zoom: 0.5, prev: null };
  p.sel.value = style;
  p.sel.addEventListener('change', () => { p.style = p.sel.value; rebuildAll(); p.sel.blur(); });
  return p;
});
function rebuildAll() {
  const now = performance.now();
  for (const p of panes) {
    p.world = new Styles.World(p.style, cfg, new Reader(), now);
    p.sel.value = p.style; p.desc.textContent = STYLE_DESC[p.style]; p.prev = null;
  }
}

// -------------------------------------------------------------------------------------------------- controls
function bindRange(id, get, set, fmt, rebuild) {
  const el = $(id), out = $(id + 'o');
  const show = () => { out.textContent = fmt(get()); };
  el.value = get(); show();
  el.addEventListener('input', () => { set(Number(el.value)); show(); afterNet(); if (rebuild) rebuildAll(); });
  return { el, show };
}
function afterNet() { for (const p of panes) if (p.world) p.world.applyNet(); syncControls(); }
const latA = bindRange('latA', () => cfg.lat[0], (v) => { cfg.lat[0] = v; if (cfg.linkLat) cfg.lat[1] = v; }, (v) => `${v} ms`);
const latB = bindRange('latB', () => cfg.lat[1], (v) => { cfg.lat[1] = v; if (cfg.linkLat) cfg.lat[0] = v; }, (v) => `${v} ms`);
bindRange('jitter', () => cfg.jitter, (v) => { cfg.jitter = v; }, (v) => `0-${v} ms`);
bindRange('loss', () => cfg.loss * 100, (v) => { cfg.loss = v / 100; }, (v) => `${v}%`);
bindRange('curDelay', () => cfg.curDelay, (v) => { cfg.curDelay = v; }, (v) => `${v} t`);
const lockDelay = bindRange('lockDelay', () => cfg.lockDelay, (v) => { cfg.lockDelay = v; cfg.lockAuto = false; }, (v) => (cfg.lockAuto ? 'auto' : `${v} t`));
bindRange('rbDelay', () => cfg.rbDelay, (v) => { cfg.rbDelay = v; }, (v) => `${v} t`);
bindRange('rbMaxPred', () => cfg.rbMaxPred, (v) => { cfg.rbMaxPred = v; }, (v) => `${v} t`);
$('linkLat').checked = cfg.linkLat;
$('linkLat').addEventListener('change', (e) => { cfg.linkLat = e.target.checked; if (cfg.linkLat) cfg.lat[1] = cfg.lat[0]; afterNet(); });
$('tickRate').addEventListener('change', (e) => { cfg.tickRate = Number(e.target.value); rebuildAll(); e.target.blur(); });
$('snapRate').addEventListener('change', (e) => { cfg.snapRate = Number(e.target.value); rebuildAll(); e.target.blur(); });
for (const [name, ms] of PRESETS) {
  const b = document.createElement('button');
  b.textContent = `${name} ${ms}`; b.title = `${ms} ms each way for both players (round trip ${2 * ms} ms)`;
  b.addEventListener('click', () => { cfg.lat = [ms, ms]; cfg.linkLat = true; $('linkLat').checked = true; afterNet(); b.blur(); });
  b.dataset.ms = ms;
  $('presets').appendChild(b);
}
const toggles = {
  sideBtn: () => { cfg.side = !cfg.side; },
  ghostBtn: () => { cfg.ghost = !cfg.ghost; },
  helmBtn: () => { live.helm = !live.helm; record({ type: 'helm', on: live.helm, t: performance.now() }); },
  botBtn: () => { cfg.botFires = !cfg.botFires; },
  dronesBtn: () => { cfg.drones = !cfg.drones; rebuildAll(); },
  lockAuto: () => { cfg.lockAuto = !cfg.lockAuto; rebuildAll(); },
  resetBtn: () => rebuildAll(),
  desyncBtn: () => { for (const p of panes) p.world.injectDesync(); },
};
for (const [id, fn] of Object.entries(toggles)) $(id).addEventListener('click', (e) => { fn(); syncControls(); e.currentTarget.blur(); });
function syncControls() {
  $('sideBtn').classList.toggle('on', cfg.side);
  $('ghostBtn').classList.toggle('on', cfg.ghost);
  $('helmBtn').classList.toggle('on', live.helm);
  $('botBtn').classList.toggle('on', cfg.botFires);
  $('dronesBtn').classList.toggle('on', cfg.drones);
  $('lockAuto').classList.toggle('on', cfg.lockAuto);
  panesEl.classList.toggle('single', !cfg.side);
  latA.el.value = cfg.lat[0]; latA.show(); latB.el.value = cfg.lat[1]; latB.show();
  lockDelay.el.value = cfg.lockDelay; lockDelay.show();
  for (const b of $('presets').children) b.classList.toggle('on', cfg.lat[0] === +b.dataset.ms && cfg.lat[1] === +b.dataset.ms);
}

// ---------------------------------------------------------------------------------------------- keyboard / mouse
const typing = (e) => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox';
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  const c = e.code;
  if (MOVE_KEYS[c] || c === 'Space') {
    e.preventDefault();
    if (!live.keys.has(c)) { live.keys.add(c); record({ type: 'key', code: c, down: true, t: e.timeStamp }); }
    return;
  }
  if (e.repeat) return;
  const style = { Digit1: [0, 'current'], Digit2: [0, 'lockstep'], Digit3: [0, 'rollback'], Digit7: [1, 'current'], Digit8: [1, 'lockstep'], Digit9: [1, 'rollback'] }[c];
  if (style) { panes[style[0]].style = style[1]; rebuildAll(); return; }
  const btn = { KeyH: 'helmBtn', KeyG: 'ghostBtn', KeyR: 'resetBtn', KeyV: 'sideBtn' }[c];
  if (btn) { toggles[btn](); syncControls(); }
});
window.addEventListener('keyup', (e) => {
  if (live.keys.has(e.code)) { live.keys.delete(e.code); record({ type: 'key', code: e.code, down: false, t: e.timeStamp }); }
});
window.addEventListener('blur', () => {
  const t = performance.now();
  for (const c of live.keys) record({ type: 'key', code: c, down: false, t });
  live.keys.clear();
  if (live.btn) { live.btn = 0; record({ type: 'btn', btn: 0, t }); }
});
let mouse = null;   // { pane, x, y } in canvas pixels
for (const p of panes) {
  const cv = p.canvas;
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousemove', (e) => {
    const r = cv.getBoundingClientRect();
    mouse = { pane: p, x: e.clientX - r.left, y: e.clientY - r.top };
    // Aim is from the middle of the pane (where your ship is drawn), in world units
    live.ax = (mouse.x - r.width / 2) / p.zoom; live.ay = (mouse.y - r.height / 2) / p.zoom;
    record({ type: 'aim', ax: live.ax, ay: live.ay, t: e.timeStamp });
  });
  cv.addEventListener('mousedown', (e) => {
    e.preventDefault();
    live.btn |= e.button === 0 ? 1 : e.button === 2 ? 2 : 0;
    record({ type: 'btn', btn: live.btn, t: e.timeStamp });
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const z = Math.max(0.15, Math.min(1.2, p.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
    for (const q of panes) q.zoom = z;
  }, { passive: false });
}
window.addEventListener('mouseup', (e) => {
  live.btn &= ~(e.button === 0 ? 1 : e.button === 2 ? 2 : 0);
  record({ type: 'btn', btn: live.btn, t: e.timeStamp });
});

// ---------------------------------------------------------------------------------------------------- drawing
const COLORS = ['#5fd3ff', '#f5a83a', '#ef6a5a', '#ef6a5a'];
const NAMES = ['you', 'other player', 'drone', 'drone'];
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}
function drawShip(ctx, s, z, ghost) {
  const ang = s.a / Sim.RAD, r = s.kind === 'drone' ? 24 : 28, col = COLORS[s.id] || '#ccc';
  ctx.save();
  ctx.translate(s.x, s.y); ctx.rotate(ang);
  ctx.beginPath();
  if (s.kind === 'drone') { ctx.moveTo(r, 0); ctx.lineTo(0, r * 0.8); ctx.lineTo(-r * 0.8, 0); ctx.lineTo(0, -r * 0.8); }
  else { ctx.moveTo(r * 1.15, 0); ctx.lineTo(-r * 0.8, r * 0.75); ctx.lineTo(-r * 0.45, 0); ctx.lineTo(-r * 0.8, -r * 0.75); }
  ctx.closePath();
  if (ghost) { ctx.setLineDash([6 / z, 5 / z]); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5 / z; ctx.stroke(); ctx.restore(); return; }
  ctx.fillStyle = col + '33'; ctx.fill();
  ctx.strokeStyle = col; ctx.lineWidth = 2 / z; ctx.stroke();
  // Fixed gun on the nose, turret on the back
  ctx.beginPath(); ctx.moveTo(r * 0.9, 0); ctx.lineTo(r * 1.45, 0); ctx.lineWidth = 3 / z; ctx.stroke();
  if (s.kind !== 'drone') {
    ctx.translate(-8, 0); ctx.rotate((s.tur || 0) / Sim.RAD);
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(20, 0); ctx.lineWidth = 3 / z; ctx.stroke();
  }
  ctx.restore();
  // HP bar
  const hpMax = s.kind === 'drone' ? 60 : 100;
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(s.x - 30, s.y - r - 22, 60, 5);
  ctx.fillStyle = s.hp / hpMax > 0.35 ? '#5fd18a' : '#ef6a5a'; ctx.fillRect(s.x - 30, s.y - r - 22, 60 * s.hp / hpMax, 5);
}
function draw(p, now, dt) {
  const cv = p.canvas, dpr = fitCanvas(cv), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  const w = p.world, client = w.clients[0], v = client.view(now, dt);
  const me = v.ships.find((s) => s.id === v.me);
  if (me && !me.dead) p.cam = { x: me.x, y: me.y };
  const z = p.zoom * dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0f13'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(z, 0, 0, z, W / 2 - p.cam.x * z, H / 2 - p.cam.y * z);
  // Grid (it's what shows you moving) and the arena wall
  const x0 = p.cam.x - W / 2 / z, x1 = p.cam.x + W / 2 / z, y0 = p.cam.y - H / 2 / z, y1 = p.cam.y + H / 2 / z, g = 200;
  ctx.lineWidth = 1 / z; ctx.strokeStyle = 'rgba(140,170,190,0.09)';
  ctx.beginPath();
  for (let x = Math.ceil(x0 / g) * g; x < x1; x += g) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
  for (let y = Math.ceil(y0 / g) * g; y < y1; y += g) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(239,106,90,0.5)'; ctx.lineWidth = 3 / z;
  ctx.strokeRect(-Sim.HALF_WORLD, -Sim.HALF_WORLD, 2 * Sim.HALF_WORLD, 2 * Sim.HALF_WORLD);
  // Server ghost: where the authority has everything right now
  if (cfg.ghost) {
    const gh = w.ghost();
    for (const s of gh.ships) if (!s.dead) drawShip(ctx, s, z, true);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (const s of gh.shells) { ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
  // Shells, ships, hit flashes
  ctx.lineCap = 'round';
  for (const s of v.shells) {
    ctx.strokeStyle = COLORS[s.o] || '#fff'; ctx.lineWidth = (s.o >= 2 ? 6 : 4) / Math.sqrt(z) ;
    ctx.beginPath(); ctx.moveTo(s.x - s.vx * 1.4, s.y - s.vy * 1.4); ctx.lineTo(s.x, s.y); ctx.stroke();
  }
  for (const s of v.ships) if (!s.dead) drawShip(ctx, s, z, false);
  for (const k of v.sparks) {
    const f = (now - k.at) / 250;
    ctx.strokeStyle = `rgba(255,230,160,${1 - f})`; ctx.lineWidth = 2 / z;
    ctx.beginPath(); ctx.arc(k.x, k.y, 8 + 30 * f, 0, Math.PI * 2); ctx.stroke();
  }
  // Screen-space overlay
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = W / dpr, ch = H / dpr;
  if (mouse) {
    const mx = mouse.pane === p ? mouse.x : mouse.x, my = mouse.y, own = mouse.pane === p;
    ctx.strokeStyle = own ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(mx, my, 9, 0, Math.PI * 2); ctx.moveTo(mx - 15, my); ctx.lineTo(mx - 5, my); ctx.moveTo(mx + 5, my); ctx.lineTo(mx + 15, my);
    ctx.moveTo(mx, my - 15); ctx.lineTo(mx, my - 5); ctx.moveTo(mx, my + 5); ctx.lineTo(mx, my + 15); ctx.stroke();
  }
  const st = client.stats(now);
  ctx.font = '600 13px ui-monospace, Consolas, monospace'; ctx.textBaseline = 'top';
  const last = (a) => (a.length ? a[a.length - 1] : NaN);
  const dl = st.delay.res;
  const line = (txt, y, col) => { ctx.fillStyle = 'rgba(10,15,19,0.65)'; const m = ctx.measureText(txt).width; ctx.fillRect(8, y - 2, m + 8, 18); ctx.fillStyle = col; ctx.fillText(txt, 12, y); };
  const tk = w.tickMs;
  const fmtD = (x) => (isNaN(x) ? '  -' : `${x.toFixed(0).padStart(3)} ms (${(x / tk).toFixed(1)} t)`);
  line(`thrust ${fmtD(last(dl.thrust))}  turn ${fmtD(last(dl.turn))}  fire ${fmtD(last(dl.fire))}`, 8, '#dde5ea');
  const sub = st.style === 'current' ? `lead ${st.lead} t, others drawn ${st.interp.toFixed(0)} ms back, corrections ${st.corrections}`
    : st.style === 'lockstep' ? `D = ${st.D} ticks (${(st.D * tk).toFixed(0)} ms), showing tick ${st.shownTick} of ${w.wallTick(now)}`
    : `own delay ${st.D} t, rollbacks ${st.rollbacks}, last depth ${st.lastDepth} t`;
  line(sub, 28, '#8b9ba7');
  if (st.stalled) line(`STALLED: waiting for the other player's input (${w.wallTick(now) - st.shownTick} ticks behind)`, 48, '#f2c14e');
  if (w.desync) { ctx.font = '700 22px system-ui, sans-serif'; line(`DESYNC at tick ${w.desync}`, ch - 40, '#ef6a5a'); }
  // Score + your boost
  if (me) {
    ctx.font = '12px ui-monospace, Consolas, monospace';
    const other = v.ships.find((s) => s.id === 1 - v.me);
    const sc = `you ${me.kills}/${me.deaths}  other ${other ? `${other.kills}/${other.deaths}` : '-'}  (kills/deaths)`;
    ctx.fillStyle = '#8b9ba7'; ctx.fillText(sc, cw - ctx.measureText(sc).width - 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(cw / 2 - 60, ch - 16, 120, 5);
    ctx.fillStyle = '#5fd3ff'; ctx.fillRect(cw / 2 - 60, ch - 16, 120 * (me.boost ?? 600) / 600, 5);
    if (me.dead) { ctx.font = '600 16px system-ui'; ctx.fillStyle = '#ef6a5a'; ctx.fillText('destroyed: respawning', cw / 2 - 80, ch / 2 - 60); }
  }
}

// --------------------------------------------------------------------------------------------------- readouts
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f0 = (x) => (isNaN(x) ? '-' : x.toFixed(0));
const bps = (x) => (x >= 1000 ? `${(x / 1000).toFixed(2)} KB/s` : `${x.toFixed(0)} B/s`);
const hex = (h) => (h === undefined ? '--------' : h.toString(16).padStart(8, '0'));
function readouts(p, now) {
  const w = p.world, st = w.clients[0].stats(now), tk = w.tickMs, dl = st.delay.res;
  const prev = p.prev || { t: now - 1000, rollbacks: st.rollbacks || 0, resim: st.resim || 0, corrections: st.corrections || 0 };
  const dt = Math.max(0.001, (now - prev.t) / 1000);
  const row = (k, a) => {
    const l = a[a.length - 1];
    return `<tr><td>${k}</td><td class="n big">${f0(l)}</td><td class="n">${f0(avg(a))}</td><td class="n dim">${isNaN(l) ? '-' : (avg(a) / tk).toFixed(1)}</td><td class="n dim">${a.length ? f0(Math.min(...a)) + '-' + f0(Math.max(...a)) : ''}</td></tr>`;
  };
  p.c1.innerHTML = `<h3>Input to screen (ms)</h3><table><tr class="dim"><td></td><td class="n">last</td><td class="n">avg</td><td class="n">ticks</td><td class="n">range</td></tr>
    ${row('thrust', dl.thrust)}${row('turn', dl.turn)}${row('fire', dl.fire)}</table>
    ${st.style === 'current' ? `<div class="dim">server has your input after ${f0(avg(st.delay.confirm))} ms (hits and kills wait this long)</div>` : `<div class="dim">expected about ${f0((st.D + 0.5) * tk)} ms (D ticks + half a tick + a frame)</div>`}`;
  const m = w.meters[0], up = m.up.rate(now), down = m.down.rate(now);
  p.c2.innerHTML = `<h3>Network (you)</h3><table>
    <tr><td>round trip</td><td class="n">${f0(st.rtt)} ms</td><td class="dim">jitter ${f0(st.jit)}</td></tr>
    <tr><td>up</td><td class="n big">${bps(up.bytes)}</td><td class="dim">${bps(up.wire)} w/ headers · ${up.packets} pkt/s</td></tr>
    <tr><td>down</td><td class="n big">${bps(down.bytes)}</td><td class="dim">${bps(down.wire)} w/ headers · ${down.packets} pkt/s</td></tr>
    <tr><td>lost</td><td class="n">${w.up[0].lost + w.down[0].lost}</td><td class="dim">resent ~1 round trip later</td></tr></table>`;
  let h = '';
  if (st.style === 'current') {
    const rate = (st.corrections - prev.corrections) / dt;
    h = `<h3>Prediction</h3><table>
      <tr><td>corrections</td><td class="n big ${st.corrections ? 'warn' : 'good'}">${st.corrections}</td><td class="dim">${rate.toFixed(1)}/s · last ${f0(st.lastErr)} u · max ${f0(st.maxErr)} u</td></tr>
      <tr><td>snaps (&gt;260 u)</td><td class="n ${st.snaps ? 'bad' : ''}">${st.snaps}</td><td class="dim">incl. respawns</td></tr>
      <tr><td>late inputs</td><td class="n ${st.late ? 'warn' : ''}">${st.late}</td><td class="dim">missed their tick</td></tr>
      <tr><td>lead</td><td class="n">${st.lead} t</td><td class="dim">${f0(st.lead * tk)} ms ahead of server</td></tr>
      <tr><td>others shown</td><td class="n">${f0(st.interp)} ms</td><td class="dim">behind server</td></tr></table>`;
  } else {
    const ls = w.lastSync, sync = w.desync ? `<span class="bad">DESYNC at tick ${w.desync}</span>` : ls ? `<span class="good">in sync</span> to tick ${ls.tick}` : 'waiting';
    const hs = ls ? ls.hashes.map(hex) : ['', '', ''];
    const stall = `<tr><td>stalls</td><td class="n big ${st.stalls ? 'warn' : 'good'}">${st.stalls}</td><td class="dim">${f0(st.stallMsTotal)} ms frozen · worst ${st.stallTicks} t</td></tr>`;
    h = st.style === 'lockstep'
      ? `<h3>Lockstep</h3><table><tr><td>input delay D</td><td class="n big">${st.D} t</td><td class="dim">${f0(st.D * tk)} ms ${cfg.lockAuto ? '(auto)' : '(by hand)'}</td></tr>${stall}`
      : `<h3>Rollback</h3><table><tr><td>own delay</td><td class="n">${st.D} t</td><td class="dim">confirmed ${st.confTick} · shown ${st.shownTick}</td></tr>
        <tr><td>rollbacks</td><td class="n big">${st.rollbacks}</td><td class="dim">${((st.rollbacks - prev.rollbacks) / dt).toFixed(1)}/s · depth ${(st.depthSum / Math.max(1, st.rollbacks)).toFixed(1)} (max ${st.maxDepth}) t</td></tr>
        <tr><td>pops</td><td class="n">${f0(st.popErr)} u</td><td class="dim">ship jump on last rewind · max ${f0(st.maxPop)} u</td></tr>
        <tr><td>re-sim</td><td class="n">${f0((st.resim - prev.resim) / dt)}</td><td class="dim">ticks/s (${w.cfg.tickRate} = no rewinds)</td></tr>${stall}`;
    h += `<tr><td>hashes</td><td colspan="2">${sync}</td></tr><tr><td colspan="3" class="dim">you ${hs[0]} · other ${hs[1]} · server ${hs[2]}</td></tr></table>`;
  }
  p.c3.innerHTML = h;
  p.prev = { t: now, rollbacks: st.rollbacks || 0, resim: st.resim || 0, corrections: st.corrections || 0 };
  graphs(p, st);
}
function graphs(p, st) {
  // Bandwidth: down (solid) and up (dashed), last 30 s
  const m = p.world.meters[0];
  let cv = p.bw, dpr = fitCanvas(cv), ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  const max = Math.max(500, ...m.down.hist, ...m.up.hist);
  const plot = (a, col, dash) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash(dash ? [4 * dpr, 3 * dpr] : []);
    ctx.beginPath(); a.forEach((v, i) => { const x = W - (a.length - 1 - i) * W / 119, y = H - 4 * dpr - (H - 18 * dpr) * v / max; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
  };
  plot(m.down.hist, '#5fd3ff', false); plot(m.up.hist, '#f5a83a', true); ctx.setLineDash([]);
  ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`; ctx.fillStyle = '#8b9ba7';
  ctx.fillText(`bytes/s, 30 s: down (blue) up (orange, dashed); top = ${bps(max)}`, 5 * dpr, 12 * dpr);
  // Input delay samples: thrust, turn, fire
  cv = p.dl; dpr = fitCanvas(cv); ctx = cv.getContext('2d'); W = cv.width; H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
  const d = st.delay.res, all = [...d.thrust, ...d.turn, ...d.fire], top = Math.max(100, ...all) * 1.1;
  [['thrust', '#5fd3ff'], ['turn', '#5fd18a'], ['fire', '#f5a83a']].forEach(([k, col], j) => {
    ctx.fillStyle = col;
    d[k].forEach((v, i) => { const x = W - (d[k].length - i) * W / 41 + j * 3 * dpr, y = H - 4 * dpr - (H - 18 * dpr) * v / top; ctx.fillRect(x, y, 3 * dpr, H - 4 * dpr - y); });
  });
  ctx.fillStyle = '#8b9ba7'; ctx.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
  ctx.fillText(`input delay, last 40 of each: thrust turn fire; top = ${top.toFixed(0)} ms`, 5 * dpr, 12 * dpr);
}

// ---------------------------------------------------------------------------------------------------- the loop
let lastFrame = performance.now(), lastReadout = 0;
function frame(now) {
  now = performance.now();
  const dt = Math.min(100, now - lastFrame); lastFrame = now;
  for (const p of panes) if (!p.world.advance(now)) { rebuildAll(); break; }
  for (const p of panes) if (cfg.side || p === panes[0]) draw(p, now, dt);
  if (now - lastReadout > 200) { lastReadout = now; for (const p of panes) if (cfg.side || p === panes[0]) readouts(p, now); }
  // Drop log entries every reader has passed
  const min = Math.min(...panes.flatMap((p) => p.world.clients.map((c) => (c.src instanceof Reader ? c.src.i : Infinity))));
  if (min - logBase > 2000) { log.splice(0, min - logBase); logBase = min; }
  requestAnimationFrame(frame);
}
syncControls();
rebuildAll();
requestAnimationFrame(frame);
NL.app = { cfg, panes, live, record, rebuildAll, syncControls, toggles };
})(window.NL);
