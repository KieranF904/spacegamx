/**
 * Server tick benchmark: a full server (every system loaded) with pilots
 * spread over the busy places (inner Sol, the Drift, the Reaches, Ashfall,
 * Glasswater), flying about and firing, for a while of simulated time; then
 * how long the ticks took (mean, p50, p95, p99, worst). Run (in server/):
 *   npx tsx src/bench/tickBench.ts [--seconds N] [--pilots N]
 * Simulation level of detail (ships/SimLod.ts): `--scenario spread` is one
 * pilot at the edge of Sol with `--packs N` hostile packs (default 40) spread
 * over the whole system, and as many again in Ashfall with nobody there;
 * `--no-lod` runs it with every ship live (the old cost) to compare; `--map`
 * has the pilots' system maps open (the far ships' dots are sent: mapDots);
 * `--keep` keeps systems nobody's in in the world (not put away: game/SystemMemory.ts),
 * to weigh the distant tier on the same ships as before.
 * With node's profiler: node --cpu-prof --import tsx src/bench/tickBench.ts
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Position, Velocity, Input, Rotation, ClientSocket, splitServerFrame } from '@space-game/common';
import * as bitecs from 'bitecs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) || d : d; };
const secs = arg('--seconds', 60);
const SPREAD = process.argv.includes('--scenario') && process.argv[process.argv.indexOf('--scenario') + 1] === 'spread';
const PILOTS = arg('--pilots', SPREAD ? 1 : 10);
const PACKS = arg('--packs', 40);

if (process.argv.includes('--size')) (bitecs as any).setDefaultSize(arg('--size', 32768));
const clock = { t: 1_000_000 };
const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)), clock: () => clock.t,
});

/** A socket that only counts what it's sent */
let bytes = 0;
/** Bytes by message type (the map's dots, against everything else) */
const byType: Record<string, number> = {};
const count = (d: string | Uint8Array) => {
  if (typeof d === 'string') return;
  try { for (const m of splitServerFrame(d)) byType[m.msg.type] = (byType[m.msg.type] ?? 0) + m.bytes; } catch { /* (not a frame) */ }
};
const pilots: number[] = [];
const conns: unknown[] = [];
const anyServer = server as any;
for (let i = 0; i < PILOTS; i++) {
  const socket: ClientSocket = { isOpen: () => true, send: (d: string | Uint8Array) => { bytes += typeof d === 'string' ? d.length : d.byteLength; count(d); } } as ClientSocket;
  const link = server.connect(socket);
  link.receive({ type: 'join', username: `bench${i}` } as never);
  // (--map: its system map open, so it's sent the far ships: mapDots)
  if (process.argv.includes('--map')) link.receive({ type: 'mapView', open: true } as never);
  const pid = server.getPlayerId(socket);
  pilots.push(pid);
  conns.push([...anyServer.clients.values()].find((c: any) => c.playerId === pid));
}
const spots: { system: string; x: number; y: number }[] = [
  { system: 'sol', x: 36000, y: 2000 }, { system: 'sol', x: 50000, y: 10000 }, { system: 'sol', x: -100000, y: 30000 },
  { system: 'sol', x: 85000, y: -40000 }, { system: 'sol', x: 0, y: 170000 }, { system: 'sol', x: 140000, y: 95000 },
  { system: 'ashfall', x: -38000, y: 30000 }, { system: 'ashfall', x: 30000, y: -20000 }, { system: 'glasswater', x: 20000, y: 5000 },
  { system: 'borealis', x: 30000, y: 0 },
];
if (process.argv.includes('--no-lod') && anyServer.lod) anyServer.lod.enabled = false;
if (process.argv.includes('--keep')) anyServer.memory.rules.evictAfterSeconds = 1e9;
// Time spent in the distant tier (SimLod) and building the map's dots, apart from the rest of the tick
const spent = { lod: 0, dots: 0 };
const timed = (obj: any, fn: string, key: keyof typeof spent) => {
  const orig = obj[fn].bind(obj);
  obj[fn] = (...a: unknown[]) => { const s = performance.now(); try { return orig(...a); } finally { spent[key] += performance.now() - s; } };
};
if (anyServer.lod) timed(anyServer.lod, 'tick', 'lod');
timed(anyServer.snapshots, 'sendMapDots', 'dots');
// Out to their spots
pilots.forEach((pid, i) => {
  const at = SPREAD ? { system: 'sol', x: 165000, y: 0 } : spots[i % spots.length];
  anyServer.travelTo(conns[i], anyServer.gameData.getSystemNum(at.system), at.x, at.y, false);
});
if (SPREAD) {
  // Packs all over Sol (the pilot at its edge) and all over Ashfall (nobody there), each patrolling where it is
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kinds = [['pirate_raider', 'pirate_raider', 'pirate_skiff'], ['scav_drone', 'scav_harvester'], ['pirate_raider', 'pirate_skiff', 'pirate_skiff', 'pirate_skiff']];
  for (const [system, R] of [['sol', 170000], ['ashfall', 60000]] as const) {
    const num = anyServer.gameData.getSystemNum(system);
    for (let i = 0; i < PACKS; i++) {
      const a = rnd() * Math.PI * 2, r = 25000 + rnd() * (R - 25000);
      const ships = kinds[i % kinds.length].filter((k) => server.enemies && (anyServer.ships.enemyDesigns[k]));
      server.enemies.spawnPack(num, { faction: ships[0]?.startsWith('scav') ? 'scavengers' : 'pirates', ships }, Math.cos(a) * r, Math.sin(a) * r);
    }
  }
}

const times: number[] = [];
let maxEid = 0, maxLive = 0;
const ticks = secs * 60;
const t0 = performance.now();
for (let t = 0; t < ticks; t++) {
  clock.t += 1000 / 60;
  // Each pilot weaves about and fires in bursts
  pilots.forEach((pid, i) => {
    const ph = t / 60 + i;
    if (SPREAD) { Input.fireLeft[pid] = 0; Input.forward[pid] = 0; return; }
    Input.forward[pid] = Math.sin(ph * 0.7) > -0.3 ? 1 : 0;
    Input.left[pid] = Math.sin(ph * 1.3) > 0.6 ? 1 : 0;
    Input.right[pid] = Math.sin(ph * 1.3) < -0.6 ? 1 : 0;
    Input.fireLeft[pid] = Math.sin(ph * 0.5) > 0 ? 1 : 0;
    Input.targetAngle[pid] = ph;
    Rotation.angle[pid] = ph * 0.3;
  });
  const s = performance.now();
  server.step();
  times.push(performance.now() - s);
  if (t % (60 * 30) === 0) { (globalThis as any).gc?.(); console.log(`  t=${t / 60}s heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`); }
  if (t % 120 === 0) { const all = (bitecs as any).getAllEntities(anyServer.world) as number[]; maxLive = Math.max(maxLive, all.length); for (const e of all) if (e > maxEid) maxEid = e; }
}
const wall = performance.now() - t0;
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(2);
const mean = times.reduce((a, b) => a + b, 0) / times.length;
const enemies = [...(server.getShips() as any).bodies.keys()].filter((e: number) => server.enemies.factionOf(e)).length;
console.log(`${PILOTS} pilots, ${secs}s simulated (${ticks} ticks) in ${(wall / 1000).toFixed(1)}s wall`);
console.log(`tick ms: mean ${mean.toFixed(2)} · p50 ${pct(0.5)} · p95 ${pct(0.95)} · p99 ${pct(0.99)} · worst ${times[times.length - 1].toFixed(2)}  (budget 16.67)`);
if (anyServer.lod) console.log(`lod: ${JSON.stringify(anyServer.lod.stats())}`);
console.log(`distant tier ${(spent.lod / ticks * 1000).toFixed(1)} µs/tick · map dots ${(spent.dots / ticks * 1000).toFixed(1)} µs/tick`);
console.log(`by type (KiB/s): ${Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1024 / secs).toFixed(2)}`).join(' · ')}`);
console.log(`ship bodies ${(server.getShips() as any).bodies.size} · hostiles ${enemies} · sent ${(bytes / 1024 / secs).toFixed(1)} KiB/s to all pilots`);
const live = (bitecs as any).getAllEntities(anyServer.world).length;
console.log(`entities: highest id seen ${maxEid} · live now ${live} (peak ${maxLive}) · heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB · buffers ${Math.round(process.memoryUsage().arrayBuffers / 1e6)} MB · rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
void Velocity; void Position;
process.exit(0);
