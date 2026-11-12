/**
 * Landmark tracking for what a parked pilot sees beside it (common world/landmarks.ts, docs/design/
 * landmark-tracking-2026-11.md): loot pods and debris in a moving landmark's zone are carried with it, by rules both
 * ends work out, nothing sent for it.
 *
 *   pods    held by the zone their drift anchor was laid in (podHold), placed from the anchor on both ends: the anchor
 *           is never laid again for the carry, and a client's placement from the row as sent is the server's
 *   debris  carried in the debris world's shared step: a watching client's pieces are the server's at every snapshot
 */
import { describe, it, expect } from 'vitest';
import {
  Position, Velocity, Rotation, InSystem, Station, podDrift, podHold, podCarry, landmarkPosition,
  type ReplicaEnv, type ServerSnapshotMessage, type ClientMessage,
} from '@space-game/common';
import type { GameServer } from '../GameServer.js';
import { stationQuery } from './Docking.js';
import { FakeHitsClient } from '../net/hits/fakeHitsClient.testkit.js';
import { targetFreighter } from '../testkits/targetFreighter.testkit.js';
import { makeServer, resetGlobals, stepServer } from '../testkits/world.testkit.js';

function central(server: GameServer) {
  const num = server.gameData.getStationNum('sol_station_central');
  const eid = [...stationQuery(server.world)].find((st) => Station.stationId[st] === num)!;
  const sys = InSystem.systemId[eid], set = server.replicaEnv(sys).landmarks!, li = set.findIndex((l) => l.id === 'station:sol_station_central');
  return { eid, sys, set, li, at: () => landmarkPosition(set, li, server.getTick()) };
}

/** Where a client draws a pod at the server's tick: from its anchor as the snapshot row sends it (rows/bodies.ts podRows) */
function clientPod(server: GameServer, set: ReturnType<typeof central>['set'], eid: number): { x: number; y: number } {
  const a = server.pods.anchor(eid)!;
  const sent = { x: Math.round(a.x * 10) / 10, y: Math.round(a.y * 10) / 10, vx: Math.round(a.vx * 1000) / 1000, vy: Math.round(a.vy * 1000) / 1000 };
  const at = podDrift(sent, server.getTick() - a.t), hold = podHold(set, sent.x, sent.y, a.t);
  if (hold) { const c = podCarry(set, hold, server.getTick(), { x: 0, y: 0 }); at.x += c.x; at.y += c.y; }
  return at;
}

describe('landmark tracking: loot pods', () => {
  it('a pod at rest in the inner zone keeps its place by the station for two minutes, its anchor never laid again; one in open space stays put', () => {
    resetGlobals();
    const server = makeServer();
    stepServer(server, 30);
    const c = central(server), at0 = c.at();
    const pod = server.pods.spawn(c.sys, at0.x + 900, at0.y - 400, 0, 0, { iron_ore: 3 });
    const flung = server.pods.spawn(c.sys, at0.x - 600, at0.y + 300, 3, -1.5, { iron_ore: 3 });
    const free = server.pods.spawn(c.sys, 150000, 150000, 0, 0, { iron_ore: 3 });
    expect(Math.min(pod, flung, free)).toBeGreaterThan(0);
    stepServer(server, 2);
    const anchor = { ...server.pods.anchor(pod)! }, flungAnchor = { ...server.pods.anchor(flung)! };
    expect(anchor.hold).toMatchObject({ i: c.li, w: 1 });
    expect(server.pods.anchor(free)!.hold).toBeNull();
    const off = () => { const at = c.at(); return [Position.x[pod] - at.x, Position.y[pod] - at.y]; };
    const o0 = off();
    let flungRest: number[] | null = null;
    for (let i = 0; i < 7200; i++) {
      server.step();
      if (i % 300 === 299) {
        const o = off();
        expect(Math.hypot(o[0] - o0[0], o[1] - o0[1])).toBeLessThan(0.02);
        // (What a client draws from the row it was sent once)
        for (const id of [pod, flung, free]) {
          const cl = clientPod(server, c.set, id);
          expect(Math.hypot(cl.x - Position.x[id], cl.y - Position.y[id])).toBeLessThan(0.15);
        }
      }
      // (Flung: it drifts to a stop in the station's frame, then keeps that place)
      if (i === 1500) { const at = c.at(); flungRest = [Position.x[flung] - at.x, Position.y[flung] - at.y]; }
    }
    const end = c.at();
    expect(Math.hypot(end.x - at0.x, end.y - at0.y)).toBeGreaterThan(5000);
    expect(Math.hypot(Position.x[flung] - end.x - flungRest![0], Position.y[flung] - end.y - flungRest![1])).toBeLessThan(0.05);
    expect(Math.hypot(flungRest![0] + 600, flungRest![1] - 300)).toBeGreaterThan(100);
    // (Nothing was sent again for the carry: the same anchors all the way)
    expect(server.pods.anchor(pod)).toMatchObject({ x: anchor.x, y: anchor.y, t: anchor.t });
    expect(server.pods.anchor(flung)).toMatchObject({ x: flungAnchor.x, y: flungAnchor.y, t: flungAnchor.t });
    expect([Position.x[free], Position.y[free]]).toEqual([150000, 150000]);
  }, 180_000);

  it('a pod dropped in the fade band follows by the weight where it was dropped', () => {
    resetGlobals();
    const server = makeServer();
    stepServer(server, 30);
    const c = central(server), at0 = c.at(), zone = c.set[c.li];
    const d = (zone.inner + zone.outer) / 2, len = Math.hypot(at0.x, at0.y);
    const x0 = at0.x + (at0.x / len) * d, y0 = at0.y + (at0.y / len) * d;
    const pod = server.pods.spawn(c.sys, x0, y0, 0, 0, { iron_ore: 3 });
    stepServer(server, 2);
    const hold = server.pods.anchor(pod)!.hold!;
    expect(hold.w).toBeGreaterThan(0.45);
    expect(hold.w).toBeLessThan(0.55);
    const s = c.at(), p = [Position.x[pod], Position.y[pod]];
    stepServer(server, 600);
    const e = c.at();
    expect(Math.abs(Position.x[pod] - p[0] - hold.w * (e.x - s.x))).toBeLessThan(0.05);
    expect(Math.abs(Position.y[pod] - p[1] - hold.w * (e.y - s.y))).toBeLessThan(0.05);
    const cl = clientPod(server, c.set, pod);
    expect(Math.hypot(cl.x - Position.x[pod], cl.y - Position.y[pod])).toBeLessThan(0.15);
  }, 180_000);
});

describe('landmark tracking: debris', () => {
  it('a ship blown apart in the inner zone: its pieces are carried with the station, and a watching client has each exactly at every snapshot', () => {
    resetGlobals();
    const clock = { t: 1_000_000 };
    const server = makeServer({ clock: () => clock.t });
    const ships = server.getShips();
    const env = (id: number) => (server.replication as unknown as { host: { env(eid: number): ReplicaEnv } }).host.env(id);
    const A = new FakeHitsClient(server, { name: 'watcher', env });
    const real = new Map<number, Map<number, number[]>>();
    const off: string[] = [];
    let checked = 0, seq = 1;
    const fa = A as unknown as { snapshot(s: ServerSnapshotMessage): void }, os = fa.snapshot.bind(A);
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
    const step = () => {
      server.step();
      clock.t += 1000 / 60;
      const now = new Map<number, number[]>();
      for (const [id, ship] of ships.bodies) if (ship.kind === 'debris') now.set(id, [Position.x[id], Position.y[id], Velocity.x[id], Velocity.y[id], Rotation.angle[id], ship.angVel]);
      real.set(server.getTick(), now);
      real.delete(server.getTick() - 120);
      const acks = A.debris.takeAcks();
      if (acks) A.link!.receive({ type: 'input', seq: seq++, tick: 0, targetTick: server.getTick() + 1, forward: false, backward: false, left: false, right: false, boost: false, fireLeft: false, fireRight: false, targetAngle: 0, acks } as unknown as ClientMessage);
      A.flushUp();
    };
    for (let i = 0; i < 30; i++) step();
    const conn = server.pilots.connOf(A.pid)! as unknown as { isAdmin: boolean };
    conn.isAdmin = true; server.admin.run(conn as never, 'god', { on: 'on' }); conn.isAdmin = false;
    const c = central(server), at0 = c.at();
    // (Well inside the inner zone, clear of the station's hull)
    Position.x[A.pid] = Math.round(at0.x + 2000); Position.y[A.pid] = Math.round(at0.y - 1500); Velocity.x[A.pid] = 0; Velocity.y[A.pid] = 0;
    const h = ships.spawnDummy(targetFreighter(ships), Position.x[A.pid] + 700, Position.y[A.pid], 0.3, c.sys);
    for (let i = 0; i < 60; i++) step();
    expect(A.store.get(h)).toBeTruthy();
    const before = new Set(ships.bodies.keys());
    ships.damagePartFraction(h, ships.get(h)!.blueprint.parts.findIndex((p) => p.fn === 'core'), 1);
    step();
    expect(ships.has(h)).toBe(false);
    const pieces = [...ships.bodies].filter(([id, s]) => s.kind === 'debris' && !before.has(id)).map(([id]) => id);
    expect(pieces.length).toBeGreaterThan(0);
    // Each tick a piece is moved by its own velocity and by the station's move, whole (it is in the inner zone)
    const last = new Map<number, number[]>();
    const start = c.at();
    let prev = start, ticks = 0, odd = 0;
    for (let i = 0; i < 1500; i++) {
      step();
      const at = c.at();
      for (const id of pieces) {
        const was = last.get(id);
        if (!ships.has(id)) { last.delete(id); continue; }
        const now = [Position.x[id], Position.y[id]];
        last.set(id, now);
        if (!was) continue;
        ticks++;
        const ex = now[0] - was[0] - Velocity.x[id] - (at.x - prev.x), ey = now[1] - was[1] - Velocity.y[id] - (at.y - prev.y);
        // (until it starts to crumble, which recentres what is left of it: common ships/debrisLife.ts)
        if (i < 250 && Math.hypot(ex, ey) > 0.015) odd++;
      }
      prev = at;
    }
    const end = c.at();
    expect(Math.hypot(end.x - start.x, end.y - start.y)).toBeGreaterThan(1500);
    expect(ticks).toBeGreaterThan(300);
    expect(odd).toBe(0);
    expect(checked).toBeGreaterThan(50);
    expect(off).toEqual([]);
  }, 180_000);
});
