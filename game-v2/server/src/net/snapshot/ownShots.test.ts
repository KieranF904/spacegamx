/**
 * A pilot's own shells as fire events (CAPS.OWN_SHOTS, snapshot/ownShots.ts): the client builds them from its own
 * ship's pose on the fire tick (the fake's is the server's, as a prediction that held), and they are the server's
 * shells bit for bit, so the hits it finds itself agree with the server's every time; no projectile rows of its own
 * shells reach it. A window the server corrects its ship in (here: a forced correction) gets rows, as before.
 *
 * A real GameServer, the shooter finding its own hits with OWN_SHOTS (and packed, coalesced frames), a legacy observer.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { defineQuery } from 'bitecs';
import {
  Position, Velocity, Input, InSystem, Projectile, CAPS, ReplicaMode, replicaAngle, quantizeReplicaAngle, type ReplicaEnv,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const ALL = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS;
const projQ = defineQuery([Projectile]);

function fight(caps: number, forceAt: number[] = []) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigFromDisk(dataDir)),
    clock: () => clock.t,
    netCaps: ALL,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'own_shooter', caps, env });
  const B = new FakeHitsClient(server, { name: 'legacy_obs', caps: 0, env });
  // (The shooter's report as riding an input that goes on time anyway: straight to the ledger. Sent as an input of its
  // own here it would land late, set the pilot's controls to nothing and count as a late input: a correction)
  const upA = () => {
    const rep = A.selfHits?.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
  };
  const step = () => { server.step(); clock.t += 1000 / 60; upA(); B.flushUp(); };
  for (let i = 0; i < 20; i++) step();
  for (const f of [A, B]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(A.pid, x0, y0);
  place(B.pid, x0 - 300, y0 + 400);
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
  // Each own shell the client was told of (once), against the server's (a pilot's shells: the tick after the client's spawnTick)
  let exact = 0, inexact = 0;
  const seen = new Set<string>();
  const check = () => {
    for (const [id, sh] of A.shells) {
      const k = `${id}:${sh.spawnTick + 1}`;
      if (sh.owner !== A.pid || seen.has(k) || !truth.has(k)) continue;
      seen.add(k);
      const t = truth.get(k)!;
      if (sh.x === t[0] && sh.y === t[1] && sh.vx === t[2] && sh.vy === t[3]) exact++; else inexact++;
    }
  };
  let rowsAtForce = 0, rows0 = 0, fired0 = 0;
  for (let t = 0; t < 600; t++) {
    // (from here on: the first windows after it was put in place and given its ship are corrections, rows as ever)
    if (t === 30) { rows0 = A.ownRows; fired0 = A.ownFired; exact = 0; inexact = 0; }
    for (const k of ['forward', 'backward', 'left', 'right', 'fireLeft', 'fireRight', 'boost'] as const) Input[k][A.pid] = 0;
    if (ships.has(target)) {
      const dx = Position.x[target] - Position.x[A.pid], dy = Position.y[target] - Position.y[A.pid];
      Input.targetAngle[A.pid] = replicaAngle(ReplicaMode.Player, quantizeReplicaAngle(Math.atan2(dy, dx)));
      Input.cursorDist[A.pid] = Math.hypot(dx, dy);
      Input.fireLeft[A.pid] = 1; Input.fireRight[A.pid] = 1;
    }
    // (a correction the server makes: the window's own shells go as rows)
    if (forceAt.includes(t)) { server.pilots.connOf(A.pid)!.forceSnapshot = true; rowsAtForce = A.ownRows; }
    step();
    shooterShells();
    check();
  }
  for (const k of ['fireLeft', 'fireRight'] as const) Input[k][A.pid] = 0;
  for (let t = 0; t < 90; t++) step();
  for (const f of [A, B]) server.pilots.connOf(f.pid)!.packed?.drain(server.getTick());
  return { server, A, B, exact, inexact, rowsAtForce, rows: A.ownRows - rows0, fired: A.ownFired - fired0, journal: server.hits.journalStats([server.pilots.connOf(A.pid)!]) };
}

describe('own shells as fire events (CAPS.OWN_SHOTS)', () => {
  it("are built exactly from the pilot's own pose: no rows of its own shells, every hit it finds agrees", () => {
    const r = fight(ALL);
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact, rows: r.A.ownRows, fired: r.A.ownFired, journal: r.journal, stats: r.server.hits.stats }));
    expect(r.fired).toBeGreaterThan(50);
    expect(r.rows).toBe(0);
    expect(r.exact).toBe(r.fired);
    expect(r.inexact).toBe(0);
    // Its hits found itself, all agreeing: no disagreement, no correction
    expect(r.server.hits.stats.own).toBeGreaterThan(20);
    expect(r.journal.disagreed).toBe(0);
    expect(r.journal.fixes).toBe(0);
    expect(r.A.hits!.stats.mismatches).toBe(0);
    // The same hits and damage as the legacy observer
    expect(r.A.projectileHits).toBe(r.B.projectileHits);
    const keys = new Set([...r.A.damage.keys(), ...r.B.damage.keys()]);
    for (const k of keys) expect(r.A.damage.get(k) ?? 0, k).toBeCloseTo(r.B.damage.get(k) ?? 0, 6);
  }, 120_000);

  it('a window the server corrects its ship in sends its own shells as rows', () => {
    // (a stretch of corrections: every snapshot from tick 60 to 120 corrects it)
    const r = fight(ALL, Array.from({ length: 60 }, (_, i) => 60 + i));
    // (each forced window's shells came as rows: rounded, so not exact; the rest were built exactly)
    expect(r.rows).toBeGreaterThan(0);
    expect(r.fired).toBeGreaterThan(40);
    expect(r.inexact).toBe(r.rows);
    expect(r.exact).toBe(r.fired);
    expect(r.A.hits!.stats.mismatches).toBe(0);
  }, 120_000);

  it('without the bit, as before: rows', () => {
    const r = fight(ALL & ~CAPS.OWN_SHOTS);
    expect(r.A.ownFired).toBe(0);
    expect(r.A.ownRows).toBeGreaterThan(50);
  }, 120_000);
});
