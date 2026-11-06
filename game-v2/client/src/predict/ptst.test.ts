/**
 * The PT/ST layer (C3, the game's prediction; C2 without the register) against a fake transport: a "server" stepping the truth with every ship's real inputs
 * (the same step and contact model), whose states reach the client `LAG` ticks late; the client predicts other ships
 * by holding their last input, `LEAD` ticks ahead of the server.
 */
import { describe, expect, it } from 'vitest';
import { ReplicaState, ReplicaMode, shipHash } from '@space-game/common';
import { PtStLayer, type PtStWorld, type PtTrack } from './ptst';
import { CircleContacts } from './contacts';

const LAG = 6;
const LEAD = 6;
/** bits: 1 thrust +x (1 a tick), 2 brake to a stop, 4 blink 1000 along +x */
function fakeStep(prev: ReplicaState, bits: number, q: number, t: number): ReplicaState {
  void t;
  const b = { ...prev.body };
  if (bits & 4) b.x += 1000;
  if (bits & 2) { b.vx = 0; b.vy = 0; }
  if (bits & 1) b.vx += 1;
  b.x += b.vx; b.y += b.vy;
  b.angle = q / 100;
  return new ReplicaState(prev.id, prev.mode, b, bits, q);
}
const body = (x: number, y: number, vx = 0, vy = 0) => ({ x, y, vx, vy, angle: 0, angVel: 0 });
const SHAPE = { r: 10, inv: 1 };
const circles = () => new CircleContacts(() => SHAPE);

/** The server: the truth, every ship flown with its real inputs (input(id, t) = [bits, q] flown on tick t) */
function fakeServer(start: Map<number, ReturnType<typeof body>>, input: (id: number, t: number) => [number, number]) {
  const ids = [...start.keys()];
  const truth = new PtStLayer({
    ships: () => ids,
    st: (id, t) => (t === 0 ? new ReplicaState(id, ReplicaMode.Player, { ...start.get(id)! }, 0, 0) : null),
    step: (id, prev, t) => { const [bits, q] = input(id, t); return fakeStep(prev, bits, q, t); },
    contacts: circles(),
  }, { touch: false, now: () => 0 });
  truth.confirm(0);
  truth.advance(0);
  return { ids, truth, at: (id: number, t: number) => truth.ring.get(id, t) as ReplicaState | undefined };
}

/** The client's world over the fake transport: ST only up to `delivered`; PT holds each ship's last input (bar a blink) */
function clientWorld(server: ReturnType<typeof fakeServer>, delivered: () => number, held: (id: number) => boolean = () => true): PtStWorld {
  return {
    ships: () => server.ids.filter(held),
    st: (id, t) => (t <= delivered() ? server.at(id, t) ?? null : null),
    step: (id, prev, t) => fakeStep(prev, prev.bits & ~4, prev.q, t),
    contacts: circles(),
  };
}

/** Run server and client together to server tick `end`; returns each confirm's re-stepped ships by tick */
function run(server: ReturnType<typeof fakeServer>, client: PtStLayer, end: number, clock: { delivered: number }): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let s = 1; s <= end; s++) {
    server.truth.advance(s);
    clock.delivered = Math.max(0, s - LAG);
    const re = client.confirm(clock.delivered);
    if (re.length) out.set(clock.delivered, re);
    client.advance(s + LEAD);
  }
  return out;
}

describe('PT/ST layer (C3; C2)', () => {
  it('re-steps nothing while every ST matches the PT recorded for it', () => {
    const server = fakeServer(new Map([[1, body(0, 0, 1)], [2, body(0, 200, -1)]]), () => [0, 0]);
    const clock = { delivered: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: false, now: () => 0 });
    const re = run(server, client, 120, clock);
    expect(re.size).toBe(0);
    expect(client.stats.checks).toBeGreaterThan(200);
    expect(client.stats.misses).toBe(0);
    expect(client.stats.restepTicks).toBe(0);
    expect(client.takeCorrections()).toEqual([]);
  });

  it('a mispredicted input: one miss, one re-step from ST, then it converges', () => {
    // (Ship 2 starts thrusting on tick 30: the client held "no thrust" for it)
    const server = fakeServer(new Map([[1, body(0, 0, 1)], [2, body(0, 300)]]), (id, t) => (id === 2 && t >= 30 ? [1, 0] : [0, 0]));
    const clock = { delivered: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: false, now: () => 0 });
    const re = run(server, client, 160, clock);
    expect([...re.entries()]).toEqual([[30, [2]]]);
    expect(client.stats.misses).toBe(1);
    expect(client.stats.resteps).toBe(1);
    // (Re-stepped from ST(30) to the head as it stood (stepped the server tick before): 30 + LAG + LEAD - 1)
    expect(client.stats.restepTicks).toBe(LAG + LEAD - 1);
    const [c] = client.takeCorrections();
    expect(c.id).toBe(2);
    expect(c.to.x).toBeGreaterThan(c.from.x);
    // Converged: PT agrees with the truth at every tick the server has reached since
    for (let t = 40; t <= 160; t++) expect(client.ring.hash(2, t)).toBe(shipHash(server.at(2, t)!));
  });

  it('the drawn pose eases from the old PT to the new over lerpMs', () => {
    const server = fakeServer(new Map([[2, body(0, 0)]]), (_id, t) => (t >= 20 ? [1, 0] : [0, 0]));
    const clock = { delivered: 0 }, ms = { now: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: false, lerpMs: 100, now: () => ms.now });
    for (let s = 1; s <= 26; s++) { server.truth.advance(s); clock.delivered = Math.max(0, s - LAG); client.confirm(clock.delivered); client.advance(s + LEAD); }
    const [c] = client.takeCorrections();
    expect(c).toBeDefined();
    // (Drawn off its PT by the whole correction at first, none of it after lerpMs)
    const head = client.head, pt = client.ptPose(2, head)!.x, gap = c.from.x - c.to.x;
    expect(gap).toBeLessThan(0);
    expect(client.pose(2, head, 0)!.x - pt).toBeCloseTo(gap, 6);
    const mid = client.pose(2, head, 50)!.x - pt;
    expect(mid).toBeGreaterThan(gap);
    expect(mid).toBeLessThan(0);
    expect(client.pose(2, head, 100)!.x).toBeCloseTo(pt, 6);
  });

  // Ship 1 flies at ship 3; on the server it stops at tick 10 and never reaches it. The client, holding "fly on",
  // has them touch about tick 20 and ship 3 pushed away
  const touchCase = () => fakeServer(new Map([[1, body(0, 0, 2)], [3, body(60, 0)], [5, body(0, 500)]]), (id, t) => (id === 1 && t >= 10 ? [2, 0] : [0, 0]));

  it('C3: the ship a mispredicted one touched is re-stepped with it (the touch register)', () => {
    const server = touchCase();
    const clock = { delivered: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: true, now: () => 0 });
    const re = run(server, client, 120, clock);
    expect(re.get(10)).toEqual([1, 3]);
    expect(client.stats.touchShips).toBe(1);
    // (Nothing else missed: ship 3 was put right at once, ship 5 never touched)
    expect([...re.keys()]).toEqual([10]);
    for (let t = 30; t <= 120; t++) expect(client.ring.hash(3, t)).toBe(shipHash(server.at(3, t)!));
  });

  it('C2: only the mispredicted ship is re-stepped; the touched one is put right later, by its own ST', () => {
    const server = touchCase();
    const clock = { delivered: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: false, now: () => 0 });
    const re = run(server, client, 120, clock);
    expect(re.get(10)).toEqual([1]);
    expect(client.stats.touchShips).toBe(0);
    // (Ship 3's own miss, once its pushed PT tick is confirmed)
    const later = [...re.entries()].filter(([t, ids]) => t > 10 && ids.includes(3));
    expect(later.length).toBe(1);
    for (let t = 40; t <= 120; t++) expect(client.ring.hash(3, t)).toBe(shipHash(server.at(3, t)!));
  });

  it('ships entering view start from their first confirmed state; leaving drops their PT; back, they start again', () => {
    // (Ship 9 flies on the server all along; the client holds it from confirmed tick 40 to 80, and again from 110)
    const server = fakeServer(new Map([[1, body(0, 0, 1)], [9, body(0, 400, 2)]]), () => [0, 0]);
    const clock = { delivered: 0 };
    const held = (id: number) => id !== 9 || (clock.delivered >= 40 && clock.delivered < 80) || clock.delivered >= 110;
    const client = new PtStLayer(clientWorld(server, () => clock.delivered, held), { touch: true, now: () => 0 });
    for (let s = 1; s <= 160; s++) {
      server.truth.advance(s); clock.delivered = Math.max(0, s - LAG);
      client.confirm(clock.delivered); client.advance(s + LEAD);
      if (clock.delivered === 40) {
        // (Seeded from ST(40) and stepped alone to the head: on the truth at every tick it has)
        expect(client.has(9)).toBe(true);
        for (let t = 40; t <= s; t++) expect(client.ring.hash(9, t)).toBe(shipHash(server.at(9, t)!));
      }
      if (clock.delivered === 90) expect(client.has(9)).toBe(false);
    }
    expect(client.has(9)).toBe(true);
    expect(client.stats.drops).toBe(1);
    // (Ship 1 at the start, ship 9 each time it came into view)
    expect(client.stats.seeds).toBe(3);
    // (Coming and going is no correction: nothing missed)
    expect(client.stats.misses).toBe(0);
    expect(client.takeCorrections()).toEqual([]);
    for (let t = 120; t <= 160; t++) expect(client.ring.hash(9, t)).toBe(shipHash(server.at(9, t)!));
  });

  it('a correction too big to ease (a blink, a respawn) snaps', () => {
    const server = fakeServer(new Map([[2, body(0, 0)]]), (_id, t) => (t === 30 ? [4, 0] : [0, 0]));
    const clock = { delivered: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: true, lerpMs: 100, now: () => 0 });
    run(server, client, 60, clock);
    const [c] = client.takeCorrections();
    expect(c.snapped).toBe(true);
    expect(client.stats.snaps).toBe(1);
    // (Drawn on its new PT at once, no ease)
    expect(client.pose(2, client.head, 0)!.x).toBe(client.ptPose(2, client.head)!.x);
  });

  it('tracks plugged into the layer hear each tick stepped and each re-step', () => {
    const server = fakeServer(new Map([[1, body(0, 0, 1)], [2, body(0, 300)]]), (id, t) => (id === 2 && t >= 30 ? [1, 0] : [0, 0]));
    const clock = { delivered: 0 };
    const client = new PtStLayer(clientWorld(server, () => clock.delivered), { touch: true, now: () => 0 });
    const ticks: number[] = [], resteps: [number, number[]][] = [], group: number[] = [];
    let resets = 0;
    const track: PtTrack = {
      name: 'test',
      stepped: (t, _l, g) => { if (g) group.push(t); else ticks.push(t); },
      restepped: (c, ids) => resteps.push([c, [...ids]]),
      reset: () => resets++,
    };
    client.addTrack(track);
    run(server, client, 80, clock);
    // (Every tick once as the layer advanced, in order; the re-step's ticks again, with its group)
    expect(ticks).toEqual(ticks.map((_, i) => ticks[0] + i));
    expect(resteps).toEqual([[30, [2]]]);
    expect(group.length).toBe(LAG + LEAD - 1);
    client.reset();
    expect(resets).toBe(1);
  });
});
