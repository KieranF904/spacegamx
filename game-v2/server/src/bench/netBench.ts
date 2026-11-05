/**
 * Network benchmark: a server in this process with a few pilots in a running
 * fight, counting what each pilot is sent (bytes by message type) and how long
 * the server spends building snapshots. Run: npm run bench:net (in server/)
 *
 *   --spread   pilots far apart in the same system (tests interest management)
 *   --gap N    with --spread, metres between pilots (default 18000)
 *   --seconds N
 *   --sample   print one of each message type (pilot 0)
 */

import { join, dirname } from 'path';
import { createDeflateRaw, constants as zc } from 'zlib';
import { fileURLToPath } from 'url';
import { Position, Velocity, Input, InSystem, ClientSocket, ReplicaMode, replicaAngle, quantizeReplicaAngle, splitServerFrame, encodeBinary } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '../../../data');
const spread = process.argv.includes('--spread');
const gap = Number(process.argv[process.argv.indexOf('--gap') + 1]) || 18000;
const secs = Number(process.argv[process.argv.indexOf('--seconds') + 1]) || 20;
const PILOTS = 4;
const sample = process.argv.includes('--sample');
/** Pilot 0's frames, to see what per-message deflate (with context takeover) would make of them */
const frames0: Buffer[] = [];
const samples: Record<string, string> = {};
let measuring = false;

const clock = { t: 1_000_000 };
const server = new GameServer({
  gameData: new GameData(readGameDataFiles(dataDir)),
  userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
  scene: 'sectors',
  autoStart: false,
  ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
  clock: () => clock.t,
});

// Pilots on sockets that only count what they're sent
const counts: { bytes: Record<string, number>; msgs: Record<string, number> }[] = [];
const links = Array.from({ length: PILOTS }, (_, i) => {
  const c = { bytes: {} as Record<string, number>, msgs: {} as Record<string, number> };
  counts.push(c);
  const socket: ClientSocket = {
    isOpen: () => true,
    send: (data) => {
      const len = typeof data === 'string' ? Buffer.byteLength(data) : (data as ArrayBuffer).byteLength;
      c.bytes['(frames)'] = (c.bytes['(frames)'] ?? 0) + 0;
      c.msgs['(frames)'] = (c.msgs['(frames)'] ?? 0) + 1;
      c.bytes['(total bytes)'] = (c.bytes['(total bytes)'] ?? 0) + len;
      c.msgs['(total bytes)'] = (c.msgs['(total bytes)'] ?? 0) + 0;
      if (i === 0 && measuring) frames0.push(Buffer.from(data as Uint8Array));
      const add = (k: string, n: number) => { c.bytes[k] = (c.bytes[k] ?? 0) + n; c.msgs[k] = (c.msgs[k] ?? 0) + 1; };
      const size = (v: unknown) => encodeBinary(v).length;
      for (const { msg, wire, bytes } of splitServerFrame(data as Uint8Array)) {
        const type = msg.type;
        if (type === 'shipSync' && measuring) add((msg as { blueprint?: unknown }).blueprint ? '  sync.design' : '  sync.rebuild', bytes);
        if (type === 'snapshot' && measuring) {
          // What snapshots are made of: entity rows by type, projectiles, keyframes, control rows, removals
          const w = wire as unknown[];
          const [e, p, r, k, ctl, f] = [w[3], w[4], w[5], w[6], w[7], w[9]] as unknown[][];
          for (const row of f ?? []) add('  snap.fire', size(row));
          for (const row of e ?? []) add(`  snap.e.type${(row as number[])[1]}`, size(row));
          for (const row of p ?? []) add('  snap.projectile', size(row));
          for (const row of k ?? []) add('  snap.keyframe', size(row));
          for (const row of ctl ?? []) add('  snap.ctl', size(row));
          if (r) add('  snap.removed', size(r));
          if (i === 0 && (samples['(ctl rows)'] ?? '').length < 600 && ctl) samples['(ctl rows)'] = (samples['(ctl rows)'] ?? '') + JSON.stringify(ctl) + ' ';
        }
        if (i === 0 && measuring && !samples[type]) samples[type] = `${bytes} bytes binary, as JSON ${JSON.stringify(wire).slice(0, 600)}`;
        add(type, bytes);
      }
    },
  };
  const link = server.connect(socket);
  link.receive({ type: 'join', username: `bench${i}` } as never);
  return { link, socket };
});
const pids = () => links.map((l) => server.getPlayerId(l.socket));

const home = { x: 26000, y: 21000 };
const spot = (i: number) => (spread ? { x: home.x - 30000 + i * gap, y: home.y - 10000 * (i % 2) } : { x: home.x + i * 700, y: home.y });
const place = () => pids().forEach((p, i) => { const s = spot(i); Position.x[p] = s.x; Position.y[p] = s.y; Velocity.x[p] = 0; Velocity.y[p] = 0; });
place();
server.step();
const num = InSystem.systemId[pids()[0]];
// Hostiles around each pilot (or the group), not passive
const packs = spread ? pids().map((_, i) => spot(i)) : [home, home];
for (const s of packs) server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, s.x + 1500, s.y + 900);

// Measure the snapshot builder on its own
let snapMs = 0, snaps = 0;
const proto = server as unknown as { sendSnapshots(): void };
const orig = proto.sendSnapshots.bind(server);
proto.sendSnapshots = () => { const t0 = performance.now(); orig(); snapMs += performance.now() - t0; snaps++; };

// Warm up, then reset the counters
for (let i = 0; i < 120; i++) server.step();
for (const c of counts) { c.bytes = {}; c.msgs = {}; }
measuring = true;
snapMs = 0; snaps = 0;
server.replication.keyframes = 0;
for (const k of Object.keys(server.replication.reasons)) delete server.replication.reasons[k];

const ticks = secs * 60;
let stepMs = 0;
for (let i = 0; i < ticks; i++) {
  // Pilots hold position and shoot at the nearest hostile
  pids().forEach((p, k) => {
    const s = spot(k);
    Position.x[p] = s.x; Position.y[p] = s.y; Velocity.x[p] = 0; Velocity.y[p] = 0;
    let best = -1, bd = Infinity;
    for (const [eid] of server.getShips().bodies) {
      if (!server.enemies.factionOf(eid) || InSystem.systemId[eid] !== num) continue;
      const d = Math.hypot(Position.x[eid] - s.x, Position.y[eid] - s.y);
      if (d < bd) { bd = d; best = eid; }
    }
    Input.fireLeft[p] = best >= 0 && bd < 2500 ? 1 : 0;
    if (best >= 0) { Input.targetAngle[p] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(Position.y[best] - s.y, Position.x[best] - s.x))); Input.cursorDist[p] = bd; }
  });
  // Keep the fight going
  if (i % 300 === 0 && server.enemies.count(num) < 6) for (const s of packs) server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff'] }, s.x + 1600, s.y - 800);
  const t0 = performance.now();
  server.step();
  stepMs += performance.now() - t0;
  clock.t += 1000 / 60;
}

const total: Record<string, { bytes: number; msgs: number }> = {};
for (const c of counts) for (const [k, v] of Object.entries(c.bytes)) {
  total[k] = total[k] ?? { bytes: 0, msgs: 0 };
  total[k].bytes += v;
  total[k].msgs += c.msgs[k];
}
const perPilotSec = (n: number) => n / PILOTS / secs;
const rows = Object.entries(total).sort((a, b) => b[1].bytes - a[1].bytes);
const sum = total['(total bytes)']?.bytes ?? 0;
const msgs = total['(frames)']?.msgs ?? 0;
console.log(`\n${spread ? 'SPREAD' : 'TOGETHER'}: ${PILOTS} pilots, ${secs}s, ${server.enemies.count(num)} hostiles at the end`);
console.log(`per pilot: ${(perPilotSec(sum) / 1024).toFixed(1)} KB/s, ${perPilotSec(msgs).toFixed(0)} frames/s`);
for (const [k, v] of rows.slice(0, 28)) console.log(`  ${k.padEnd(16)} ${(perPilotSec(v.bytes) / 1024).toFixed(2).padStart(8)} KB/s  ${perPilotSec(v.msgs).toFixed(1).padStart(6)} msg/s`);
console.log(`replication: ${(server.replication.keyframes / PILOTS / secs).toFixed(1)} keyframes/s per pilot; why ships left their path: ${JSON.stringify(server.replication.reasons)}`);
console.log(`server: ${(stepMs / ticks).toFixed(3)} ms per tick, snapshots ${(snapMs / Math.max(1, snaps)).toFixed(3)} ms each (${snaps})`);
// What permessage-deflate would make of it: one deflate stream per connection, flushed per frame
const raw0 = frames0.reduce((n, f) => n + f.length, 0);
for (const [label, opts] of [['level 1, 2 KB window', { level: 1, windowBits: 11, memLevel: 4 }], ['level 4, 8 KB window (live)', { level: 4, windowBits: 13, memLevel: 6 }], ['level 6, 32 KB window', { level: 6, windowBits: 15, memLevel: 8 }]] as const) {
  const z = createDeflateRaw(opts);
  let zBytes = 0;
  z.on('data', (d: Buffer) => { zBytes += d.length; });
  for (const f of frames0) { z.write(f); await new Promise<void>((r) => z.flush(zc.Z_SYNC_FLUSH, () => r())); }
  console.log(`deflate (${label}): pilot 0 ${(raw0 / secs / 1024).toFixed(2)} -> ${(zBytes / secs / 1024).toFixed(2)} KB/s`);
}
if (sample) for (const [k, v] of Object.entries(samples)) console.log(`
${k}: ${v.slice(0, 700)}`);
process.exit(0);
