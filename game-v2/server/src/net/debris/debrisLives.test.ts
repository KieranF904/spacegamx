/**
 * Debris a client runs itself (CAPS.DEBRIS; common ships/debrisLife.ts, client ships/debris/DebrisLives.ts): freighters
 * shot apart a part at a time, then one blown up whole, and every piece left to drift, knock and crumble away. A client
 * running its pieces has each exactly as the server does at every snapshot, through their grace and its end, every
 * crumble and the pieces those break into, with no keyframe, sync or crumble effect of a piece it runs after its spawn.
 * A client keeping each structure by tick (CAPS.STRUCTS, no DEBRIS) recentres the pieces from their syncs and is exact
 * too; a legacy client is kept right by keyframes.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, CAPS, DEBRIS_GRACE_TICKS, type ReplicaEnv, type ClientMessage, type ServerMessage, type ServerSnapshotMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const STRUCTS = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.INPUTS | CAPS.BODIES | CAPS.CAUSES | CAPS.STRUCTS;
const RUNS = STRUCTS | CAPS.DEBRIS;

interface Seen { kfRun: number; syncRun: number; crumbleRun: number; checked: number; off: string[]; keyframes: number }

function fight(ticks: number) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: RUNS,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'runs', caps: RUNS, env });
  const C = new FakeHitsClient(server, { name: 'structs', caps: STRUCTS, env });
  const B = new FakeHitsClient(server, { name: 'legacy', caps: 0, env });
  const fakes = [A, C, B];
  const seen = new Map<FakeHitsClient, Seen>(fakes.map((f) => [f, { kfRun: 0, syncRun: 0, crumbleRun: 0, checked: 0, off: [], keyframes: 0 }]));
  let seq = 1;
  // (Each piece's state as each tick left it: frames may wait a few ticks, coalesced)
  const real = new Map<number, Map<number, number[]>>();
  const step = () => {
    server.step();
    clock.t += 1000 / 60;
    const now = new Map<number, number[]>();
    for (const [id, ship] of ships.bodies) if (ship.kind === 'debris') now.set(id, [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ship.angVel]);
    real.set(server.getTick(), now);
    real.delete(server.getTick() - 30);
    for (const f of fakes) {
      // (Its confirmations of the pieces it worked out, on an input as a client sends them)
      const acks = f.debris.takeAcks();
      if (acks) f.link!.receive({ type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, acks } as unknown as ClientMessage);
      f.flushUp();
    }
  };
  for (let i = 0; i < 30; i++) step();
  for (const f of fakes) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); }
  const sys = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  for (const [k, f] of fakes.entries()) { Position.x[f.pid] = x0 - 200 * k; Position.y[f.pid] = y0 + 300 * k; Velocity.x[f.pid] = 0; Velocity.y[f.pid] = 0; }
  const bp = ships.library.get('hauler')!;
  const haulers = [0, 1, 2].map((i) => ships.spawnDummy(bp, x0 + 700 + 260 * i, y0 - 150 + 170 * i, 0.4 * i, sys));
  // What each client is sent of the pieces it runs, and its state of every piece it holds against the server's
  for (const f of fakes) {
    const s = seen.get(f)!, fa = f as unknown as { handle(m: ServerMessage): void; snapshot(m: ServerSnapshotMessage): void };
    const oh = fa.handle.bind(f), os = fa.snapshot.bind(f);
    fa.handle = (m) => {
      if (m.type === 'shipSync' && f.debris.lives.has(m.id)) s.syncRun++;
      if (m.type === 'partDestroyed' && m.how === 'crumble' && f.debris.lives.has(m.bodyId)) s.crumbleRun++;
      oh(m);
    };
    fa.snapshot = (m) => {
      for (const k of m.ships ?? []) { if (f.debris.lives.has(k[0])) s.kfRun++; if (ships.get(k[0])?.kind === 'debris') s.keyframes++; }
      os(m);
      for (const id of f.reps.ids()) {
        // (A frame that went at once: sent at the tick's end, the state now)
        const ship = ships.get(id), now = m.tick === server.getTick() && ship?.kind === 'debris' ? [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ship.angVel] : undefined;
        const want = real.get(m.tick)?.get(id) ?? now, st = f.reps.at(id, m.tick)?.body;
        if (!want || !st) continue;
        s.checked++;
        const mine = [st.x, st.y, st.vx, st.vy, st.angle, st.angVel];
        if (mine.some((v, i) => v !== want[i]) && s.off.length < 10) s.off.push(`${f === A ? 'A' : f === C ? 'C' : 'B'} tick ${m.tick} piece ${id} (${f.debris.lives.has(id) ? 'runs' : 'sent'}): ${mine.join(',')} vs ${want.join(',')}`);
      }
    };
  }
  // Parts shot away, a few at a time, seeded
  let r = 7;
  const rnd = () => { r = (Math.imul(r, 1664525) + 1013904223) >>> 0; return r / 4294967296; };
  const pairsYoung = { justPast: 0 };
  for (let t = 0; t < ticks; t++) {
    if (t < 420 && t % 10 === 0) {
      const live = haulers.filter((h) => ships.has(h));
      const h = live[Math.floor(rnd() * live.length)], sp = h !== undefined ? ships.get(h) : undefined;
      const parts = sp ? sp.blueprint.parts.map((_, i) => i).filter((i) => sp.derived.alive[i] && sp.blueprint.parts[i].fn !== 'core') : [];
      if (parts.length) ships.damagePartFraction(h, parts[Math.floor(rnd() * parts.length)], 1);
    }
    // One blown up whole: its core gone, every part breaks away
    if (t === 300 && ships.has(haulers[2])) { const sp = ships.get(haulers[2])!; ships.damagePartFraction(haulers[2], sp.blueprint.parts.findIndex((p) => p.fn === 'core'), 1); }
    step();
    // (Knocks between pieces just past their grace: the grace ends with them where it found them, overlapping or not)
    for (const [a, c] of ships.debrisNet.pairs) for (const id of [a, c]) { const age = server.getTick() - (ships.get(id)?.spawnTick ?? -1e9); if (age > DEBRIS_GRACE_TICKS && age <= DEBRIS_GRACE_TICKS + 60) pairsYoung.justPast++; }
  }
  return { server, A, B, C, seen: (f: FakeHitsClient) => seen.get(f)!, pairsYoung };
}

describe('debris a client runs itself (CAPS.DEBRIS)', () => {
  it('freighters shot apart and blown up: every piece exact through its life, nothing sent of the ones it runs', () => {
    const r = fight(1500);
    const a = r.seen(r.A), c = r.seen(r.C), b = r.seen(r.B);
    if (process.env.DEBRIS_DEBUG) console.log(JSON.stringify({ a, c, b, lives: r.A.debris.lives.stats, splits: r.A.debris.stats, acks: (r.server as unknown as { snapshots: { debrisAcks: object } }).snapshots.debrisAcks, pairs: r.pairsYoung }));
    // It ran pieces, which crumbled and broke up, and it worked every bit of it out
    expect(r.A.debris.lives.stats.pieces).toBeGreaterThan(20);
    expect(r.A.debris.lives.stats.crumbles).toBeGreaterThan(20);
    expect(a.off).toEqual([]);
    expect(a.checked).toBeGreaterThan(1000);
    expect(a.kfRun + a.syncRun + a.crumbleRun).toBe(0);
    // (...pieces knocking just past their grace among them: the grace ends where it found them, in contact or not)
    expect(r.pairsYoung.justPast).toBeGreaterThan(0);
    // Keeping structures by tick: exact as well, from its syncs
    expect(c.off).toEqual([]);
    // Legacy: kept right by keyframes (many more of them). (It works a split out from its parent as it has it before the
    // snapshot that recentred it, so a piece or two it gets wrong; its check says so and that one is sent to it)
    expect(b.keyframes).toBeGreaterThan(a.keyframes + 50);
    expect(b.off.length).toBeLessThanOrEqual(3);
  }, 240_000);
});
