/**
 * Homing shells on a client's tick layer (CAPS.WAYPOINTS; common guidance/, net/guides/GuideNet.ts, client
 * ships/guides/GuideRunner.ts). A real GameServer; missiles fired at ships near the client (derived: it plans their
 * waypoints itself) and at a pilot who flies out of its focus and back (sent while it lacks the target, derived again
 * after, the switch mid-flight). Every shell it runs is compared with the server's on every tick it steps; a legacy
 * observer still gets rows.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'path';
import * as bitecs from 'bitecs';
import {
  Position, Velocity, InSystem, CAPS, EntityType, encodeMessage, decodeMessage,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type GuideBody,
} from '@space-game/common';
import { GameServer } from '../../GameServer.js';
import { GameData } from '../../data/GameData.js';
import { readGameDataFiles } from '../../data/loadGameDataFromDisk.js';
import { loadShipConfigFromDisk } from '../../ships/loadShipConfig.js';
import { createShipBridge } from '../../proto/createProtoServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import type { Weapons } from '../../game/Weapons.js';

const dataDir = join(__dirname, '../../../../data');
const files = readGameDataFiles(dataDir);
const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const BASE = CAPS.HITS | CAPS.SELF_HITS | CAPS.PACKED | CAPS.COALESCE | CAPS.OWN_SHOTS | CAPS.ROUGH | CAPS.OWN_SIM | CAPS.CAUSES | CAPS.FOCUS | CAPS.BLOCKS;
const ALL = BASE | CAPS.WAYPOINTS;

interface Opts {
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
}
interface World { server: GameServer; A: FakeHitsClient; B: FakeHitsClient; P: FakeHitsClient; D: number; H: number }

function run(o: Opts) {
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
      if (s.x !== m.x || s.y !== m.y || s.vx !== m.vx || s.vy !== m.vy) { got.off++; if (!got.firstOff) got.firstOff = `${id}@${t}: ${JSON.stringify(m)} vs ${JSON.stringify(s)}`; }
    },
  });
  const B = new FakeHitsClient(server, { name: 'legacy_obs', caps: 0, env });
  const P = new FakeHitsClient(server, { name: 'runner', caps: 0, env });
  // What A and B were sent of the shells: rows, and rows of a shell A runs after its first
  const rows = { A: 0, Aafter: 0, B: 0, syncs: 0, modes: 0, sent: 0 };
  const firstRow = new Set<number>();
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void }, oa = fa.snapshot.bind(A);
  fa.snapshot = (s) => {
    for (const e of s.entities) if (e.type === EntityType.Projectile && weapons.guideOf(e.id)) {
      rows.A++;
      if (firstRow.has(e.id)) rows.Aafter++;
      firstRow.add(e.id);
    }
    for (const r of s.guides ?? []) { if (r[2] === 0) rows.syncs++; if (r[2] === 4) rows.modes++; if (r[2] === 1 || r[2] === 2) rows.sent++; }
    oa(s);
  };
  const fb = B as unknown as { snapshot(s: ServerSnapshotMessage): void }, ob = fb.snapshot.bind(B);
  fb.snapshot = (s) => { for (const e of s.entities) if (e.type === EntityType.Projectile && weapons.guideOf(e.id)) rows.B++; ob(s); };
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
    clock.t += 1000 / 60;
    chk = A.own?.takeCheck(true, tick);
    const rep = A.selfHits?.takeReport(true);
    if (rep) server.hits.report(server.pilots.connOf(A.pid)! as never, rep);
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    B.flushUp(); P.flushUp();
  };
  for (let i = 0; i < 20; i++) step();
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
  for (let t = 0; t < (o.ticks ?? 500); t++) {
    now = t;
    o.each?.(t, w);
    if (t % o.every === 0) {
      const tg = o.at(w), ang = Math.atan2(Position.y[tg] - Position.y[D], Position.x[tg] - Position.x[D]);
      weapons.spawn(D, 'missile', Position.x[D], Position.y[D], ang, 1, { speedScale: 1, sizeScale: 1, turret: false, target: tg });
    }
    step();
  }
  const d = (a: Record<string, number>, b: Record<string, number>) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - (b[k] ?? 0)]));
  return { w, got, rows, checks: d(server.ownChecks.stats as never, chk0 as never), net: d(server.guides.stats as never, net0 as never), runner: A.guides?.stats };
}

describe('homing shells on the tick layer (CAPS.WAYPOINTS)', () => {
  it('both ends held: it plans their waypoints itself, nothing sent; every shell exact, no rows after the first', () => {
    const r = run({ every: 12, from: [3500, 1200], at: (w) => (Math.floor(w.server.getTick() / 12) % 2 ? w.A.pid : w.H) });
    if (process.env.GUIDE_DEBUG) console.log('GUIDE', JSON.stringify({ got: r.got, rows: r.rows, checks: r.checks, net: r.net, runner: r.runner }));
    expect(r.got.checked).toBeGreaterThan(3000);
    expect(r.got.off, r.got.firstOff).toBe(0);
    expect(r.rows.syncs).toBeGreaterThan(20);
    expect(r.rows.sent).toBe(0);
    expect(r.runner!.plans).toBeGreaterThan(100);
    expect(r.runner!.blind).toBe(0);
    expect(r.rows.Aafter).toBe(0);
    expect(r.rows.B).toBeGreaterThan(r.rows.syncs * 5);
    expect(r.checks.bodyOff).toBe(0);
    expect(r.checks.agreed).toBeGreaterThan(20);
  }, 120_000);

  it('the target out of its focus and back: sent while it lacks it, derived again after, exact through the switches', () => {
    const r = run({
      every: 15, from: [2000, 0], at: (w) => w.P.pid, pAt: [24000, 0], ticks: 700,
      // (it jumps into the focus, and out past its 19 km again)
      each: (t, w) => {
        const to = t === 250 ? [6000, 2500] : t === 480 ? [25000, -3000] : null;
        if (!to) return;
        const p = w.P.pid, a = w.A.pid;
        Position.x[p] = Position.x[a] + to[0]; Position.y[p] = Position.y[a] + to[1]; Velocity.x[p] = 0; Velocity.y[p] = 0;
      },
    });
    if (process.env.GUIDE_DEBUG) console.log('GUIDE', JSON.stringify({ got: r.got, rows: r.rows, checks: r.checks, net: r.net, runner: r.runner }));
    expect(r.got.checked).toBeGreaterThan(3000);
    expect(r.got.off, r.got.firstOff).toBe(0);
    expect(r.rows.sent).toBeGreaterThan(10);
    expect(r.rows.modes).toBeGreaterThanOrEqual(2);
    expect(r.runner!.plans).toBeGreaterThan(50);
    expect(r.runner!.blind).toBe(0);
    expect(r.rows.Aafter).toBe(0);
    expect(r.checks.bodyOff).toBe(0);
  }, 120_000);

  it('a drift injected into a shell it runs: its check catches it and a SYNC puts it right', () => {
    let hit = -1;
    const r = run({
      every: 20, from: [3000, 0], at: (w) => w.A.pid, ticks: 300,
      each: (t, w) => {
        // (a shell moved a unit on the server alone: as a bug would)
        if (t !== 150) return;
        const weapons = (w.server as unknown as { weapons: Weapons }).weapons;
        for (const [eid] of weapons.guided()) { if (w.A.guides!.state(eid)) { Position.x[eid] += 1; hit = eid; break; } }
      },
    });
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(r.got.off).toBeGreaterThan(0);
    expect(r.checks.bodyOff).toBeGreaterThan(0);
    expect(r.net.resyncs).toBeGreaterThan(0);
  }, 120_000);

  it('legacy clients (no WAYPOINTS) get rows as before', () => {
    const r = run({ every: 12, from: [3500, 1200], at: (w) => w.A.pid, caps: BASE, ticks: 200 });
    expect(r.rows.syncs).toBe(0);
    expect(r.rows.Aafter).toBeGreaterThan(50);
    expect(r.got.checked).toBe(0);
  }, 120_000);
});
