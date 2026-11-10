/**
 * A pilot's own shells (CAPS.OWN_SHOTS and SHOT_IDS, snapshot/ownShots.ts): the client builds them on its tick layer
 * from its own ship as it steps it, not its prediction, and they are the server's shells bit for bit, so the hits it
 * finds itself agree with the server's every time; no projectile rows of its own shells reach it. A window its ship is
 * knocked in (a keyframe) has its own shells' hits told; a correction of its prediction, or a prediction that's simply
 * wrong, changes nothing on that layer.
 *
 * A real GameServer and the shooter (a fake client, full caps). What it was shown is held to the server's own record of
 * the fight (hits/serverTruth.testkit.ts).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { defineQuery } from 'bitecs';
import {
  Position, Velocity, Input, InSystem, Projectile, ReplicaMode, replicaAngle, quantizeReplicaAngle, isOwnShotWire, type ReplicaEnv,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { serverTruth, damageOff } from '../hits/serverTruth.testkit.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const projQ = defineQuery([Projectile]);

interface FightOpts {
  /** Ticks a correction of its prediction is forced on (the server's own row corrects it) */
  forceAt?: number[];
  /** Ticks its ship is knocked on (velocity changed under it: the shadow is off, a keyframe goes) */
  knockAt?: number[];
  /** Its prediction off (the cosmetic layer only) */
  predictionError?: (tick: number) => { dx: number; dy: number; da: number } | null;
}

function fight(o: FightOpts = {}) {
  const forceAt = o.forceAt ?? [], knockAt = o.knockAt ?? [];
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'own_shooter', env, predictionError: o.predictionError });
  const record = serverTruth(server);
  // (The shooter's report as riding an input that goes on time anyway: straight to the ledger. Sent as an input of its
  // own here it would land late, set the pilot's controls to nothing and count as a late input: a correction)
  const upA = () => {
    const rep = A.selfHits.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
  };
  const step = () => { server.step(); clock.t += 1000 / 60; upA(); };
  for (let i = 0; i < 20; i++) step();
  { const c = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(A.pid, x0, y0);
  const target = ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  // The server's own shells as spawned, by id and spawn tick, to compare with what the client built
  const truth = new Map<string, number[]>();
  const shooterShells = () => {
    for (const eid of projQ(server.getWorld())) {
      if (Projectile.ownerId[eid] !== A.pid) continue;
      const k = `${eid}:${Projectile.spawnTick[eid]}`;
      if (!truth.has(k)) truth.set(k, [Projectile.spawnX[eid], Projectile.spawnY[eid], Velocity.x[eid], Velocity.y[eid]]);
    }
  };
  // Each own shell the client has (once), against the server's (a pilot's shells: the tick after the client's spawnTick).
  // Those it built itself are named by shot id: the server's entity id from its records (ownWire)
  let exact = 0, inexact = 0, shells = 0;
  const seen = new Set<string>();
  const check = () => {
    for (const [id, sh] of A.shells) {
      const eid = isOwnShotWire(id) ? A.ownWire.get(id) : id;
      const k = `${eid}:${sh.spawnTick + 1}`;
      if (sh.owner !== A.pid || seen.has(k) || !truth.has(k)) continue;
      seen.add(k);
      shells++;
      const t = truth.get(k)!;
      if (sh.x === t[0] && sh.y === t[1] && sh.vx === t[2] && sh.vy === t[3]) exact++; else inexact++;
    }
  };
  let rows0 = 0, fired0 = 0, derived0 = 0;
  for (let t = 0; t < 600; t++) {
    // (from here on: the first windows after it was put in place and given its ship are corrections)
    if (t === 30) { rows0 = A.ownRows; fired0 = A.ownFired; derived0 = A.ownDerived; exact = 0; inexact = 0; shells = 0; }
    for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][A.pid] = 0;
    if (ships.has(target)) {
      const dx = Position.x[target] - Position.x[A.pid], dy = Position.y[target] - Position.y[A.pid];
      Input.targetAngle[A.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
      Input.cursorDist[A.pid] = Math.hypot(dx, dy);
      Input.fireLeft[A.pid] = 1; Input.fireRight[A.pid] = 1;
    }
    // (a correction of its prediction the server makes: its own row goes as a correction)
    if (forceAt.includes(t)) (server.pilots.connOf(A.pid)! as unknown as { forceSnapshot: boolean }).forceSnapshot = true;
    // (a knock: its ship moves off what its tick layer would do, so it's keyframed and that window's own shells' hits are told)
    if (knockAt.includes(t)) { Velocity.x[A.pid] += 1.5; Velocity.y[A.pid] -= 1; }
    step();
    shooterShells();
    check();
  }
  for (const k of ['fireLeft', 'fireRight'] as const) Input[k][A.pid] = 0;
  for (let t = 0; t < 90; t++) step();
  (server.pilots.connOf(A.pid)! as unknown as { packed?: { drain(t: number): number } }).packed?.drain(server.getTick());
  return {
    server, A, record, exact, inexact, shells, rows: A.ownRows - rows0, fired: A.ownFired - fired0, derived: A.ownDerived - derived0,
    journal: server.hits.journalStats([server.pilots.connOf(A.pid)! as never]),
  };
}

describe('own shells built on its tick layer (CAPS.OWN_SHOTS, SHOT_IDS)', () => {
  it("are built exactly from its own ship: no rows or fire records of its own shells, every hit it finds agrees", () => {
    const r = fight();
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact, rows: r.A.ownRows, derived: r.derived, journal: r.journal, stats: r.server.hits.stats }));
    expect(r.derived).toBeGreaterThan(50);
    expect(r.rows).toBe(0);
    expect(r.fired).toBe(0);
    expect(r.shells).toBeGreaterThan(50);
    expect(r.exact).toBe(r.shells);
    expect(r.inexact).toBe(0);
    // Its hits found itself, all agreeing: no disagreement, no correction
    expect(r.server.hits.stats.own).toBeGreaterThan(20);
    expect(r.journal.disagreed).toBe(0);
    expect(r.journal.fixes).toBe(0);
    expect(r.A.hits.stats.mismatches).toBe(0);
    // The hits and damage the server had
    expect(r.A.projectileHits).toBe(r.record.impacts);
    expect(damageOff(r.A.damage, r.record.damage, 0.051 * (r.A.hits.stats.records + r.A.hits.stats.own) + 0.2)).toEqual([]);
  }, 120_000);

  it('a correction of its prediction, or a prediction simply wrong, changes nothing on the tick-aligned layer', () => {
    // (a stretch of corrections: every snapshot from tick 60 to 120 corrects it; and a prediction off by up to 6 units)
    const r = fight({ forceAt: Array.from({ length: 60 }, (_, i) => 60 + i), predictionError: (t) => ({ dx: 6 * Math.sin(t / 7), dy: 4 * Math.cos(t / 11), da: 0.05 * Math.sin(t / 5) }) });
    expect(r.derived).toBeGreaterThan(50);
    expect(r.rows).toBe(0);
    expect(r.exact).toBe(r.shells);
    expect(r.inexact).toBe(0);
    expect(r.server.hits.stats.own).toBeGreaterThan(20);
    expect(r.journal.disagreed).toBe(0);
    expect(r.journal.fixes).toBe(0);
    expect(r.A.hits.stats.mismatches).toBe(0);
  }, 120_000);

  it("a window its ship is knocked in has its own shells' hits told, not found", () => {
    const r = fight({ knockAt: Array.from({ length: 20 }, (_, i) => 60 + i * 12) });
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact, rows: r.rows, derived: r.derived, toldWhy: r.server.hits.stats.toldWhy }));
    // (no rows even so: the knocked window's shells are built here too, and their hits told)
    expect(r.rows).toBe(0);
    expect(r.derived).toBeGreaterThan(40);
    expect(r.exact).toBeGreaterThan(40);
    expect(r.server.hits.stats.toldWhy.oldWay ?? 0).toBeGreaterThan(0);
    expect(r.journal.disagreed).toBe(0);
    expect(r.journal.fixes).toBe(0);
    expect(r.A.hits.stats.mismatches).toBe(0);
    expect(r.A.projectileHits).toBe(r.record.impacts);
  }, 120_000);
});
