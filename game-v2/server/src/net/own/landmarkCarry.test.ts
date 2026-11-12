/**
 * Landmark tracking on the wire (common world/landmarks.ts, docs/design/landmark-tracking-2026-11.md): a pilot flown by
 * its inputs in through Sol Central's fade band and across its inner zone is carried by the same step on the server, on
 * its own client's tick layer and on a watcher's replica of it, to the bit, and nothing is sent for it: no keyframes or
 * control rows of its ship, no ownSync, every head hash agreeing. Parked in the inner zone it stays by the station.
 *
 * A real GameServer on the sector world; the pilots are fake clients running the client's own layer (full caps), as
 * net/own/ownSim.test.ts flies them.
 */
import { describe, it, expect } from 'vitest';
import {
  Position, Velocity, Rotation, InSystem, Station, encodeMessage, decodeMessage, controlRowId, landmarkZoneAt, landmarkPosition,
  type ReplicaEnv, type ClientMessage, type ServerSnapshotMessage, type ServerMessage,
} from '@space-game/common';
import type { GameServer } from '../../GameServer.js';
import { FakeHitsClient } from '../hits/fakeHitsClient.testkit.js';
import { stationQuery } from '../../game/Docking.js';
import { makeServer, resetGlobals, joinPilot, stepServer } from '../../testkits/world.testkit.js';

const CENTRAL = 'station:sol_station_central';

function centralEid(server: GameServer): number {
  const num = server.gameData.getStationNum('sol_station_central');
  return [...stationQuery(server.world)].find((st) => Station.stationId[st] === num)!;
}

/** A pilot (and a watcher beside it) by Sol Central, flown `ticks` ticks by `keys` from `from` (an offset from the station) */
function fly(from: { x: number; y: number }, ticks: number, keys: (t: number) => Record<string, boolean | number>) {
  resetGlobals();
  const clock = { t: 1_000_000 };
  const server = makeServer({ clock: () => clock.t });
  const ships = server.getShips();
  const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
  const A = new FakeHitsClient(server, { name: 'carried', env });
  const C = new FakeHitsClient(server, { name: 'watcher', env });
  const got = { keyframes: 0, ctlRows: 0, snapshots: 0, checked: 0, off: 0, syncs: 0 };
  const seen = { keyframes: 0, checked: 0, off: 0 };
  const truth = new Map<number, number[]>();
  { const ot = A.own, o2 = ot.onOwnSync.bind(ot); ot.onOwnSync = (m) => { got.syncs++; o2(m); }; }
  const same = (st: { x: number; y: number; vx: number; vy: number; angle: number }, r: number[]) => st.x === r[0] && st.y === r[1] && st.vx === r[2] && st.vy === r[3] && st.angle === r[4];
  const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void }, oa = fa.snapshot.bind(A);
  fa.snapshot = (s) => {
    oa(s);
    got.snapshots++;
    if (s.ships?.some((k) => k[0] === A.pid)) got.keyframes++;
    if (s.ctl?.some((r) => controlRowId(r) === A.pid)) got.ctlRows++;
    const st = A.reps.at(A.pid, s.tick)?.body, r = truth.get(s.tick);
    if (A.own.on && st && r) { got.checked++; if (!same(st, r)) got.off++; }
  };
  const fc = C as unknown as { snapshot(s: ServerSnapshotMessage): void }, oc = fc.snapshot.bind(C);
  fc.snapshot = (s) => {
    const held = C.reps.has(A.pid);
    oc(s);
    if (held && s.ships?.some((k) => k[0] === A.pid)) seen.keyframes++;
    const st = C.reps.at(A.pid, s.tick)?.body, r = truth.get(s.tick);
    if (st && r) { seen.checked++; if (!same(st, r)) seen.off++; }
  };
  let seq = 1;
  let chk: ReturnType<FakeHitsClient['own']['takeCheck']>;
  const step = (t: number) => {
    const msg = {
      type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1,
      forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: -Math.PI / 2, cursorDist: 700,
      ...(t >= 0 ? keys(t) : {}),
      ...(chk ? { ownCheck: chk } : {}),
    } as unknown as ClientMessage;
    chk = undefined;
    const dec = decodeMessage(encodeMessage(msg) as ArrayBuffer) as ClientMessage;
    A.noteInput(dec);
    A.link!.receive(dec);
    server.step();
    truth.set(server.getTick(), [Position.x[A.pid], Position.y[A.pid], Velocity.x[A.pid], Velocity.y[A.pid], Rotation.angle[A.pid]]);
    clock.t += 1000 / 60;
    chk = A.own.takeCheck(true, server.getTick());
    for (const m of A.outbox.splice(0)) A.link?.receive(m);
    C.flushUp();
  };
  for (let i = 0; i < 20; i++) step(-1);
  { const c = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean }; c.isAdmin = true; server.admin.run(c as never, 'god', { on: 'on' }); c.isAdmin = false; }
  ships.respawnInPlace(A.pid, ships.library.get('sparrow-t')!);
  const st = centralEid(server), num = InSystem.systemId[st];
  const set = server.replicaEnv(num).landmarks!, li = set.findIndex((l) => l.id === CENTRAL);
  Position.x[A.pid] = Math.round(Position.x[st] + from.x); Position.y[A.pid] = Math.round(Position.y[st] + from.y); Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
  Position.x[C.pid] = Position.x[A.pid] + 500; Position.y[C.pid] = Position.y[A.pid] + 300; Velocity.x[C.pid] = 0; Velocity.y[C.pid] = 0;
  // (The keyframes that put the moved ships right go first)
  for (let t = 0; t < 40; t++) step(-1);
  const got0 = { ...got }, seen0 = { ...seen }, heads0 = A.own.stats.headMisses;
  const weights: number[] = [], offsets: [number, number][] = [];
  let stationOff = 0;
  for (let t = 0; t < ticks; t++) {
    step(t);
    const tick = server.getTick(), z = landmarkZoneAt(set, tick, Position.x[A.pid], Position.y[A.pid]);
    weights.push(z?.i === li ? z.w : 0);
    const at = landmarkPosition(set, li, tick);
    offsets.push([Math.round((Position.x[A.pid] - at.x) * 100), Math.round((Position.y[A.pid] - at.y) * 100)]);
    // (The landmark is where the server's station entity is)
    stationOff = Math.max(stationOff, Math.hypot(Position.x[st] - at.x, Position.y[st] - at.y));
  }
  const d = <T extends Record<string, number>>(a: T, b: T) => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] - b[k]])) as T;
  return { server, A, got: d(got, got0), seen: d(seen, seen0), headMisses: A.own.stats.headMisses - heads0, weights, offsets, stationOff, zone: set[li] };
}

describe('landmark tracking: the server, the pilot\'s own layer and a watcher\'s replica carry it alike, with nothing sent', () => {
  it('thrusting in through the fade band and across the inner zone: exact at every snapshot, no keyframe, control row or ownSync', () => {
    // (From just outside the zone, off the station's hull; mouse-steer forward is up the screen: -y, inward)
    const r = fly({ x: 2500, y: 7400 }, 1500, (t) => {
      const ph = Math.floor(t / 150) % 5;
      return { forward: ph === 0 || ph === 2 || ph === 3, left: ph === 3, right: ph === 1, boost: ph === 2 && t % 150 < 40, targetAngle: -Math.PI / 2 + Math.sin(t / 45) * 0.6 };
    });
    // (It crossed the band: outside, part carried, and held whole)
    expect(r.weights[0]).toBe(0);
    expect(r.weights.some((w) => w > 0.05 && w < 0.95)).toBe(true);
    expect(r.weights.filter((w) => w === 1).length).toBeGreaterThan(100);
    expect(r.stationOff).toBeLessThan(0.02);
    expect(r.got.checked).toBeGreaterThan(20);
    expect(r.got.off).toBe(0);
    expect(r.got.keyframes).toBe(0);
    expect(r.got.ctlRows).toBe(0);
    expect(r.got.syncs).toBe(0);
    expect(r.headMisses).toBe(0);
    expect(r.seen.checked).toBeGreaterThan(20);
    expect(r.seen.off).toBe(0);
    expect(r.seen.keyframes).toBe(0);
  }, 180_000);

  it('parked in the inner zone with no keys held: it keeps its place by the station exactly, tick after tick', () => {
    const r = fly({ x: 1900, y: -1400 }, 900, () => ({}));
    expect(r.weights.every((w) => w === 1)).toBe(true);
    const [ox, oy] = r.offsets[0];
    expect(Math.abs(ox - 190000)).toBeLessThan(200);
    expect(r.offsets.every(([x, y]) => x === ox && y === oy)).toBe(true);
    expect(r.got.off).toBe(0);
    expect(r.got.keyframes).toBe(0);
    expect(r.got.ctlRows).toBe(0);
    expect(r.got.syncs).toBe(0);
    expect(r.headMisses).toBe(0);
    expect(r.seen.off).toBe(0);
    expect(r.seen.keyframes).toBe(0);
  }, 180_000);
});

describe('landmark tracking: what a client is told', () => {
  it('systemInfo carries the system\'s landmarks, the very records the server steps with', () => {
    resetGlobals();
    const server = makeServer();
    const p = joinPilot(server, 'told');
    stepServer(server, 5);
    const info = p.got.find((m): m is Extract<ServerMessage, { type: 'systemInfo' }> => m.type === 'systemInfo')!;
    expect(info.systemId).toBe('sol');
    const set = server.replicaEnv(InSystem.systemId[p.pid]).landmarks!;
    expect(set.length).toBeGreaterThan(10);
    expect(info.landmarks).toEqual(set);
    expect(info.landmarks!.some((l) => l.id === CENTRAL)).toBe(true);
    // (Plain data: it goes as it is)
    expect(JSON.parse(JSON.stringify(info.landmarks))).toEqual(set);
  });
});
