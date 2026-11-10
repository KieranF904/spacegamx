/**
 * Guns as events, own shells named by shot id (sim foundation 1B; CAPS.SHOT_IDS, snapshot/ownShots.ts OwnShotLog,
 * client ships/hits/OwnShells.ts). The pilot's client runs its own gun step (common sim/guns.ts stepShipGuns) and gets
 * the server's projectile ids without being told them: its shot ids are the server's records' for every volley. The
 * server sends it no fire record of its own and no removal at a shell's end of life; its client builds the shells on its
 * tick layer, exactly as the server spawned them, and the hits it finds on them agree with the server's.
 *
 * A real GameServer; the pilot (a fake client, full caps) flies by input messages, firing at a dummy. What it was shown is
 * held to the server's own record of the fight (hits/serverTruth.testkit.ts).
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { defineQuery } from 'bitecs';
import {
  Position, Velocity, InSystem, Projectile, encodeMessage, decodeMessage, isOwnShotWire,
  type ReplicaEnv, type ClientMessage,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { serverTruth, damageOff } from '../hits/serverTruth.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const projQ = defineQuery([Projectile]);

function fight(ticks = 1200) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = new GameServer({
    gameData: new GameData(files),
    userDB: { validateSession: async () => null, cleanupExpiredSessions: async () => {} } as never,
    scene: 'sectors', autoStart: false,
    ships: createShipBridge(loadShipConfigCached(dataDir)),
    clock: () => clock.t,
  });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'shot_ids', env });
  const record = serverTruth(server);
  let seq = 1, chk: ReturnType<FakeHitsClient['own']['takeCheck']>;
  const post = (t: number) => {
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: false, backward: false, left: false, right: false, boost: false,
      fireLeft: t >= 0 && t % 90 < 70, fireRight: false, targetAngle: Math.sin(t / 40) * 0.25, cursorDist: 700,
      ...(chk ? { ownCheck: chk } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
  };
  // The server's own shells as spawned (spawn point and velocity), by entity id
  const truth = new Map<number, number[]>();
  // Its own shells it built (once each), against the server's as spawned
  let exact = 0, inexact = 0;
  const seen = new Set<number>();
  const check = () => {
    for (const [id, sh] of A.shells) {
      if (sh.owner !== A.pid || !isOwnShotWire(id)) continue;
      const eid = A.ownWire.get(id), t = eid !== undefined ? truth.get(eid) : undefined;
      if (!t || seen.has(eid!)) continue;
      seen.add(eid!);
      if (sh.x === t[0] && sh.y === t[1] && sh.vx === t[2] && sh.vy === t[3] && sh.spawnTick + 1 === t[4]) exact++; else inexact++;
    }
  };
  const step = (t: number) => {
    post(t);
    server.step();
    clock.t += 1000 / 60;
    for (const eid of projQ(server.getWorld())) if (Projectile.ownerId[eid] === A.pid && !truth.has(eid)) truth.set(eid, [Projectile.spawnX[eid], Projectile.spawnY[eid], Velocity.x[eid], Velocity.y[eid], Projectile.spawnTick[eid]]);
    chk = A.own.takeCheck(true, server.getTick());
    const rep = A.selfHits.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    check();
  };
  for (let i = 0; i < 20; i++) step(-1);
  { const c = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  // (a dummy ahead, its nose to the guns: the shells that miss it fly out their life)
  ships.spawnDummy(ships.library.get('hauler')!, x0 + 700, y0, 0, num);
  for (let t = -40; t < 0; t++) step(-1);
  const bytes0 = A.bytes;
  for (let t = 0; t < ticks; t++) step(t);
  for (let t = 0; t < 200; t++) step(-1);
  return { server, A, record, exact, inexact, bytes: A.bytes - bytes0, log: server.snapshots.ownShotLog.stats, journal: server.hits.journalStats([server.pilots.connOf(A.pid)! as never]) };
}

describe('own shells named by shot id (CAPS.SHOT_IDS)', () => {
  it("its own gun step's shot ids are the server's projectiles' for every volley; no own fire records or end-of-life removals go", () => {
    const r = fight();
    if (process.env.HITS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact, log: r.log, own: r.A.ownShells.stats, journal: r.journal, stats: r.server.hits.stats }));
    // shotId parity: the same ids, tick by tick
    expect(r.A.shotPairs.length).toBeGreaterThan(30);
    for (const p of r.A.shotPairs) expect([...p.client].sort(), `tick ${p.tick}`).toEqual([...p.server].sort());
    // Nothing of its own shells was sent: no fire records, no rows; it built them itself, exactly as the server spawned them
    expect(r.A.ownFired).toBe(0);
    expect(r.A.ownRows).toBe(0);
    expect(r.A.ownDerived).toBeGreaterThan(50);
    // (each built shell is checked while it is held, between snapshots: a snapshot goes only when there is something
    // to say, so some are built and gone between two checks)
    // (16 in this scene since the Hauler target's loadout changed; over 20 before)
    expect(r.exact).toBeGreaterThan(10);
    expect(r.inexact).toBe(0);
    // Expiry worked out on both ends: no removal sent for a shell at its life's end
    expect(r.log.removalsSaved).toBeGreaterThan(10);
    expect(r.A.ownShells.stats.expired).toBeGreaterThan(10);
    // Its hits on them found itself and agreeing, named by shot id on both ends
    expect(r.server.hits.stats.own).toBeGreaterThan(10);
    expect(r.journal.disagreed).toBe(0);
    expect(r.journal.fixes).toBe(0);
    expect(r.A.hits.stats.mismatches).toBe(0);
    // The damage and impacts the server had
    expect(r.A.projectileHits).toBe(r.record.impacts);
    expect(damageOff(r.A.damage, r.record.damage, 0.051 * (r.A.hits.stats.records + r.A.hits.stats.own) + 0.2)).toEqual([]);
    // (what it no longer gets: its fire records, and its shells' removals at their life's end)
    if (process.env.HITS_DEBUG) console.log(`SHOT_IDS: ${r.bytes} B; fire records saved ${r.log.fireRowsSaved} (~${r.log.fireBytesSaved} B as JSON), removals saved ${r.log.removalsSaved}, sent ${r.log.removalsSent}`);
    expect(r.log.fireRowsSaved).toBeGreaterThan(30);
  }, 240_000);
});
