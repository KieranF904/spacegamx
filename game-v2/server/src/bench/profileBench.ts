/**
 * Profiling bench (measurement only, changes nothing in the game): a busy fight. Several pilots at the Redtooth
 * picket boss's lair in Sol with hostile packs all round them, a few more by the sun with pirate packs, every pilot
 * aiming at the nearest hostile and firing (kept alive). Times each part of the tick on its own (the server's
 * systems, the AI brains, contacts, hurt/splash, SimLod, SystemMemory, snapshots and the outbox), then prints a table.
 * Run (in server/):
 *   npx tsx src/bench/profileBench.ts [--seconds 30] [--packs 14] [--pilots 8]
 *   node --cpu-prof --cpu-prof-dir <dir> --import tsx src/bench/profileBench.ts      (with node's profiler)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Position, Input, Rotation, ClientSocket, splitServerFrame } from '@space-game/common';
import * as bitecs from 'bitecs';
import { Session } from 'node:inspector/promises';
import { writeFileSync } from 'fs';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../ships/createShipBridge.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) || d : d; };
const secs = arg('--seconds', 30);
const PILOTS = arg('--pilots', 8);
const PACKS = arg('--packs', 14);
const BOSS = 'boss_redtooth_picket';

const clock = { t: 1_000_000 };
const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigFromDisk(dataDir)), clock: () => clock.t,
});
const S = server as any;
const bridge = S.ships;

// ---- timers (inclusive ms; nested ones are listed indented and are part of their parent) ----
const spent: Record<string, number> = {};
const calls: Record<string, number> = {};
const wrap = (obj: any, fn: string, key: string) => {
  if (!obj || typeof obj[fn] !== 'function') { console.log(`  (no ${key})`); return; }
  const orig = obj[fn].bind(obj);
  spent[key] = 0; calls[key] = 0;
  obj[fn] = (...a: unknown[]) => { const s = performance.now(); try { return orig(...a); } finally { spent[key] += performance.now() - s; calls[key]++; } };
};
// The tick, part by part (GameServer.tick's order)
for (const [fn, key] of [
  ['drainInputQueue', 'input'], ['stationOrbitSystem', 'stationOrbit'], ['buildSpatialGrid', 'spatialGrid'],
  ['playerMovementSystem', 'playerMovement (pilot physics)'], ['dockingSystem', 'docking'], ['riftSystem', 'rifts'],
  ['weaponSystem', 'weaponSystem (pilot guns)'], ['projectileSystem', 'projectileSystem (shells move+hit)'],
  ['collisionSystem', 'collisionSystem'], ['asteroidDeathSystem', 'asteroidDeath'], ['recordSelfHashes', 'selfHashes'],
  ['watchComet', 'comet'], ['lingerSystem', 'linger'], ['derelictRespawnSystem', 'derelicts'], ['trafficSystem', 'traffic'],
  ['lifetimeSystem', 'lifetime'], ['cleanupSystem', 'cleanup'], ['sendSnapshots', 'sendSnapshots'], ['flushOutbox', 'flushOutbox (encode+send)'],
  ['updatePerfMetrics', 'perfMetrics'], ['reportAdminStats', 'adminStats'],
] as const) wrap(S, fn, key);
for (const [o, key] of [
  ['memory', 'SystemMemory'], ['enemies', 'enemies (spawners, packs)'], ['bosses', 'bosses'], ['mobs', 'mobs'], ['events', 'events'],
  ['surfaces', 'surfaces'], ['sieges', 'sieges'], ['arenas', 'arenas'], ['lod', 'SimLod'], ['ships', 'ShipBridge.tick'],
  ['pods', 'loot pods'], ['mining', 'mining'], ['hazards', 'hazards'], ['warmth', 'warmth'], ['homes', 'homes'], ['pilots', 'pilots'],
  ['quests', 'quests'], ['codex', 'codex'], ['party', 'party'], ['trade', 'trade'], ['ops', 'ops'],
] as const) wrap(S[o], 'tick', key);
wrap(S.replication, 'endTick', 'replication.endTick');
// Inside ShipBridge.tick and the weapons: the parts that matter
wrap(bridge, 'resolveContacts', '  contacts (resolveContacts)');
wrap(bridge, 'fireWeapons', '  fireWeapons (NPC guns, beams)');
wrap(bridge, 'hurt', '  * hurt (any caller)');
wrap(bridge, 'splashAt', '  * splashAt (any caller)');
wrap(bridge, 'segmentHit', '  * segmentHit (any caller)');
// The AI brains (the per-ship controllers ShipBridge.tick calls)
spent['  AI brains (controllers)'] = 0; calls['  AI brains (controllers)'] = 0;
{
  const m: Map<number, any> = bridge.controllers;
  const get = m.get.bind(m);
  m.get = (k: number) => {
    const f = get(k);
    if (!f) return f;
    return (e: number, s: unknown) => { const t = performance.now(); try { return f(e, s); } finally { spent['  AI brains (controllers)'] += performance.now() - t; calls['  AI brains (controllers)']++; } };
  };
}

// ---- pilots ----
let bytes = 0;
const byType: Record<string, number> = {};
const count = (d: string | Uint8Array) => {
  if (typeof d === 'string') return;
  try { for (const m of splitServerFrame(d)) byType[m.msg.type] = (byType[m.msg.type] ?? 0) + m.bytes; } catch { /* */ }
};
const pilots: number[] = [];
const conns: any[] = [];
for (let i = 0; i < PILOTS; i++) {
  const socket: ClientSocket = { isOpen: () => true, send: (d: string | Uint8Array) => { bytes += typeof d === 'string' ? d.length : d.byteLength; count(d); } } as ClientSocket;
  const link = server.connect(socket);
  link.receive({ type: 'join', username: `prof${i}` } as never);
  const pid = server.getPlayerId(socket);
  pilots.push(pid);
  conns.push([...S.clients.values()].find((c: any) => c.playerId === pid));
}
const sol = S.gameData.getSystemNum('sol');
const lair = S.gameData.raw?.bosses?.bosses?.[BOSS]?.lair ?? { x: 60000, y: -64000 };
// 5/8 at the boss, the rest by the sun
const nearBoss = Math.ceil(PILOTS * 5 / 8);
const spotOf = (i: number) => i < nearBoss ? { x: 60000 + 2400 + i * 300, y: -64000 + 1800 } : { x: 9000 + i * 250, y: 2000 };
pilots.forEach((pid, i) => { const p = spotOf(i); S.travelTo(conns[i], sol, p.x, p.y, false); });
for (let i = 0; i < 30; i++) { clock.t += 1000 / 60; server.step(); }
const bossEid = S.bosses.spawn(BOSS);
console.log(`boss ${BOSS} eid ${bossEid} at ${JSON.stringify(lair)}`);
let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const kinds: [string, string[]][] = [
  ['redtooth', ['redtooth_brawler', 'redtooth_cutter', 'redtooth_cutter']], ['pirates', ['pirate_raider', 'pirate_skiff', 'pirate_skiff']],
  ['redtooth', ['redtooth_sledge', 'redtooth_cutter']], ['pirates', ['pirate_gunship', 'pirate_raider']],
];
for (let i = 0; i < PACKS; i++) {
  const sun = i % 3 === 2;
  const c = sun ? spotOf(PILOTS - 1) : spotOf(0);
  const a = rnd() * Math.PI * 2, r = 1500 + rnd() * 2000;
  const [faction, ships] = sun ? kinds[1 + 2 * (i % 2)] : kinds[i % kinds.length];
  server.enemies.spawnPack(sol, { faction: sun ? 'pirates' : faction, ships: sun ? ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] : ships }, c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
}
// A few more packs elsewhere in Sol nobody is near (the distant tier)
for (let i = 0; i < 20; i++) {
  const a = rnd() * Math.PI * 2, r = 40000 + rnd() * 120000;
  server.enemies.spawnPack(sol, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, Math.cos(a) * r, Math.sin(a) * r);
}
for (const k of Object.keys(spent)) { spent[k] = 0; calls[k] = 0; }

const hostiles = () => [...bridge.bodies.keys()].filter((e: number) => server.enemies.factionOf(e));
// --prof <file>: a CPU profile of the tick loop only (not the start-up)
const profAt = process.argv.indexOf('--prof');
const session = profAt >= 0 ? new Session() : null;
if (session) { session.connect(); await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 200 }); await session.post('Profiler.start'); }
const times: number[] = [];
const ticks = secs * 60;
const t0 = performance.now();
let near = 0;
for (let t = 0; t < ticks; t++) {
  clock.t += 1000 / 60;
  const hs = t % 30 === 0 ? hostiles() : null;
  pilots.forEach((pid, i) => {
    // Kept alive (a heal every half second) and fighting: the nearest hostile, weaving
    if (t % 30 === 0) { try { bridge.healAll(pid, 1); } catch { /* */ } }
    if (hs) {
      let best = -1, bd = Infinity;
      for (const e of hs) { const d = (Position.x[e] - Position.x[pid]) ** 2 + (Position.y[e] - Position.y[pid]) ** 2; if (d < bd) { bd = d; best = e; } }
      (pilots as any)[`t${i}`] = best;
      if (bd < 3000 * 3000) near++;
    }
    const tg = (pilots as any)[`t${i}`] ?? -1;
    const ph = t / 60 + i;
    const ang = tg >= 0 ? Math.atan2(Position.y[tg] - Position.y[pid], Position.x[tg] - Position.x[pid]) : ph;
    Input.forward[pid] = Math.sin(ph * 0.7) > 0.2 ? 1 : 0;
    Input.left[pid] = 0; Input.right[pid] = 0;
    Input.fireLeft[pid] = 1;
    Input.targetAngle[pid] = ang;
    Rotation.angle[pid] = ang;
  });
  const s = performance.now();
  server.step();
  times.push(performance.now() - s);
}
const wall = performance.now() - t0;
if (session) { const { profile } = await session.post('Profiler.stop'); writeFileSync(process.argv[profAt + 1], JSON.stringify(profile)); }
times.sort((a, b) => a - b);
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(2);
const total = times.reduce((a, b) => a + b, 0);
console.log(`${PILOTS} pilots, ${PACKS} packs near them + 20 far, ${secs}s simulated in ${(wall / 1000).toFixed(1)}s wall`);
console.log(`tick ms: mean ${(total / ticks).toFixed(2)} · p50 ${pct(0.5)} · p95 ${pct(0.95)} · p99 ${pct(0.99)} · worst ${times[times.length - 1].toFixed(2)}`);
console.log(`hostiles now ${hostiles().length} · bodies ${bridge.bodies.size} · boss alive ${bossEid >= 0 && bridge.has(bossEid)} · pilot-near-hostile samples ${near}`);
console.log(`lod: ${JSON.stringify(S.lod?.stats?.())}`);
console.log(`sent ${(bytes / 1024 / secs).toFixed(1)} KiB/s · by type: ${Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${(v / 1024 / secs).toFixed(1)}`).join(' · ')}`);
console.log('\npart of tick                               µs/tick   % of step   calls/tick');
for (const [k, v] of Object.entries(spent).sort((a, b) => b[1] - a[1])) {
  if (v / ticks < 0.0005) continue;
  console.log(`${k.padEnd(42)} ${(v / ticks * 1000).toFixed(1).padStart(8)}   ${(v / total * 100).toFixed(1).padStart(6)}%   ${(calls[k] / ticks).toFixed(1).padStart(8)}`);
}
console.log(`(entities live ${(bitecs as any).getAllEntities(S.world).length}, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB)`);
process.exit(0);
