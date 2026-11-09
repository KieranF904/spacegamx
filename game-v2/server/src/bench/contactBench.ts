/**
 * Contact benchmark: ships pressed against a big body (a boss, a giant) and against each other, the case the contact
 * pass (bridge/flight.ts resolveContacts, common ships/contact.ts) costs most in. Times the pass on its own (the same
 * tick's pairs resolved again and again from the same state), the placing of pieces and the pair maths apart (as a
 * client's tick layer runs them: ContactWorld, OwnTick), and whole server ticks. Prints a hash of every result, so a
 * change meant to be exact can be held against the run before it. Run (in server/):
 *   npx tsx src/bench/contactBench.ts [--small 40] [--big 6] [--boss scrap_mother] [--ticks 600] [--reps 400]
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, seededRng, contactPieces, contactPair, type Blueprint } from '@space-game/common';
import { createProtoServer } from '../proto/createProtoServer.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { LocalTransport } from '../net/LocalTransport.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] ?? d : d; };
const SMALL = Number(arg('--small', '40'));
const BIG = Number(arg('--big', '6'));
const BOSS = arg('--boss', 'scrap_mother');
const TICKS = Number(arg('--ticks', '600'));
const REPS = Number(arg('--reps', '400'));

(bitecs as unknown as { resetGlobals?: () => void }).resetGlobals?.();
const files = readGameDataFiles(dataDir);
const ships = loadShipConfigFromDisk(dataDir);
const server = createProtoServer({ files, ships, autoStart: false });
const t = new LocalTransport(server);
t.onMessage = () => {};
t.connect();
t.send({ type: 'join', username: 'bench' } as never);
const pid = t.getPlayerId();
const bridge = server.getShips()!;
const sys = InSystem.systemId[pid];
Position.x[pid] = 0; Position.y[pid] = 9000;

const designs = bridge.enemyDesigns as Record<string, Blueprint>;
const bossBp = designs[BOSS] ?? bridge.library.get(BOSS);
if (!bossBp) throw new Error(`no design ${BOSS}`);
const boss = bridge.spawnDummy(bossBp, 0, 0, 0.4, sys);
bridge.pin(boss);
const R = bridge.get(boss)!.derived.radius;
const smallBps = Object.values(designs).filter((bp) => bp.parts.length >= 6 && bp.parts.length <= 30);
const bigBp = bridge.library.get('hauler') ?? Object.values(designs).find((bp) => bp.parts.length > 60)!;
const rng = seededRng(11);
const crowd: number[] = [];
// A ring of small ships just off the hull, every one flying in (they grind on the boss and on each other)
for (let i = 0; i < SMALL; i++) {
  const a = (i / SMALL) * Math.PI * 2, d = R * 0.9 + rng() * 120;
  const e = bridge.spawnDummy(smallBps[i % smallBps.length], Math.cos(a) * d, Math.sin(a) * d, rng() * 6.28, sys);
  bridge.setAutopilot(e, { x: 0, y: 0, arriveRadius: 5 });
  crowd.push(e);
}
// Big ships (over CONTACT_BIG_BODY parts) pressing in too: big against big
for (let i = 0; i < BIG; i++) {
  const a = ((i + 0.5) / BIG) * Math.PI * 2, d = R + 150;
  const e = bridge.spawnDummy(bigBp, Math.cos(a) * d, Math.sin(a) * d, a + Math.PI / 2, sys);
  bridge.setAutopilot(e, { x: 0, y: 0, arriveRadius: 5 });
  crowd.push(e);
}
const all = [boss, ...crowd];
for (const e of all) bridge.scaleHp(e, 1e6);

const mix = (h: number, v: number) => Math.imul(h ^ (v | 0), 0x9e3779b1) ^ (Math.imul(h, 0x85ebca6b) >>> 13);
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
const hashNum = (h: number, v: number) => { f64[0] = v; return mix(mix(h, u32[0]), u32[1]); };
const worldHash = () => {
  let h = 0x6a09e667;
  for (const e of all) for (const v of [Position.x[e], Position.y[e], Velocity.x[e], Velocity.y[e], Rotation.angle[e]]) h = hashNum(h, v);
  return (h >>> 0).toString(16);
};

const time = (label: string, n: number, f: (i: number) => void) => {
  for (let i = 0; i < Math.min(50, n); i++) f(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f(i);
  const us = ((performance.now() - t0) * 1000) / n;
  console.log(`${label.padEnd(52)} ${us.toFixed(1).padStart(9)} µs/op`);
  return us;
};

console.log(`boss ${BOSS}: ${bossBp.parts.length} parts, radius ${R.toFixed(0)} · ${SMALL} small · ${BIG} ${bigBp.name ?? 'big'} (${bigBp.parts.length} parts)`);

// Into the hull: the crowd presses in until it's grinding
for (let i = 0; i < 150; i++) server.step();
console.log(`after 150 ticks: ${worldHash()}`);

// The pass alone: one tick's pairs from one state, resolved again and again
{
  const save = all.map((e) => [Position.x[e], Position.y[e], Velocity.x[e], Velocity.y[e]]);
  const restore = () => all.forEach((e, k) => { [Position.x[e], Position.y[e], Velocity.x[e], Velocity.y[e]] = save[k]; });
  const run = (bridge as unknown as { resolveContacts(): void });
  let h = 0;
  time('resolveContacts (the whole pass, one tick)', REPS, () => { restore(); run.resolveContacts(); });
  restore(); run.resolveContacts(); h = parseInt(worldHash(), 16);
  restore();
  console.log(`  pass result: ${(h >>> 0).toString(16)}`);
}

// The pieces and the pair maths apart, as a client's layer runs them: every pair of bodies whose circles meet
{
  const geomOf = (e: number) => bridge.geometry(bridge.get(e)!);
  const pose = (e: number) => ({ x: Position.x[e], y: Position.y[e], angle: Rotation.angle[e] });
  const pairs: [number, number][] = [];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const a = all[i], b = all[j], ra = bridge.get(a)!.derived.radius, rb = bridge.get(b)!.derived.radius;
    if (Math.hypot(Position.x[a] - Position.x[b], Position.y[a] - Position.y[b]) <= ra + rb) pairs.push([a, b]);
  }
  const cs = bridge.tuning.cellSize;
  const piecesOf = (e: number, o: number) => {
    const s = bridge.get(e)!, os = bridge.get(o)!;
    const near = s.blueprint.parts.length > 40 ? { x: Position.x[o], y: Position.y[o], r: os.derived.radius } : undefined;
    return contactPieces(geomOf(e), s.derived.alive, s.derived.com, cs, pose(e), near);
  };
  let touching = 0, h = 0x1234;
  for (const [a, b] of pairs) {
    const A = { x: Position.x[a], y: Position.y[a], vx: Velocity.x[a], vy: Velocity.y[a] }, B = { x: Position.x[b], y: Position.y[b], vx: Velocity.x[b], vy: Velocity.y[b] };
    const r = contactPair(piecesOf(a, b), piecesOf(b, a), A, B, 1 / bridge.get(a)!.derived.mass, 1 / bridge.get(b)!.derived.mass, 0.3);
    if (r) { touching++; for (const v of [r.depth, r.nx, r.ny, r.at[0], r.at[1], A.x, A.y, B.vx, B.vy]) h = hashNum(h, v); for (const p of r.partsA) h = mix(h, p); for (const p of r.partsB) h = mix(h, p); }
  }
  console.log(`${pairs.length} candidate pairs, ${touching} touching; pair results ${(h >>> 0).toString(16)}`);
  time('contactPieces (both sides of every candidate pair)', REPS, () => { for (const [a, b] of pairs) { piecesOf(a, b); piecesOf(b, a); } });
  const placed = pairs.map(([a, b]) => [piecesOf(a, b), piecesOf(b, a)] as const);
  time('contactPair (every candidate pair, pieces placed)', REPS, () => {
    for (let k = 0; k < pairs.length; k++) {
      const [a, b] = pairs[k];
      contactPair(placed[k][0], placed[k][1], { x: Position.x[a], y: Position.y[a], vx: 0, vy: 0 }, { x: Position.x[b], y: Position.y[b], vx: 0, vy: 0 }, 1, 1, 0.3);
    }
  });
}

// Whole ticks, grinding on
{
  const times: number[] = [];
  for (let i = 0; i < TICKS; i++) {
    const t0 = performance.now();
    server.step();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.reduce((s, v) => s + v, 0) / times.length;
  console.log(`server tick over ${TICKS}: mean ${mean.toFixed(2)} ms, p50 ${times[times.length >> 1].toFixed(2)}, p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)}`);
  console.log(`world after: ${worldHash()}`);
}
process.exit(0);
