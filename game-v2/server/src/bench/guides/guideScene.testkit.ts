/**
 * A scene for homing shells on a client's tick layer (CAPS.WAYPOINTS): a real GameServer, a WAYPOINTS client A (its
 * shells compared with the server's on every tick it steps), a legacy observer B, a pilot P to chase, a shooter D and a
 * dummy H. Used by net/guides/guides.test.ts and the measurements (here under bench/: it makes a GameServer, which nothing
 * under net/ may import at runtime).
 */
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, Rotation, InSystem, CAPS, EntityType, encodeMessage, decodeMessage,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type GuideBody,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../../net/hits/fakeHitsClient.testkit.js';
import type { Weapons } from '../../game/Weapons.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
export const BASE = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.CAUSES | CAPS.FOCUS | CAPS.BLOCKS;
export const ALL = BASE | CAPS.WAYPOINTS;

export interface Opts {
  /** Shots: every `every` ticks, from the dummy D at its target `at(w)` (the target's entity) */
  every: number;
  at: (w: World) => number;
  /** Where the shooter is, off the client */
  from: [number, number];
  /** The pilot P's controls at tick t (it starts `pAt` off the client) */
  pAt?: [number, number];
  pFly?: (t: number) => { forward: boolean; targetAngle: number };
  ticks?: number;
  /** Something done on tick t (a drift injected) */
  each?: (t: number, w: World) => void;
  caps?: number;
  /** Mobs of this kind launched instead (their brain picks who they hunt) */
  mob?: string;
}
export interface World { server: GameServer; A: FakeHitsClient; B: FakeHitsClient; P: FakeHitsClient; D: number; H: number }

export function run(o: Opts) {
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
  const weapons = (server as unknown as { weapons: Weapons }).weapons;
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  // The server's shells after each tick, to hold the client's against
  const truth = new Map<string, GuideBody>();
  const got = { checked: 0, off: 0, firstOff: '' };
  const A = new FakeHitsClient(server, {
    name: 'guided', caps: o.caps ?? ALL, env,
    onGuideStep: (id, t, m) => {
      const s = truth.get(`${id}:${t}`);
      if (!s) return;
      got.checked++;
      if (s.x !== m.x || s.y !== m.y || s.vx !== m.vx || s.vy !== m.vy || (s.a ?? 0) !== (m.a ?? 0)) { got.off++; if (!got.firstOff) got.firstOff = `${id}@${t}: ${JSON.stringify(m)} vs ${JSON.stringify(s)}`; }
    },
  });
  const B = new FakeHitsClient(server, { name: 'legacy_obs', caps: 0, env });
  const P = new FakeHitsClient(server, { name: 'runner', caps: 0, env });
  // What A and B were sent of the shells: rows, and rows of a shell A runs after its first
  const rows = { A: 0, Aafter: 0, B: 0, syncs: 0, modes: 0, sent: 0 };
  const firstRow = new Set<number>();
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void }, oa = fa.snapshot.bind(A);
  fa.snapshot = (s) => {
    for (const e of s.entities) if ((e.type === EntityType.Projectile && weapons.guideOf(e.id)) || e.type === EntityType.Enemy) {
      rows.A++;
      if (firstRow.has(e.id)) rows.Aafter++;
      firstRow.add(e.id);
    }
    for (const r of s.guides ?? []) { if (r[2] === 0) rows.syncs++; if (r[2] === 4) rows.modes++; if (r[2] === 1 || r[2] === 2) rows.sent++; }
    oa(s);
  };
  const fb = B as unknown as { snapshot(s: ServerSnapshotMessage): void }, ob = fb.snapshot.bind(B);
  fb.snapshot = (s) => { for (const e of s.entities) if ((e.type === EntityType.Projectile && weapons.guideOf(e.id)) || e.type === EntityType.Enemy) rows.B++; ob(s); };
  let seq = 1, pseq = 1, now = -1;
  let chk: ReturnType<NonNullable<FakeHitsClient['own']>['takeCheck']>;
  const input = (f: FakeHitsClient, s: number, c: { forward: boolean; targetAngle: number }, extra?: object) => {
    const msg = { type: 'input', seq: s, tick: 0, targetTick: server.getTick() + 1, forward: c.forward, backward: false, left: false, right: false, boost: false,
      fireLeft: false, fireRight: false, targetAngle: c.targetAngle, cursorDist: 700, ...extra } as unknown as ClientMessage;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    f.noteInput(dec);
    f.link!.receive(dec);
  };
  const step = () => {
    input(A, seq++, { forward: false, targetAngle: 0 }, chk ? { ownCheck: chk } : {});
    chk = undefined;
    if (o.pFly && now >= 0) input(P, pseq++, o.pFly(now));
    server.step();
    const tick = server.getTick();
    for (const [eid] of weapons.guided()) truth.set(`${eid}:${tick}`, { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid] });
    for (const [eid] of server.mobs.guided()) truth.set(`${eid}:${tick}`, { x: Position.x[eid], y: Position.y[eid], vx: Velocity.x[eid], vy: Velocity.y[eid], a: Rotation.angle[eid] });
    clock.t += 1000 / 60;
    chk = A.own?.takeCheck(true, tick);
    const rep = A.selfHits?.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    B.flushUp(); P.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
  let a0 = 0, b0 = 0;
  for (const f of [A, B, P]) { const c = server.pilots.connOf(f.pid)!; c.isAdmin = true; server.admin.run(c, 'god', { on: 'on' }); c.isAdmin = false; }
  const num = InSystem.systemId[A.pid];
  const x0 = Position.x[A.pid] + 30000, y0 = Position.y[A.pid] + 30000;
  Position.x[A.pid] = x0; Position.y[A.pid] = y0; Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  Position.x[B.pid] = x0 - 300; Position.y[B.pid] = y0 + 400;
  const pAt = o.pAt ?? [0, 3000];
  Position.x[P.pid] = x0 + pAt[0]; Position.y[P.pid] = y0 + pAt[1]; Velocity.x[P.pid] = 0; Velocity.y[P.pid] = 0;
  const D = ships.spawnDummy(ships.library.get('hauler')!, x0 + o.from[0], y0 + o.from[1], 0, num);
  const H = ships.spawnDummy(ships.library.get('hauler')!, x0 - 1500, y0 - 900, 0, num);
  const w: World = { server, A, B, P, D, H };
  for (let t = 0; t < 30; t++) step();
  const chk0 = { ...server.ownChecks.stats }, net0 = { ...server.guides.stats };
  a0 = A.bytes; b0 = B.bytes;
  for (let t = 0; t < (o.ticks ?? 500); t++) {
    now = t;
    o.each?.(t, w);
    if (t % o.every === 0) {
      const tg = o.at(w), ang = Math.atan2(Position.y[tg] - Position.y[D], Position.x[tg] - Position.x[D]);
      if (o.mob) server.mobs.spawn(o.mob, num, Position.x[D], Position.y[D], ang, 12, D);
      else weapons.spawn(D, 'missile', Position.x[D], Position.y[D], ang, 1, { speedScale: 1, sizeScale: 1, turret: false, target: tg });
    }
    step();
  }
  const d = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - (b[k] ?? 0)]));
  return { w, got, rows, bytes: { A: A.bytes - a0, B: B.bytes - b0, secs: (o.ticks ?? 500) / 60 }, checks: d(server.ownChecks.stats as never, chk0 as never), net: d(server.guides.stats as never, net0 as never), runner: A.guides?.stats };
}

