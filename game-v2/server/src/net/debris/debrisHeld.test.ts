/**
 * Debris a client works out itself (debrisSplit) and what the server holds back of it until confirmed:
 * - HP at the split: a ship whose core is shot out blows up on that tick (the core's part blast, delay 0: tuning.json
 *   partBlast), the blast hurting the parts that are about to break away, and the ship is gone before its HP could be
 *   sent. The client works the pieces out from the HP it has of the ship, so the split gives the pieces' HP (debrisSplit
 *   `h`) when that isn't the server's. (The pirate fight's debris HP mismatch: a Pirate Skiff's pieces with the blast's
 *   damage missing, put right only by hpCheck / hpResync.)
 * - Touched in its hold: a piece shot or blasted before the client's confirmation arrives (DebrisNet.told) loses a part
 *   and what's left is recentred, which the client can't work out, and nothing of a held piece goes: it was off by the
 *   recentre (a unit or a few) until its confirmation, or for good if it was gone first (the causes test's "debris off
 *   in its last ticks"). It goes in full now, sync and keyframe.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, Rotation, InSystem, hpWire, type ReplicaEnv, type ClientMessage, type ServerMessage, type ServerSnapshotMessage } from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** A server, a client watching a target freighter 700 off; `acks`: whether its confirmations of the debris it works out go up */
function world(opts: { acks: boolean }) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(readGameDataFiles(dataDir)),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false, ships: createShipBridge(loadShipConfigCached(dataDir)), clock: () => clock.t,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'watcher', env });
  let seq = 1;
  const splits: { id: number; h: boolean }[] = [], mismatches: number[] = [];
  // (Each debris piece's state as each tick left it, and each one the client held at a snapshot off it, no keyframe)
  const real = new Map<number, Map<number, number[]>>();
  const off: string[] = [];
  let checked = 0;
  const fa = A as unknown as { handle(m: ServerMessage): void; snapshot(s: ServerSnapshotMessage): void };
  const oh = fa.handle.bind(A), os = fa.snapshot.bind(A);
  fa.handle = (m) => { if (m.type === 'debrisSplit') splits.push({ id: m.id, h: !!m.h }); oh(m); };
  fa.snapshot = (s) => {
    os(s);
    const keyed = new Set((s.ships ?? []).map((k) => k[0]));
    for (const id of A.reps.ids()) {
      const want = real.get(s.tick)?.get(id), st = A.reps.at(id, s.tick)?.body;
      if (!want || !st || keyed.has(id)) continue;
      checked++;
      const mine = [st.x, st.y, st.vx, st.vy, st.angle, st.angVel];
      if (mine.some((v, i) => v !== want[i])) off.push(`piece ${id} tick ${s.tick}: ${mine.map((v, i) => +(v - want[i]).toFixed(3)).join(',')}`);
    }
  };
  const oc = A.hits.check.bind(A.hits);
  A.hits.check = (m) => { const before = A.hits.stats.mismatches; oc(m); if (A.hits.stats.mismatches > before) mismatches.push(m.id); };
  const step = () => {
    server.step();
    clock.t += 1000 / 60;
    const now = new Map<number, number[]>();
    for (const [id, ship] of ships.bodies) if (ship.kind === 'debris') now.set(id, [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ship.angVel]);
    real.set(server.getTick(), now);
    real.delete(server.getTick() - 120);
    const acks = A.debris.takeAcks();
    if (acks && opts.acks) A.link!.receive({ type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, acks } as unknown as ClientMessage);
    A.flushUp();
  };
  for (let i = 0; i < 30; i++) step();
  const c = server.pilots.connOf(A.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' });
  const sys = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  const h = ships.spawnDummy(ships.devDesigns['target-freighter'], x0 + 700, y0, 0.3, sys);
  for (let i = 0; i < 90; i++) step();
  expect(A.store.get(h)).toBeTruthy();
  /** Its core shot out: the core's blast lands on this tick, then the ship splits into pieces and is gone */
  const blowUp = () => {
    const before = new Set(ships.bodies.keys());
    const core = ships.get(h)!.blueprint.parts.findIndex((p) => p.fn === 'core');
    ships.damagePartFraction(h, core, 1);
    step();
    expect(ships.has(h)).toBe(false);
    return [...ships.bodies].filter(([id, s]) => s.kind === 'debris' && !before.has(id)).map(([id]) => id);
  };
  return { server, ships, A, h, step, blowUp, splits, mismatches, off, checked: () => checked };
}

describe('debris worked out on the client, held till confirmed (debrisSplit)', () => {
  it("a ship blown up by its core's blast: every piece it works out has the server's HP", () => {
    const w = world({ acks: true }), { ships, A } = w;
    const pieces = w.blowUp();
    expect(pieces.length).toBeGreaterThan(0);
    // (the blast hurt what broke away: the case at hand)
    expect(pieces.some((id) => { const s = ships.get(id)!; return s.hp.some((v, i) => v > 0 && v < s.maxHp[i]); })).toBe(true);
    for (let i = 0; i < 240; i++) w.step();
    expect(w.splits.some((s) => s.id === w.h)).toBe(true);
    let checked = 0;
    for (const id of pieces) {
      const s = ships.get(id), mine = A.store.get(id);
      if (!s || !mine) continue;
      checked++;
      expect([id, ...mine.hp.map((v) => +v.toFixed(1))]).toEqual([id, ...s.hp.map(hpWire)]);
    }
    expect(checked).toBeGreaterThan(0);
    expect(w.mismatches).toEqual([]);
    expect(w.off).toEqual([]);
  }, 120_000);

  it('a piece shot before its confirmation arrives (a part broken off, what is left recentred): sent in full, never off', () => {
    // (Its confirmations never arrive: the hold lasts till its time runs out)
    const w = world({ acks: false }), { ships, A } = w;
    const pieces = w.blowUp();
    const many = (p: number) => ships.get(p)!.derived.alive.filter(Boolean).length >= 2;
    for (let i = 0; i < 20 && !pieces.some((p) => A.reps.has(p) && many(p)); i++) w.step();
    // (a piece of several parts it holds, worked out itself and not yet confirmed)
    const id = pieces.find((p) => A.reps.has(p) && many(p))!;
    expect(id).toBeDefined();
    const conn = w.server.pilots.connOf(A.pid)! as unknown as { debrisHeld: Map<number, unknown> };
    expect(conn.debrisHeld.has(id)).toBe(true);
    // A shot takes one of its parts off: it's rebuilt and recentred
    const s = ships.get(id)!, part = s.derived.alive.findIndex((a, i) => a && i !== s.derived.root);
    ships.damagePartFraction(id, part >= 0 ? part : s.derived.alive.indexOf(true), 1);
    w.step();
    expect(ships.has(id)).toBe(true);
    // (Where it has it on the server's tick, each tick: off by the recentre till the server's word comes, a snapshot or
    // two; before, it stayed off for as long as it was held: no snapshot came of it at all, a quiet window)
    const ahead: string[] = [];
    for (let i = 0; i < 20; i++) {
      w.step();
      const t = w.server.getTick(), st = A.reps.at(id, t)?.body;
      const mine = st ? [st.x, st.y, st.vx, st.vy, st.angle, st.angVel] : [], want = [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ships.get(id)!.angVel];
      if (i >= 8 && (!st || mine.some((v, k) => v !== want[k]))) ahead.push(`tick ${t}: ${mine.map((v, k) => +(v - want[k]).toFixed(3)).join(',')}`);
    }
    expect(ahead).toEqual([]);
    // What it holds of it is the server's at every snapshot, HP too: it went in full (no longer held)
    expect(w.checked()).toBeGreaterThan(3);
    expect(w.off).toEqual([]);
    expect(A.store.get(id)!.hp.map((v) => +v.toFixed(1))).toEqual(ships.get(id)!.hp.map(hpWire));
    expect(conn.debrisHeld.has(id)).toBe(false);
  }, 120_000);
});
