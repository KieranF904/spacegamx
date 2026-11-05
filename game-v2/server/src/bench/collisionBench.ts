/**
 * Collision benchmark: a boss and a crowd of hostile ships in one place, hit
 * by shells, beams and splash. Times the narrow phase on its own (segment casts
 * against the boss's parts, beam casts, splash and EMP) and whole server ticks
 * with a barrage of shells in flight. Run (in server/):
 *   npx tsx src/bench/collisionBench.ts [--npcs N] [--ticks N] [--boss scrap_mother] [--far N] [--no-grid]
 * `--far N`: that many more ships scattered over the rest of the system (beams
 * used to try every ship in the world); `--no-grid`: beams try every body
 * again, as they did before they went through the spatial grid.
 * Short by default (a few seconds).
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as bitecs from 'bitecs';
import { Position, Rotation, InSystem, seededRng, partWeaponDef, type Blueprint } from '@space-game/common';
import { createProtoServer } from '../proto/createProtoServer.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { LocalTransport } from '../net/LocalTransport.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const NPCS = Number(arg('--npcs', '40'));
const TICKS = Number(arg('--ticks', '300'));
const BOSS = arg('--boss', 'scrap_mother');

(bitecs as any).resetGlobals?.();
const files = readGameDataFiles(dataDir);
const ships = loadShipConfigFromDisk(dataDir);
const server = createProtoServer({ files, ships, autoStart: false });
const t = new LocalTransport(server);
t.onMessage = () => {};
t.connect();
t.send({ type: 'join', username: 'bench' } as never);
const pid = t.getPlayerId();
const bridge = server.getShips()!;
const weapons = (server as any).weapons;
const sys = InSystem.systemId[pid];
// The pilot well away, out of it all (its own shots only)
Position.x[pid] = 0; Position.y[pid] = 6000;

const designs = bridge.enemyDesigns as Record<string, Blueprint>;
const bossBp = designs[BOSS];
if (!bossBp) throw new Error(`no design ${BOSS}: ${Object.keys(designs).slice(0, 20).join(', ')}`);
const boss = bridge.spawnDummy(bossBp, 0, 0, 0, sys);
const bossShip = bridge.get(boss)!;
const R = bossShip.derived.radius;
const small = Object.entries(designs).filter(([, bp]) => bp.parts.length >= 6 && bp.parts.length <= 60).map(([, bp]) => bp);
const rng = seededRng(7);
const npcs: number[] = [];
for (let i = 0; i < NPCS; i++) {
  const a = (i / NPCS) * Math.PI * 2, d = R + 600 + rng() * 1500;
  npcs.push(bridge.spawnDummy(small[i % small.length], Math.cos(a) * d, Math.sin(a) * d, rng() * 6.28, sys));
}
// More all over the system, nowhere near (what a beam used to have to look past)
const FAR = Number(arg('--far', '200'));
for (let i = 0; i < FAR; i++) {
  const a = rng() * Math.PI * 2, d = 12000 + rng() * 60000;
  npcs.push(bridge.spawnDummy(small[i % small.length], Math.cos(a) * d, Math.sin(a) * d, rng() * 6.28, sys));
}
if (process.argv.includes('--no-grid')) delete (bridge as any).host.shipsAlong;
// (Filed in the tick's broadphase, as everything is by the time anything fires)
server.step();
// Nothing moves or dies during the micro timings
const keep = () => { for (const e of [boss, ...npcs]) bridge.scaleHp(e, 1); };

function time(label: string, n: number, f: (i: number) => void): number {
  for (let i = 0; i < Math.min(200, n); i++) f(i); // warm up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f(i);
  const us = ((performance.now() - t0) * 1000) / n;
  console.log(`${label.padEnd(44)} ${us.toFixed(2).padStart(9)} µs/op`);
  return us;
}

console.log(`boss ${BOSS}: ${bossBp.parts.length} parts, radius ${R.toFixed(0)} · ${NPCS} hostiles · cell ${bridge.tuning.cellSize}`);

// Shell-length segments (60 units) through the boss's bounding circle
const shells = Array.from({ length: 4096 }, () => {
  const a = rng() * Math.PI * 2, r = rng() * R, h = rng() * Math.PI * 2;
  const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
  return [cx - Math.cos(h) * 30, cy - Math.sin(h) * 30, cx + Math.cos(h) * 30, cy + Math.sin(h) * 30];
});
let hits = 0;
time('segmentHit: shell step inside bounding circle', 40000, (i) => { const s = shells[i & 4095]; if (bridge.segmentHit(boss, bossShip, s[0], s[1], s[2], s[3])) hits++; });
console.log(`  (${((hits / 40200) * 100).toFixed(0)}% hit the hull)`);
// Beam-length casts (2500 units) from outside at random points of the boss
const beams = Array.from({ length: 4096 }, () => {
  const a = rng() * Math.PI * 2, r = rng() * R, h = rng() * Math.PI * 2;
  const tx = Math.cos(a) * r, ty = Math.sin(a) * r;
  return [tx - Math.cos(h) * (R + 400), ty - Math.sin(h) * (R + 400), tx + Math.cos(h) * (2500 - R - 400), ty + Math.sin(h) * (2500 - R - 400)];
});
time('segmentHit: beam (2500) across the boss', 20000, (i) => { const s = beams[i & 4095]; bridge.segmentHit(boss, bossShip, s[0], s[1], s[2], s[3]); });
time('segmentHit: wide beam (half-width 12)', 20000, (i) => { const s = beams[i & 4095]; bridge.segmentHit(boss, bossShip, s[0], s[1], s[2], s[3], 12); });
// Splash at points near the hull (missiles): tiny damage so nothing breaks
const spots = Array.from({ length: 1024 }, () => { const a = rng() * Math.PI * 2, r = R * (0.3 + 0.8 * rng()); return [Math.cos(a) * r, Math.sin(a) * r]; });
time('splashAt r=120 near the boss', 4000, (i) => { const p = spots[i & 1023]; bridge.splashAt(sys, p[0], p[1], 120, 1e-6, -1); });
time('empAt r=200 near the boss', 4000, (i) => { const p = spots[i & 1023]; bridge.empAt(sys, p[0], p[1], 200, 1, -1); });
// A pilot laser held on the boss: fireBeam through the bridge (its whole loop over bodies)
const laserBp: Blueprint = JSON.parse(JSON.stringify(ships.starter));
for (const p of laserBp.parts) if (p.fn === 'cannon_pip') Object.assign(p, { fn: 'laser', material: 'alloy' });
bridge.respawnInPlace(pid, laserBp);
const me = bridge.get(pid)!;
const w = me.derived.weapons[0];
if (w) {
  const def = bridge.tuning.weapons?.[w.kind] ? partWeaponDef(bridge.tuning, w.kind, me.blueprint.parts[w.part], w) : undefined;
  if (def) {
    Position.x[pid] = 0; Position.y[pid] = R + 900; Rotation.angle[pid] = -Math.PI / 2;
    time('fireBeam (laser, all bodies) at the boss', 4000, (i) => { Rotation.angle[pid] = -Math.PI / 2 + ((i % 64) - 32) * 0.01; (bridge as any).fireBeam(pid, me, w, def, { damage: 1e-6, width: def.width ?? 0 }); });
    Position.x[pid] = 0; Position.y[pid] = 6000;
  }
}
keep();

// Contacts: a hostile pressed against the boss's hull (resolveContacts, the whole pass: every pair in the system)
{
  const npc = npcs[0], hx = Position.x[npc], hy = Position.y[npc];
  // Slide it in from outside until its hull meets the boss's
  const a = Math.atan2(hy, hx);
  let d = R + 400;
  while (d > 0 && bridge.hullDistance(boss, Math.cos(a) * d, Math.sin(a) * d) > 5) d -= 5;
  const px = Math.cos(a) * d, py = Math.sin(a) * d;
  time('resolveContacts (one hostile touching the boss)', 2000, () => {
    Position.x[npc] = px; Position.y[npc] = py; Position.x[boss] = 0; Position.y[boss] = 0;
    (bridge as any).resolveContacts();
  });
  Position.x[npc] = hx; Position.y[npc] = hy; Position.x[boss] = 0; Position.y[boss] = 0;
}
keep();

// Whole ticks with a barrage of shells at the boss and the crowd
const ringShots = (k: number) => {
  for (let j = 0; j < 12; j++) {
    const a = rng() * Math.PI * 2, d = R + 700;
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    const target = j % 3 === 0 ? npcs[(k + j) % npcs.length] : boss;
    const ang = Math.atan2(Position.y[target] - y, Position.x[target] - x) + (rng() - 0.5) * 0.2;
    weapons.spawn(pid, j % 4 === 0 ? 'missile' : 'cannon', x, y, ang, 1e-6, { speedScale: 1, sizeScale: 1, turret: false });
  }
};
const times: number[] = [];
for (let k = 0; k < TICKS; k++) {
  ringShots(k);
  if (k % 30 === 0) keep();
  const s = performance.now();
  server.step();
  times.push(performance.now() - s);
}
times.sort((a, b) => a - b);
const mean = times.reduce((a, b) => a + b, 0) / times.length;
console.log(`server.step with ~12 shells/tick: mean ${mean.toFixed(3)} ms · p50 ${times[times.length >> 1].toFixed(3)} · p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)}`);
process.exit(0);
