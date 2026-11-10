/**
 * Other ships' guns stepped from their inputs (common sim/otherGuns.ts; server net/guns/GunNet.ts; client
 * ships/guns/OtherGuns.ts): parity of the server's real guns with what a client steps of another ship's from what it
 * was sent (control rows, gun rows, gunSyncs; an AI pilot's body).
 *
 * A real GameServer. A watcher A (a fake client, full caps, the game's client classes) holds another pilot B, flown by
 * input messages through every firing model in turn (a cycle cannon and a pulsed laser, a spinning minigun and a hose, a
 * clip turret and a rail clip, a charge gun and a regrowing nest), and later a pirate pack fighting A (their bodies on
 * A's tick layer). Each shell A built from a gun lane is held to the server's projectile with the same shot: spawn
 * point, velocity and spawn tick exactly. The server sends A no fire records for them, bar the ticks it tells.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, InSystem, Projectile, encodeMessage, decodeMessage, parseBlueprint, otherShotWireOf, laneHash, TELL_PD,
  type ReplicaEnv, type ClientMessage, type Blueprint,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigCached } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../ships/createShipBridge.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { makeServer } from '../../testkits/world.testkit.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;

/** The Sparrow with its two Pips swapped for these */
function armed(lib: Map<string, Blueprint>, left: string, right: string): Blueprint {
  const b = parseBlueprint(JSON.stringify(lib.get('sparrow-t')!));
  const pips = b.parts.filter((q) => q.fn === 'cannon_pip');
  pips[0].fn = left;
  pips[1].fn = right;
  return b;
}

export const MODEL_PAIRS: [string, string][] = [
  ['cannon_pip', 'laser_glint'],
  ['autocannon_chainsaw', 'autocannon_rattler'],
  ['autocannon_stinger', 'railgun_rail_driver'],
  ['cannon_longbarrel', 'legendary_hive'],
  ['railgun_coilgun', 'pulse_strobe'],
];

interface Run {
  server: GameServer;
  A: FakeHitsClient;
  /** Server shells of the watched owners, by wire name A would give them: [x, y, vx, vy, spawn tick] */
  truth: Map<number, number[]>;
  exact: number;
  inexact: string[];
  derivedShells: number;
  stats: Record<string, number>;
  laneStats: Record<string, number>;
  /** Fire records A was sent of B / of the pirates */
  toldB: number;
  toldAi: number;
  /** A's lanes held to the server's at the same tick (hash), and those that were off */
  laneChecks: number;
  laneOff: string[];
  /** The gunner's own layer (its own ship, held distance and all, stepped on its client: client ships/own/OwnTick.ts) */
  ownB: Record<string, number>;
}

export function otherGunsFight(opts: { pairs?: [string, string][]; pirates?: boolean; ticksPer?: number; pd?: boolean; bursts?: boolean } = {}): Run {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'watcher', env });
  const B = new FakeHitsClient(server, { name: 'gunner', env });
  let seqA = 1, seqB = 1;
  const post = (who: FakeHitsClient, msg: Record<string, unknown>, seq: number) => {
    const m = { type: 'input', seq, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, cursorDist: 400, ...msg } as unknown as ClientMessage;
    const dec = decodeMessage(encodeMessage(m) as ArrayBuffer) as ClientMessage;
    who.noteInput(dec);
    who.link!.receive(dec);
  };
  const truth = new Map<number, number[]>();
  const watched = new Set<number>([B.pid]);
  let toldB = 0, toldAi = 0;
  // (fire records A was sent: counted off its frames' snapshots as they're handled)
  const origSnap = (A as unknown as { snapshot: (s: { fire?: number[][] }) => void }).snapshot.bind(A);
  (A as unknown as { snapshot: (s: { fire?: number[][] }) => void }).snapshot = (s) => {
    for (const f of s.fire ?? []) { if (f[0] === B.pid) toldB++; else if (f[0] !== A.pid) toldAi++; }
    origSnap(s);
  };
  // (each watched owner's shells as spawned, under the name a client gives the shell with that shot id: as each record goes in)
  const fired = ships.fired, push = fired.push.bind(fired);
  fired.push = (...fs) => {
    for (const f of fs) {
      if (!watched.has(f.owner) || !f.shots) continue;
      f.ids.forEach((eid, k) => truth.set(otherShotWireOf(f.owner, f.tick, f.part, k), [Projectile.spawnX[eid], Projectile.spawnY[eid], Velocity.x[eid], Velocity.y[eid], Projectile.spawnTick[eid]]));
    }
    return push(...fs);
  };
  let exact = 0, derivedShells = 0;
  const inexact: string[] = [];
  const seen = new Set<number>();
  // (A's lane of each ship it steps against the server's lane of it, wherever both are at the same tick: the hash)
  let laneChecks = 0;
  const laneOff: string[] = [];
  const check = () => {
    for (const [id, l] of server.gunNet.lanes) {
      const h = A.otherGuns.hashAt(id, l.at);
      if (h === undefined) continue;
      laneChecks++;
      if (h !== laneHash(id, l.x, l.pd)) laneOff.push(`${id}@${l.at}`);
    }
    for (const [id, sh] of A.otherShells) {
      if (seen.has(id)) continue;
      seen.add(id);
      derivedShells++;
      const t = truth.get(id);
      if (!t) { inexact.push(`${id}: no server shell (owner ${sh.owner} tick ${sh.tick} part ${sh.part})`); continue; }
      if (sh.x === t[0] && sh.y === t[1] && sh.vx === t[2] && sh.vy === t[3]) exact++;
      else inexact.push(`${id}: owner ${sh.owner} tick ${sh.tick}: client ${[sh.x, sh.y, sh.vx, sh.vy]} server ${t}`);
    }
  };
  let script: (t: number) => Record<string, unknown> = () => ({});
  const step = (t: number) => {
    post(A, { targetAngle: 0, cursorDist: 400 }, seqA++);
    post(B, script(t), seqB++);
    server.step();
    clock.t += 1000 / 60;
    for (const c of [A, B]) {
      const chk = c.own.takeCheck(true, server.getTick());
      if (chk) post(c, { ownCheck: chk }, c === A ? seqA++ : seqB++);
      const rep = c.selfHits.takeReport(true);
      if (rep) server.hits.report(server.pilots.connOf(c.pid)! as never, rep);
      for (const m of c.outbox.splice(0)) c.link?.receive(m);
    }
    check();
  };
  for (let i = 0; i < 20; i++) step(-1);
  for (const c of [A, B]) { const cc = server.pilots.connOf(c.pid)! as unknown as { isAdmin: boolean }; cc.isAdmin = true; server.admin.run(cc as never, 'god', { on: 'on' }); cc.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  const place = (pid: number, x: number, y: number) => { Position.x[pid] = x; Position.y[pid] = y; Velocity.x[pid] = 0; Velocity.y[pid] = 0; };
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  place(A.pid, x0, y0);
  const per = opts.ticksPer ?? 360;
  for (const [l, r] of opts.pairs ?? MODEL_PAIRS) {
    ships.respawnInPlace(B.pid, armed(ships.library, l, r));
    place(B.pid, x0 + 900, y0);
    // (a dummy for it to shoot at, off A's side: shells that miss it fly out their life)
    ships.spawnDummy(ships.library.get('hauler')!, x0 + 900, y0 - 800, 0, num);
    for (let t = -40; t < 0; t++) step(-1);
    script = opts.bursts
      // (short bursts and taps, the cursor swept all the while: its distance between them goes only roughly, GunNet idleDue)
      ? (t) => ({
        forward: t % 200 < 40, left: t % 300 > 250, fireLeft: t % 70 < 9 || t % 97 === 50, fireRight: t % 130 > 118,
        targetAngle: -Math.PI / 2 + Math.sin(t / 23) * 0.6, cursorDist: 250 + ((t * 13) % 1100),
      })
      : (t) => ({
        forward: t % 200 < 40, left: t % 300 > 250, fireLeft: t % 120 < 90, fireRight: t % 170 > 30,
        targetAngle: -Math.PI / 2 + Math.sin(t / 37) * 0.4, cursorDist: 300 + (t % 90) * 8,
      });
    for (let t = 0; t < per; t++) step(t);
    script = () => ({});
    for (let t = 0; t < 120; t++) step(-1);
  }
  if (opts.pd) {
    // (B with a point-defence turret that fires as the server alone decides: its turret's shots are the server's to
    // see (threats no client holds), so here a shot every 37 ticks while its cooldown allows, as features/support/
    // pointDefence.ts takes one: the cooldown restarted, a TELL_PD record. A steps B's guns all the while)
    ships.respawnInPlace(B.pid, armed(ships.library, 'point_defence_turret', 'cannon_pip'));
    place(B.pid, x0 + 900, y0);
    const pdPart = ships.get(B.pid)!.derived.weapons.find((w) => ships.tuning.weapons?.[w.kind]?.pointDefence)!;
    const wrapped = ships.stepWeapons.bind(ships);
    ships.stepWeapons = (eid: number) => {
      const ok = wrapped(eid);
      const ship = ships.get(eid), tick = server.getTick();
      if (eid === B.pid && ship && pdPart && tick % 37 === 0 && ship.cooldown[pdPart.part] <= 0) {
        const cd = ship.cooldown[pdPart.part];
        ship.cooldown[pdPart.part] = (cd > -1 ? cd : 0) + pdPart.interval;
        ships.fired.push({ owner: eid, tick, part: pdPart.part, aimQ: 0, ids: [], ammo: TELL_PD });
      }
      return ok;
    };
    script = (t) => ({ fireLeft: t % 200 < 120, targetAngle: -Math.PI / 2 + Math.sin(t / 50) * 0.3, cursorDist: 600 });
    for (let t = 0; t < 1500; t++) step(t);
    script = () => ({});
    ships.stepWeapons = wrapped;
  }
  if (opts.pirates) {
    place(B.pid, x0 - 20000, y0);
    // (it hunts A: out here is safe space, where a pack spares a pilot that hasn't hurt it, so a fight would hang on a
    // ship of it happening to bump into A first, as testkits/decisionFight.testkit.ts `prey`)
    const pack = server.enemies.spawnPack(num, { faction: 'pirates', ships: ['pirate_raider', 'pirate_skiff', 'pirate_skiff'] }, x0 + 1400, y0 - 600);
    for (const id of pack) server.enemies.setPrey(id, A.pid, true);
    for (const [eid] of ships.bodies) if (server.enemies.factionOf(eid)) watched.add(eid);
    for (let t = 0; t < 900; t++) {
      for (const [eid] of ships.bodies) if (server.enemies.factionOf(eid)) watched.add(eid);
      step(-1);
    }
  }
  for (let t = 0; t < 200; t++) step(-1);
  return { server, A, truth, exact, inexact, derivedShells, stats: { ...server.gunNet.stats }, laneStats: { ...A.otherGuns.stats }, toldB, toldAi, laneChecks, laneOff, ownB: { ...B.own.stats } };
}

describe('other ships\' guns stepped from their inputs', () => {
  it('another pilot, every firing model: each shell the watcher built is the server\'s exactly, and its fire records are not sent', () => {
    const r = otherGunsFight();
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact.slice(0, 10), n: r.inexact.length, derived: r.derivedShells, stats: r.stats, lane: r.laneStats, toldB: r.toldB, ownB: r.ownB }));
    // (fewer, heavier rounds since heavier-shots-2026-11: about 120 shells in this fight, where it was over 200)
    expect(r.derivedShells).toBeGreaterThan(90);
    expect(r.inexact).toEqual([]);
    // (every told hit named a shell it had; no HP put right)
    expect(r.A.hits.stats.missed).toBe(0);
    expect(r.A.hits.stats.mismatches).toBe(0);
    // (its lanes the server's, tick for tick, where it held them)
    expect(r.laneChecks).toBeGreaterThan(200);
    expect(r.laneOff).toEqual([]);
    expect(r.exact).toBe(r.derivedShells);
    // (records it was told of B: only where the server's state alone decided)
    expect(r.stats.derivedRecs).toBeGreaterThan(20 * r.stats.toldTicks);
    // (held, its distance went as its guns stepped on it, about twice a fire interval, not every tick it moved; a beam's every tick)
    expect(r.stats.exactChanges).toBeGreaterThan(1000);
    expect(r.stats.exactSent).toBeLessThan(r.stats.exactChanges / 3);
    // (the gunner's own client held the same distance: its head hashes all agreed)
    expect(r.ownB.heads).toBeGreaterThan(20);
    expect(r.ownB.headMisses).toBe(0);
  }, 300_000);

  it("another pilot in short bursts and taps, its idle distance sent only roughly: every shell still the server's exactly", () => {
    const r = otherGunsFight({ bursts: true });
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact.slice(0, 10), n: r.inexact.length, derived: r.derivedShells, stats: r.stats, lane: r.laneStats, toldB: r.toldB, ownB: r.ownB }));
    expect(r.derivedShells).toBeGreaterThan(60);
    expect(r.inexact).toEqual([]);
    expect(r.exact).toBe(r.derivedShells);
    expect(r.A.hits.stats.missed).toBe(0);
    expect(r.laneChecks).toBeGreaterThan(200);
    expect(r.laneOff).toEqual([]);
    expect(r.stats.toldTicks).toBe(0);
    expect(r.stats.fixes).toBe(0);
    // (the idle distance changed nearly every idle tick; a small share of those went)
    expect(r.stats.idleChanges).toBeGreaterThan(500);
    expect(r.stats.idleSent).toBeLessThan(r.stats.idleChanges / 4);
    expect(r.ownB.headMisses).toBe(0);
  }, 300_000);

  it("point defence (server-only threats): its shots told as TELL_PD, put into the lane, which stays exactly the server's", () => {
    const r = otherGunsFight({ pairs: [], pd: true });
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact.slice(0, 10), derived: r.derivedShells, stats: r.stats, lane: r.laneStats, why: r.server.gunNet.why }));
    expect(r.stats.pdRecs).toBeGreaterThan(5);
    expect(r.laneStats.pd).toBeGreaterThan(5);
    // (the lane never left the real ship: no state fix, every shell it built the server's)
    expect(r.stats.fixes).toBe(0);
    expect(r.inexact).toEqual([]);
    expect(r.laneChecks).toBeGreaterThan(200);
    expect(r.laneOff).toEqual([]);
  }, 300_000);

  it('an AI pack fighting the watcher, flown by its bodies on its tick layer: their shells built from their lanes, exactly', () => {
    const r = otherGunsFight({ pairs: [], pirates: true });
    if (process.env.GUNS_DEBUG) console.log(JSON.stringify({ exact: r.exact, inexact: r.inexact.slice(0, 10), n: r.inexact.length, derived: r.derivedShells, stats: r.stats, lane: r.laneStats, toldAi: r.toldAi }));
    expect(r.derivedShells).toBeGreaterThan(30);
    expect(r.inexact).toEqual([]);
    expect(r.A.hits.stats.missed).toBe(0);
    expect(r.A.hits.stats.mismatches).toBe(0);
    expect(r.laneChecks).toBeGreaterThan(50);
    expect(r.laneOff).toEqual([]);
    expect(r.stats.derivedRecs).toBeGreaterThan(10 * Math.max(1, r.stats.toldTicks));
  }, 300_000);
});
