/**
 * A Burn modifier's fire on a real ship in a running server (bridge/damage.ts ignite, stepBurns; common ships/fire.ts):
 * it spreads along the hull's joins to parts that stand, each generation cooler and shorter, never past its caps; its
 * damage is the igniter's; a part that is destroyed stops burning and lights nothing. Everyone near is told of every
 * part that catches or burns on (an `ignite` with `gen`), so a client's picture of what burns is the server's without
 * working any of it out. A fire without the modifier's rules (any gun's own) burns as it always did.
 */
import { describe, it, expect } from 'vitest';
import * as bitecs from 'bitecs';
import {
  InSystem, Position, Velocity, Rotation, hullNeighbours, encodeMessage, FIRE_STEP, type FireSpread, type ServerMessage,
} from '@space-game/common';
import { LocalTransport } from '../net/LocalTransport.js';
import { MemoryProfileStore } from '../profile/ProfileStore.js';
import { makeEmptyServer } from '../testkits/world.testkit.js';
import type { BridgeCtx } from '../ships/bridge/core.js';

const resetGlobals = (bitecs as unknown as { resetGlobals: () => void }).resetGlobals;
const X = 25000, Y = 20000;

/** A pilot and one pirate gunship held still 600 off; what the pilot's fires do to it is recorded */
function rig(design = 'pirate_gunship') {
  resetGlobals();
  const server = makeEmptyServer({ profileStore: new MemoryProfileStore() });
  const t = new LocalTransport(server);
  t.connect();
  t.send({ type: 'join', username: 'pilot' } as any);
  const pid = t.getPlayerId();
  const ships = server.getShips()!;
  const b = ships as unknown as BridgeCtx, any = b as any;
  const sys = InSystem.systemId[pid];
  const eid = server.enemies.spawnPack(sys, { faction: 'pirates', ships: [design] }, X + 600, Y)[0];
  const place = (e: number, x: number) => { Position.x[e] = x; Position.y[e] = Y; Velocity.x[e] = 0; Velocity.y[e] = 0; Rotation.angle[e] = 0; };
  const hold = () => { place(pid, X); place(eid, X + 600); };
  const mend = (e: number) => { const s = ships.get(e)!; for (let i = 0; i < s.hp.length; i++) if (s.hp[i] > 0) s.hp[i] = s.maxHp[i]; };
  hold(); server.step(); hold();
  const ship = ships.get(eid)!;
  const adj = hullNeighbours(ships.catalog, ship.blueprint);
  const fire: FireSpread = ships.tuning.modifiers!.burn.fire;
  /** Told: every `ignite` the server said of the gunship (a fire spreading or burning on) */
  const told: { part: number; ticks: number; gen?: number; tick: number }[] = [];
  const hurts: { src: number; part: number; amount: number }[] = [];
  const fireLit = b.host.fireLit!.bind(b.host);
  b.host.fireLit = (e, part, ticks, gen) => { if (e === eid) told.push({ part, ticks, gen, tick: server.currentTick }); return fireLit(e, part, ticks, gen); };
  const hurt = any.hurt.bind(b);
  any.hurt = (e: number, s: unknown, part: number, amount: number, src: number, opts?: unknown) => { if (e === eid) hurts.push({ src, part, amount }); return hurt(e, s, part, amount, src, opts); };
  const step = (n = 1) => { for (let i = 0; i < n; i++) { hold(); mend(pid); server.step(); } };
  const burning = () => b.burns.filter((f) => f.eid === eid);
  /** The pilot sets `part` alight (a cool fire: nothing dies of it) */
  const light = (part: number, spec: FireSpread | undefined, ticks = 180, dps = 0.01) => ships.ignite(eid, X + 600, Y, dps, ticks, 0, pid, undefined, part, -1, spec);
  return { server, ships, b, pid, eid, ship, adj, fire, told, hurts, step, burning, light, mend: () => mend(eid) };
}

/** A fire that takes every chance it has: for what it may and may not do, whatever the dice */
const eager = (f: FireSpread): FireSpread => ({ ...f, base: 1, cap: 1, survive: 1, surviveCap: 1, fade: 1 });

describe('a spreading fire on a ship', () => {
  it('spreads to the parts joined to a burning one, a generation on each time, cooler and shorter, and is told each time', () => {
    const r = rig(), spec = eager(r.fire), part = r.adj.findIndex((n) => n.length >= 2);
    expect(r.light(part, spec)).toBe(part);
    r.step(spec.beat + FIRE_STEP);
    const lit = r.burning();
    expect(lit.length).toBeGreaterThan(1);
    for (const f of lit) {
      if (f.part === part) { expect(f.gen).toBe(0); continue; }
      // (each new fire: on a part joined to one that burned before it, the next generation, of the same shot)
      expect(f.gen).toBeGreaterThanOrEqual(1);
      expect(r.adj[f.part].some((n) => lit.some((o) => o.part === n && (o.gen ?? 0) === (f.gen ?? 0) - 1))).toBe(true);
      expect(f.dps).toBeCloseTo(0.01 * Math.pow(spec.keep, f.gen!), 12);
      expect(f.ticks).toBeLessThan(180);
      expect(f.ev).toBe(lit.find((o) => o.part === part)!.ev);
      expect(f.source).toBe(r.pid);
    }
    expect(r.told.length).toBe(lit.length - 1);
    for (const m of r.told) expect(m.gen).toBeGreaterThanOrEqual(2);
  });

  it('never past its caps, whatever the dice: the parts one shot lights, its generations, its time', () => {
    const r = rig(), spec = eager(r.fire), part = r.adj.findIndex((n) => n.length >= 2);
    const t0 = r.server.currentTick;
    r.light(part, spec);
    const ever = new Set<number>([part]);
    let last = t0, maxGen = 0;
    for (let i = 0; i < spec.total + 60; i++) {
      r.step();
      r.mend();
      for (const f of r.burning()) { ever.add(f.part); maxGen = Math.max(maxGen, f.gen ?? 0); last = r.server.currentTick; }
    }
    expect(ever.size).toBeLessThanOrEqual(spec.parts);
    expect(ever.size).toBe(spec.parts);
    expect(maxGen).toBeLessThanOrEqual(spec.gens);
    expect(last - t0).toBeLessThanOrEqual(spec.total + FIRE_STEP);
    expect(r.burning()).toEqual([]);
  });

  it('its damage is the igniter\'s, every step of every part it spread to', () => {
    const r = rig(), spec = eager(r.fire), part = r.adj.findIndex((n) => n.length >= 2);
    r.light(part, spec, 180, 0.5);
    r.hurts.length = 0;
    r.step(120);
    const parts = new Set(r.hurts.map((h) => h.part));
    expect(parts.size).toBeGreaterThan(1);
    for (const h of r.hurts) expect(h.src).toBe(r.pid);
  });

  it('a part that is destroyed stops burning and lights nothing more; what it lit burns on', () => {
    const r = rig(), spec = eager(r.fire), part = r.adj.findIndex((n) => n.length >= 2);
    r.light(part, spec);
    r.step(spec.beat + FIRE_STEP);
    const others = r.burning().filter((f) => f.part !== part).map((f) => f.part);
    expect(others.length).toBeGreaterThan(0);
    r.ship.hp[part] = 0;
    r.told.length = 0;
    r.step(FIRE_STEP);
    expect(r.burning().some((f) => f.part === part)).toBe(false);
    // (nothing is told of the part that is gone, and no fire is ever on it again)
    r.step(3 * FIRE_STEP);
    expect(r.told.some((m) => m.part === part)).toBe(false);
    expect(r.burning().some((f) => f.part === part)).toBe(false);
    expect(r.burning().length).toBeGreaterThan(0);
  });

  it('a client\'s picture is the server\'s: the parts it was told are alight are the parts that burn, step for step', () => {
    const r = rig(), part = r.adj.findIndex((n) => n.length >= 3);
    // (tuning's own fire, a few shots on a few ticks: what a client keeps is each part's time from the last it was told)
    const client = new Map<number, number>();
    let spread = 0, seen = 0;
    const hear = () => { for (; seen < r.told.length; seen++) { const m = r.told[seen]; client.set(m.part, Math.max(client.get(m.part) ?? 0, m.tick + m.ticks)); spread++; } };
    for (let shot = 0; shot < 6; shot++) {
      r.step(7);
      hear();
      const at = (part + shot * 3) % r.ship.hp.length;
      if (r.light(at, r.fire) >= 0) client.set(at, Math.max(client.get(at) ?? 0, r.server.currentTick + 180));
      for (let i = 0; i < 150; i++) {
        r.step();
        r.mend();
        hear();
        const tick = r.server.currentTick;
        // (the server drops a fire on the step at or after its time: between steps both still hold it)
        if (tick % FIRE_STEP !== 0) continue;
        const mine = [...client].filter(([, until]) => until > tick).map(([p]) => p).sort((p, q) => p - q);
        expect(mine, `tick ${tick}`).toEqual(r.burning().map((f) => f.part).sort((p, q) => p - q));
      }
    }
    expect(spread).toBeGreaterThan(0);
  });

  it('what a spread costs on the wire: one ignite a part that catches or burns on, a few bytes', () => {
    const plain = encodeMessage({ type: 'ignite', bodyId: 1234, part: 17, ticks: 180 } as ServerMessage) as string;
    const spread = encodeMessage({ type: 'ignite', bodyId: 1234, part: 17, ticks: 90, gen: 2 } as ServerMessage) as string;
    // (a fire without the modifier is told as it always was: no new field on it)
    expect(JSON.parse(plain)).toHaveLength(4);
    expect(JSON.parse(spread)).toHaveLength(5);
    expect(spread.length).toBeLessThanOrEqual(plain.length + 2);
    console.log(`an ignite as text: plain ${plain.length} bytes, a spread ${spread.length} bytes (${spread})`);
  });
});

describe('a fire without the modifier\'s rules burns as it always did', () => {
  it('lights nothing beside it, is told nothing, and ends on its time', () => {
    const r = rig(), part = r.adj.findIndex((n) => n.length >= 2);
    const t0 = r.server.currentTick;
    r.light(part, undefined, 60);
    for (let i = 0; i < 59; i++) { r.step(); expect(r.burning().map((f) => f.part)).toEqual([part]); }
    r.step(FIRE_STEP + 1);
    expect(r.burning()).toEqual([]);
    expect(r.told).toEqual([]);
    expect(r.server.currentTick - t0).toBeGreaterThan(60);
  });

  it('with a reach of its own it still jumps to the nearest part when its own is destroyed (the Cinder Bloom\'s)', () => {
    const r = rig(), part = r.adj.findIndex((n) => n.length >= 2);
    r.ships.ignite(r.eid, X + 600, Y, 0.01, 300, 2, r.pid, undefined, part);
    r.step(FIRE_STEP);
    r.ship.hp[part] = 0;
    r.step(FIRE_STEP);
    const f = r.burning();
    expect(f).toHaveLength(1);
    expect(f[0].part).not.toBe(part);
    expect(f[0].fire).toBeUndefined();
  });
});
