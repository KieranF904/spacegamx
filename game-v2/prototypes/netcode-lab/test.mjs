// Netcode Lab checks, no browser: `node test.mjs` from this folder.
// 1. Two copies of the simulation fed the same random inputs stay bit for bit equal (and one unit apart is caught).
// 2. Each style runs on a fake clock with a scripted "you": lockstep/rollback hashes agree on both clients and the server,
//    and the measured input delay and bandwidth come out where they should for the configured latency.
import { readFileSync } from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
for (const f of ['sim.js', 'net.js', 'styles.js']) vm.runInThisContext(readFileSync(join(here, f), 'utf8'), { filename: f });
const { Sim, Net, Styles } = globalThis.NL;
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fails++; };

// ------------------------------------------------------------------------------------------------- 1. determinism
{
  const P = Sim.makeParams(60);
  const a = Sim.create(P, 1234), b = Sim.create(P, 1234);
  let rng = 99;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng; };
  let same = true;
  for (let t = 0; t < 3000; t++) {
    const ins = [0, 1].map(() => ({ b: rand() & 0x3FF, aim: rand() & 0xFFF8, dist: (rand() % 500) * 4, seq: t }));
    Sim.step(a, ins, P); Sim.step(b, ins.map((i) => Object.assign({}, i)), P);
    if (Sim.hash(a) !== Sim.hash(b)) { same = false; break; }
  }
  check(same, `3000 ticks of random inputs: identical hashes (${Sim.hash(a).toString(16)}), ${a.shots.length} shells live, kills ${a.ships.map((s) => s.kills).join('/')}`);
  b.ships[2].x += 1;
  check(Sim.hash(a) !== Sim.hash(b), 'a 1/65536-unit difference changes the hash');
  for (const rate of [15, 20, 30]) {
    const Q = Sim.makeParams(rate), s = Sim.create(Q, 7);
    for (let t = 0; t < rate * 3; t++) Sim.step(s, [{ b: 1 | 8, aim: 0, dist: 400, seq: 0 }, null], Q);
    const sh = s.ships[0];
    console.log(`     ${rate} Hz: after 3 s of W+D the ship moved ${Math.round(Math.hypot(sh.x / 65536 + 600, sh.y / 65536 - 120))} units`);
  }
  const P60 = Sim.makeParams(60), s60 = Sim.create(P60, 7);
  for (let t = 0; t < 180; t++) Sim.step(s60, [{ b: 1 | 8, aim: 0, dist: 400, seq: 0 }, null], P60);
  console.log(`     60 Hz: after 3 s of W+D the ship moved ${Math.round(Math.hypot(s60.ships[0].x / 65536 + 600, s60.ships[0].y / 65536 - 120))} units`);
}

// ------------------------------------------------------------------------------------------ 2. styles on a fake clock
/** A scripted "you": flips thrust every 400 ms, sweeps the aim, taps fire; reports each change like the real input reader */
class FakeHuman {
  constructor() { this.prev = null; }
  sample(t) {
    const phase = Math.floor(t / 400);
    let b = phase % 2 ? Sim.IN.W : Sim.IN.S;
    if (phase % 3 === 0) b |= Sim.IN.GUN;
    const aim = Net.quantAim((Math.floor(t / 700) * 9000) & 0xFFFF);
    const changes = [];
    if (this.prev) {
      // (Pretend the key went down half a tick before the sample)
      if ((b & 0xF) !== (this.prev.b & 0xF)) changes.push({ kind: 'thrust', t: t - 8 });
      if (aim !== this.prev.aim) changes.push({ kind: 'turn', t: t - 8 });
      if ((b & Sim.IN.GUN) && !(this.prev.b & Sim.IN.GUN)) changes.push({ kind: 'fire', t: t - 8 });
    }
    this.prev = { b, aim };
    return { inp: { b, aim, dist: 600, seq: 0 }, changes };
  }
}
globalThis.performance ??= { now: () => 0 };

function run(style, over = {}) {
  const cfg = Object.assign({ seed: 42, tickRate: 60, snapRate: 20, lat: [75, 75], jitter: 0, loss: 0, curDelay: 2,
    lockAuto: true, lockDelay: 6, rbDelay: 2, rbMaxPred: 40, botFires: true, drones: true }, over);
  const w = new Styles.World(style, cfg, new FakeHuman(), 0);
  const secs = over.secs ?? 20;
  // Frames at 60 fps, as a browser would draw them
  for (let f = 0; f < secs * 60; f++) {
    const now = f * 1000 / 60;
    w.advance(now);
    w.clients[0].view(now, 1000 / 60);
  }
  const st = w.clients[0].stats(secs * 1000), m = w.meters[0];
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const d = st.delay.res;
  const up = m.up.total / secs, down = m.down.total / secs, upW = m.up.totalWire / secs, downW = m.down.totalWire / secs;
  return { w, st, thrust: avg(d.thrust), turn: avg(d.turn), fire: avg(d.fire), confirm: avg(st.delay.confirm), up, down, upW, downW };
}
const f0 = (x) => (isNaN(x) ? '-' : x.toFixed(0));

console.log('\nstyle     one-way  jitter loss | thrust  turn  fire (ms) | up B/s (wire)  down B/s (wire) | extra');
for (const lat of [10, 40, 75, 150]) {
  for (const style of ['current', 'lockstep', 'rollback']) {
    const r = run(style, { lat: [lat, lat] });
    const st = r.st;
    const extra = style === 'current' ? `corrections ${st.corrections}, snaps ${st.snaps}, late ${st.late}, lead ${st.lead}, server sees it ${f0(r.confirm)} ms`
      : style === 'lockstep' ? `D ${st.D} (${f0(st.D * 1000 / 60)} ms), stalls ${st.stalls}, desync ${r.w.desync || 'none'} (checked to ${r.w.checked})`
      : `rollbacks ${st.rollbacks}, avg depth ${f0(st.depthSum / Math.max(1, st.rollbacks))}, max pop ${f0(st.maxPop)} u, stalls ${st.stalls}, desync ${r.w.desync || 'none'}`;
    console.log(`${style.padEnd(9)} ${String(lat).padStart(5)} ms  ${String(0).padStart(4)}   0% | ${f0(r.thrust).padStart(6)} ${f0(r.turn).padStart(5)} ${f0(r.fire).padStart(5)}      | ${f0(r.up).padStart(5)} (${f0(r.upW).padStart(5)})  ${f0(r.down).padStart(6)} (${f0(r.downW).padStart(5)})  | ${extra}`);
    if (style !== 'current') check(!r.w.desync && r.w.checked > 1000, `${style} at ${lat} ms: hashes agree on both clients and the server for ${r.w.checked} ticks`);
    if (style === 'lockstep') check(Math.abs(r.thrust - (st.D * 1000 / 60 + 8)) < 25, `lockstep at ${lat} ms: thrust delay ${f0(r.thrust)} ms ~ D x tick (${f0(st.D * 1000 / 60)} ms) + sampling`);
    if (style === 'current') check(r.thrust < 70, `current at ${lat} ms: predicted thrust shows in ${f0(r.thrust)} ms (input delay ${2} ticks + sampling + frame)`);
  }
}
for (const [jitter, loss] of [[30, 0], [20, 0.02]]) {
  for (const style of ['current', 'lockstep', 'rollback']) {
    const r = run(style, { lat: [75, 75], jitter, loss });
    const st = r.st;
    const extra = style === 'current' ? `corrections ${st.corrections}, snaps ${st.snaps}, late ${st.late}, lead ${st.lead}`
      : style === 'lockstep' ? `D ${st.D}, stalls ${st.stalls} (${f0(st.stallMsTotal)} ms stalled), desync ${r.w.desync || 'none'}`
      : `rollbacks ${st.rollbacks}, stalls ${st.stalls}, desync ${r.w.desync || 'none'}`;
    console.log(`${style.padEnd(9)} ${String(75).padStart(5)} ms  ${String(jitter).padStart(4)} ${String(loss * 100).padStart(3)}% | ${f0(r.thrust).padStart(6)} ${f0(r.turn).padStart(5)} ${f0(r.fire).padStart(5)}      | ${f0(r.up).padStart(5)} (${f0(r.upW).padStart(5)})  ${f0(r.down).padStart(6)} (${f0(r.downW).padStart(5)})  | ${extra}`);
    if (style !== 'current') check(!r.w.desync, `${style} with jitter ${jitter} and loss ${loss * 100}%: no desync`);
  }
}
{
  const r = run('lockstep', { lat: [40, 40], secs: 5 });
  r.w.injectDesync();
  for (let f = 300; f < 400; f++) r.w.advance(f * 1000 / 60);
  check(r.w.desync > 0, `injected one-unit error is reported as DESYNC at tick ${r.w.desync}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
