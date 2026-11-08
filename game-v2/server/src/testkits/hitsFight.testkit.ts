/**
 * The hit tests' fight (net/hits/confirmedHits.test.ts, selfHits.test.ts; here, not under net/: it builds a GameServer): a real GameServer, a pilot firing at a parked ship (or
 * a boss), and two fake clients (fakeHitsClient.testkit.ts, full caps as every client): the shooter, and an observer
 * beside it whose view of the shells is the shooter's fire events. After every snapshot each one's part HP must be the
 * server's as the wire carries it; at the end what each was shown (damage, fires, impacts, detonations, removed shells)
 * is held to the server's own record of the fight (serverTruth.testkit.ts).
 */
import { expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import { Position, Velocity, InSystem, hpWire, encodeMessage, decodeMessage, type Blueprint, type ShipState, type ReplicaEnv, type ClientMessage } from '@space-game/common';
import { GameServer } from '../GameServer.js';
import { GameData } from '../data/GameData.js';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../ships/loadShipConfig.js';
import { createShipBridge } from '../proto/createProtoServer.js';
import { FakeHitsClient } from '../net/hits/fakeHitsClient.testkit.js';
import { serverTruth, damageOff, removedBoth } from '../net/hits/serverTruth.testkit.js';
import type { OwnHit } from '../../../client/src/ships/hits/ConfirmedHits.js';

const dataDir = join(__dirname, '../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

function withGuns(bp: Blueprint, from: string, fn: string): Blueprint {
  return { ...bp, parts: bp.parts.map((p) => (p.fn === from ? { ...p, fn } : p)) };
}

export interface FightScenario {
  /** The shooter's guns (a function id put in place of the Sparrow's Pips) */
  gun?: string;
  /** Ammunition in the shooter's hold (else a gun that takes it fires plain rounds) */
  ammo?: string;
  /** The target's parts' HP × this at the start (so parts go, and it dies) */
  hpScale?: number;
  /** A shield on the target, renewed every tick */
  shield?: number;
  /** A second target behind the first (a piercing shell's next pass) */
  behind?: boolean;
  /** More targets close behind the first (x past it, their parts' HP × hpScale): a pierce's later passes in one snapshot */
  stack?: { dx: number; hpScale: number }[];
  /** A boss instead of a freighter */
  boss?: string;
  /** The library Hauler as the target (its own fittings), not the old unarmed, unshielded dev freighter */
  hauler?: boolean;
  ticks?: number;
  /** The shooter throws away its hits on these shells (a forced mismatch) */
  drop?: (h: OwnHit) => boolean;
  /** The target is pushed across the line of fire once and coasts (a moving target) */
  drift?: number;
  /** A pack of AI ships (by enemy id, the pirates' faction) instead of a parked ship: the shooter fires at the nearest */
  pack?: string[];
  /** Called once the server and its clients are made (probes wrap the server here) */
  onServer?: (server: GameServer, shooter: FakeHitsClient) => void;
}

export function runFight(sc: FightScenario) {
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
  const A = new FakeHitsClient(server, { name: 'shooter', env, drop: sc.drop });
  const C = new FakeHitsClient(server, { name: 'observer', env });
  const fakes = [A, C];
  const truth = serverTruth(server);
  sc.onServer?.(server, A);
  // The shooter flies by input messages, as a real client: it steps its own ship from them (CAPS.OWN_SIM), so the server
  // must have its controls from them too (not set on the side: that is a late input, a keyframe of its own ship). Its
  // checks ride each one; its hit report goes straight to the ledger (riding an input that goes on time anyway)
  let seq = 1, chk: ReturnType<FakeHitsClient['own']['takeCheck']>, bck: ReturnType<FakeHitsClient['bodies']['takeCheck']>;
  const aim = { fire: false, angle: 0, dist: 0 };
  const post = () => {
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: false, backward: false, left: false, right: false, boost: false,
      fireLeft: aim.fire, fireRight: aim.fire, targetAngle: aim.angle, cursorDist: aim.dist,
      ...(chk ? { ownCheck: chk } : {}), ...(bck ? { bodyCheck: bck } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    bck = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
  };
  const step = () => {
    post();
    server.step();
    clock.t += 1000 / 60;
    chk = A.own.takeCheck(true, server.getTick());
    const rep = A.selfHits.takeReport(true);
    if (rep) { A.reports++; server.hits.report(server.pilots.connOf(A.pid)! as never, rep); }
    bck = A.bodies.takeCheck(true, server.getTick());
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    C.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
  // (Both pilots out of harm's way: a client whose ship is gone is told nothing)
  for (const f of fakes) { const c = server.pilots.connOf(f.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); }
  const num = InSystem.systemId[A.pid];
  const sparrow = ships.library.get('sparrow-t')!;
  ships.respawnInPlace(A.pid, sc.gun ? withGuns(sparrow, 'cannon_pip', sc.gun) : sparrow);
  if (sc.ammo) server.pilots.get(server.pilots.connOf(A.pid)!)!.cargo.push({ id: sc.ammo, n: 50 });
  // Out in open space: the shooter, the observer beside it, the target ahead
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (p: number, x: number, y: number) => { Position.x[p] = x; Position.y[p] = y; Velocity.x[p] = 0; Velocity.y[p] = 0; };
  place(A.pid, x0, y0);
  place(C.pid, x0 - 300, y0 - 400);
  const kind = sc.hauler ? ships.library.get('hauler')! : ships.devDesigns['target-freighter'];
  const packIds = sc.pack ? server.enemies.spawnPack(num, { faction: 'pirates', ships: sc.pack }, x0 + 900, y0) : [];
  const target = sc.boss ? server.bosses.spawnAt(sc.boss, num, x0 + 1500, y0) : sc.pack ? packIds[0] : ships.spawnDummy(kind, x0 + 700, y0, 0, num);
  if (sc.behind) ships.spawnDummy(kind, x0 + 1300, y0, 0, num);
  for (const st of sc.stack ?? []) {
    const s = ships.get(ships.spawnDummy(kind, x0 + 700 + st.dx, y0, 0, num))!;
    for (let i = 0; i < s.hp.length; i++) s.hp[i] *= st.hpScale;
  }
  const ship = ships.get(target)!;
  let aimAt = target;
  if (sc.hpScale) for (let i = 0; i < ship.hp.length; i++) ship.hp[i] *= sc.hpScale;
  const ticks = sc.ticks ?? 600;
  const name = (f: FakeHitsClient) => (f === A ? 'A' : 'C');
  const hpOff = (f: FakeHitsClient, held: boolean): string[] => {
    const conn = server.pilots.connOf(f.pid)! as unknown as { shipSynced: Map<number, { ship: ShipState; rebuilds: number }>; shipView: Set<number>; debrisHeld: Map<number, unknown> };
    const out: string[] = [];
    for (const [id, s] of ships.bodies) {
      const synced = conn.shipSynced.get(id), mine = f.store.get(id);
      if (!synced || synced.ship !== s || synced.rebuilds !== s.rebuilds || !mine || !conn.shipView.has(id) || (held && conn.debrisHeld.has(id))) continue;
      compared++;
      const want = s.hp.map(hpWire), got = (mine as ShipState).hp;
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) out.push(`${name(f)} tick ${server.getTick()} ship ${id} part ${i}: ${got[i]} vs ${want[i]}`);
    }
    return out;
  };
  const off: string[] = [];
  let compared = 0, offSnapshots = 0;
  for (let t = 0; t < ticks; t++) {
    aim.fire = false;
    // (a pack: the nearest of it still flying)
    if (sc.pack) {
      let bd = Infinity;
      for (const id of packIds) if (ships.has(id)) { const d = Math.hypot(Position.x[id] - Position.x[A.pid], Position.y[id] - Position.y[A.pid]); if (d < bd) { bd = d; aimAt = id; } }
    }
    if (ships.has(aimAt)) {
      const target = aimAt;
      // (one push across the line of fire: it coasts, as its replica does)
      if (sc.drift && !sc.boss && t === 0) Velocity.y[target] = sc.drift;
      const dx = Position.x[target] - Position.x[A.pid], dy = Position.y[target] - Position.y[A.pid];
      aim.angle = Math.atan2(dy, dx);
      aim.dist = Math.hypot(dx, dy);
      aim.fire = true;
      if (sc.shield) ships.get(target)!.shield = sc.shield;
    }
    for (const f of fakes) f.sawSnapshot = false;
    step();
    for (const f of fakes) {
      if (!f.sawSnapshot) continue;
      const o = hpOff(f, true);
      if (o.length) { offSnapshots++; if (off.length < 20) off.push(...o.slice(0, 20 - off.length)); }
    }
  }
  // Let the last reports and any correction land
  aim.fire = false;
  // (a pack still flying stops shooting back: its last hits land before the end, as the shooter's do)
  if (sc.pack) server.admin.run(server.pilots.connOf(A.pid)! as never, 'clear', { radius: 12000, quiet: true });
  // (shells that missed a pack fly out their life: long enough for the last of them to end)
  for (let t = 0; t < (sc.pack ? 300 : 90); t++) step();
  // (...and end on a snapshot: a part still burning loses HP between them, and its HP goes with the next one)
  for (let t = 0; t < 6; t++) { for (const f of fakes) f.sawSnapshot = false; step(); if (fakes.every((f) => f.sawSnapshot)) break; }
  const finalOff = fakes.flatMap((f) => hpOff(f, false));
  const journal = server.hits.journalStats(fakes.map((f) => server.pilots.connOf(f.pid)! as never));
  return { server, A, C, fakes, truth, target, off, offSnapshots, finalOff, compared, stats: server.hits.stats, journal, died: !ships.has(target) };
}

export type Fight = ReturnType<typeof runFight>;

/**
 * What a client was shown is what the server did: the same damage per target and source (a record's own number is to a
 * tenth, and so is each snapshot's sum: a little rounding allowed), the same fires, impacts and detonations, and the
 * same shells removed (each removed for both, or for neither)
 */
export function expectShownAsServer(r: Fight, f: FakeHitsClient): void {
  const allowance = 0.051 * (f.hits.stats.records + f.hits.stats.own) + 0.2;
  expect(damageOff(f.damage, r.truth.damage, allowance).slice(0, 5)).toEqual([]);
  expect([...f.ignites].sort()).toEqual([...r.truth.ignites].sort());
  expect(f.projectileHits).toBe(r.truth.impacts);
  expect(f.detonations).toBe(r.truth.detonations);
  const gone = removedBoth(f, r.truth);
  expect(gone.client).toEqual(gone.server);
}
