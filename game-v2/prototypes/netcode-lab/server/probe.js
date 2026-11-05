// Netcode lab probe: real clients over a real socket, scripted, with numbers at the end. No browser needed.
//   node server/probe.js                                   (ws://127.0.0.1:3120/ws)
//   node server/probe.js wss://space.brotherk3d.com/netlab/ws [seconds per phase, default 12] [added one-way ms, default 0]
// Connects a lockstep client and a current-style client, starts a bot fight at the lockstep client's awareness edge
// plus four bots, flies a scripted pattern (thrust flips, aim sweeps, fire bursts) with own prediction on and then off,
// injects each kind of drift, and prints RTT, input delay, bandwidth by category and desync detection times.
// "Input to screen" here runs from the sample to the first state built for display that has used it (no frame, no
// monitor), so it reads a few ms lower than the page.
'use strict';
const WebSocket = require('ws');
const NL = require('./shared');
const { Sim, Proto: Pr, LabClient } = NL;

const URL = process.argv[2] || 'ws://127.0.0.1:3120/ws';
const PHASE = (Number(process.argv[3]) || 12) * 1000;
const ADD = Number(process.argv[4]) || 0;   // added latency each way, on top of the real link (in order)
function lagged(fn) { let last = 0; return (...a) => { if (!ADD) return fn(...a); const t = Math.max(last, now() + ADD); last = t; setTimeout(() => fn(...a), t - now()); }; }
const now = () => performance.now();

/** Scripted pilot: thrust direction flips every 450 ms, aim moves in steps every 150 ms, fire bursts */
class Script {
  constructor(k) { this.k = k; this.prev = null; }
  sample(t) {
    const ph = Math.floor(t / 450) + this.k;
    let b = [Sim.IN.W, Sim.IN.D, Sim.IN.S, Sim.IN.A][ph % 4];
    if (Math.floor(t / 900) % 3 === 0) b |= Sim.IN.GUN | Sim.IN.TURRET;
    const aim = Pr.quantAim((Math.floor(t / 150) * 2600 + this.k * 9000) & 0xFFFF);
    const changes = [];
    if (this.prev) {
      if ((b & 0x1F) !== (this.prev.b & 0x1F)) changes.push({ kind: 'thrust', t });
      if (Math.abs(Sim.wrapBA(aim - this.prev.aim)) > 1092) changes.push({ kind: 'turn', t });
      if ((b & Sim.IN.GUN) && !(this.prev.b & Sim.IN.GUN)) changes.push({ kind: 'fire', t });
    }
    this.prev = { b, aim };
    return { inp: { b, aim, dist: 600, seq: 0 }, changes };
  }
}

function open(Cls, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { perMessageDeflate: false });
    const client = new Cls(Object.assign({ send: lagged((b) => { if (ws.readyState === 1) ws.send(b); }) }, opts));
    const inbound = lagged((d) => client.recv(d, now()));
    ws.on('open', () => { client.start(); resolve({ ws, client }); });
    ws.on('message', (d, bin) => inbound(bin ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : d.toString()));
    ws.on('error', reject);
  });
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const f0 = (x) => (isNaN(x) ? '-' : x.toFixed(0));
const sleepFrames = (ms, clients) => new Promise((resolve) => {
  const end = now() + ms;
  let next = now();
  (function tick() {
    const t = now();
    if (t >= next) { next += 1000 / 60; if (next < t) next = t; for (const c of clients) { c.frame(t); c.view(t, 16.7); } }
    if (t >= end) resolve(); else setTimeout(tick, 1);
  })();
});

(async () => {
  console.log(`probe -> ${URL}${ADD ? ` (+${ADD} ms each way)` : ''}`);
  const A = await open(LabClient.LsClient, { src: new Script(0), name: 'probe-lockstep', pred: true });
  const B = await open(LabClient.CurClient, { src: new Script(2), name: 'probe-current' });
  const clients = [A.client, B.client];
  await sleepFrames(2000, clients);
  A.client.command('botfight', { side: 0 });
  A.client.command('bots', { n: 4 });
  await sleepFrames(1500, clients);
  const t0 = now(), d0 = A.client.down.totals(), u0 = A.client.up.totals(), bd0 = B.client.down.totals(), bu0 = B.client.up.totals();
  await sleepFrames(PHASE, clients);
  A.client.predOn = false;
  await sleepFrames(PHASE, clients);
  A.client.predOn = true;
  const secs = (now() - t0) / 1000;
  const diff = (a, b) => { const o = {}; for (const k in a.cats) o[k] = (a.cats[k] - (b.cats[k] || 0)) / secs; return { cats: o, wire: (a.wire - b.wire) / secs, msgs: (a.msgs - b.msgs) / secs }; };
  const bw = { lsDown: diff(A.client.down.totals(), d0), lsUp: diff(A.client.up.totals(), u0), curDown: diff(B.client.down.totals(), bd0), curUp: diff(B.client.up.totals(), bu0) };
  const playCounts = Object.assign({}, A.client.st.counts);
  // Drift injections, 3 s apart
  const inj = [];
  for (const kind of ['hp', 'away', 'into', 'silent', 'drop']) {
    const r = A.client.inject(kind, now());
    inj.push({ kind, ok: !!r, key: r && r.key });
    await sleepFrames(kind === 'silent' ? 4000 : 3000, clients);
  }
  const ls = A.client.stats(now()), cs = B.client.stats(now());
  console.log(`\nRTT ${f0(ls.rtt)} ms (jitter ${f0(ls.jit)}), margin ${ls.margin} t, late inputs ${ls.st.late}, slots ${ls.slots}, entries ${ls.st.entries}, exits ${ls.st.exits}, pull-ins ${ls.st.pullIns}`);
  const dl = (m) => ['thrust', 'turn', 'fire'].map((k) => `${k} ${f0(avg(m.res[k]))}`).join(', ');
  console.log(`input to screen, lockstep, own prediction on : ${dl(ls.delays.on)} ms`);
  console.log(`input to screen, lockstep, own prediction off: ${dl(ls.delays.off)} ms`);
  console.log(`input to screen, current style              : ${dl(cs.delay)} ms (server has it after ${f0(avg(cs.delay.confirm))} ms; ${cs.st.corrections} corrections)`);
  const show = (name, r) => console.log(`${name.padEnd(16)} ${Object.entries(r.cats).filter(([k]) => k !== 'lab').sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${f0(v)}`).join(', ')}  | payload ${f0(Object.entries(r.cats).filter(([k]) => k !== 'lab').reduce((s, [, v]) => s + v, 0))} B/s, wire ~${f0(r.wire)} B/s, ${f0(r.msgs)} msg/s`);
  console.log('\nbandwidth (B/s, averaged over both phases):');
  show('lockstep down', bw.lsDown); show('lockstep up', bw.lsUp); show('current down', bw.curDown); show('current up', bw.curUp);
  console.log('\ndesyncs caught (lockstep client) in normal play:', JSON.stringify(playCounts), '| by the end, after the injections:', JSON.stringify(ls.st.counts));
  for (const k of ls.st.caught.filter((c) => c.inj)) console.log(`  injected ${k.inj.padEnd(6)} -> ${k.reason.padEnd(8)} on ${k.key}: detected ${k.ticks} ticks (${f0(k.ticks * 1000 / 60)} ms) after the event, corrected on screen ${f0(k.fixMs)} ms after the injection`);
  for (const i of inj) if (!i.ok) console.log(`  injected ${i.kind}: nothing suitable to inject into`);
  console.log(`  dropped messages: ${ls.dropped}; server info: expected ${ls.info.you.expected}, matched ${ls.info.you.matched}`);
  A.client.command('clearbots');
  await sleepFrames(300, clients);
  A.ws.close(); B.ws.close();
  setTimeout(() => process.exit(0), 200);
})().catch((e) => { console.error(e); process.exit(1); });
