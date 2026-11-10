import { describe, it, expect } from 'vitest';
import { DEFAULT_JUMP, solarRingRadius, jumpBurnAt } from './flight.js';
import {
  lodestonePosition, lodestoneAt, jumpFieldAt, fieldCharge, fieldRangeBoost, fieldCooldown, stepPrime, pilotJumpStep, NO_FIELD,
  lodestoneFieldRadius, lodestoneBoostOf, lodestoneLabel, lodestoneStop, primeBoost, wholeTicks, type FieldEnv,
} from './jumpFields.js';
import { planetPosition, planetAngle } from '../world/planets.js';
import { dcos, dsin } from '../math/detTrig.js';
import type { LodestoneData } from '../data/schemas.js';

const t = DEFAULT_JUMP;
const fixed: LodestoneData = { id: 'still', position: { x: 60000, y: 0 } };
const moving: LodestoneData = { id: 'moving', orbit: { radius: 80000, phase: 1, period: 2400 } };
const env: FieldEnv = { central: { type: 'sun', radius: 21000 }, lodestones: [fixed, moving] };
const cool = t.cooldownTicks;
const burnAt = jumpBurnAt(t), start = burnAt + t.burnTicks; // the burn's first tick, the cooldown's first tick

/** Ticks for a drive to cool down from the start of its cooldown, stepping the counter as a pilot's ship does */
const coolTicks = (f: (typeof NO_FIELD)) => {
  let j = start, n = 0;
  while (j !== 0 && n < 10000) { j = j + 1 >= start + cool ? 0 : j + 1; j = fieldCooldown(j, cool, f, t, n); n++; }
  return n;
};

describe('stillstones', () => {
  it('orbit as planets do (whole units, by the deterministic sin and cos: replicas fly by them), or stay put', () => {
    for (const tick of [0, 12345, 9e6]) {
      const p = planetPosition({ orbit: moving.orbit! }, tick), a = planetAngle({ orbit: moving.orbit! }, tick), r = moving.orbit!.radius;
      const q = lodestonePosition(moving, tick);
      expect(q).toEqual({ x: Math.round(dcos(a) * r), y: Math.round(dsin(a) * r) });
      expect(Math.abs(q.x - p.x)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(q.y - p.y)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(lodestonePosition(fixed, tick)).toEqual({ x: 60000, y: 0 });
    }
    // Slowly: a minute moves it a little, not out from under a ship
    const a = lodestonePosition(moving, 0), b = lodestonePosition(moving, 3600);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(t.lodestoneField / 2);
  });

  it("are worked out once a tick and come out the same (the memo is keyed by tick and orbit; positions handed out are the caller's)", () => {
    const fresh = (l: LodestoneData, tick: number) => { const a = planetAngle({ orbit: l.orbit! }, tick), r = l.orbit!.radius; return { x: Math.round(dcos(a) * r), y: Math.round(dsin(a) * r) }; };
    for (const tick of [5, 5, 6, 5, 1e7, 6]) {
      const p = fresh(moving, tick);
      expect(lodestonePosition(moving, tick)).toEqual(p);
      const F = lodestoneFieldRadius(moving, t);
      expect(lodestoneAt(p.x + F - 1, p.y, [moving], tick, t)?.id).toBe('moving');
      expect(lodestoneAt(p.x + F + 1, p.y, [moving], tick, t)).toBeNull();
    }
    const q = lodestonePosition(moving, 42);
    q.x += 1e6;
    expect(lodestonePosition(moving, 42)).toEqual(fresh(moving, 42));
    // (A stone given a new orbit is placed on it, the same tick)
    const swap: LodestoneData = { id: 'swap', orbit: { radius: 50000, phase: 0, period: 1000 } };
    lodestonePosition(swap, 7);
    swap.orbit = { radius: 70000, phase: 2, period: 3000 };
    expect(lodestonePosition(swap, 7)).toEqual(fresh(swap, 7));
  });

  it('have a field reaching the tuned distance past the stone, wherever they have got to', () => {
    const F = lodestoneFieldRadius(fixed, t);
    expect(F).toBe(t.lodestoneSize + t.lodestoneField);
    expect(lodestoneAt(60000 + F - 1, 0, env.lodestones, 0, t)?.id).toBe('still');
    expect(lodestoneAt(60000 + F + 1, 0, env.lodestones, 0, t)).toBeNull();
    // A bigger stone, a bigger field
    const big: LodestoneData = { id: 'big', position: { x: 60000, y: 0 }, size: 3000 };
    expect(lodestoneAt(60000 + 3000 + t.lodestoneField - 1, 0, [big], 0, t)?.id).toBe('big');
    const tick = 777777, p = lodestonePosition(moving, tick);
    expect(jumpFieldAt(p.x + 800, p.y - 600, env, tick, t).lodestone?.id).toBe('moving');
    expect(jumpFieldAt(p.x + 800, p.y - 600, env, tick + 3600 * 60, t).lodestone).toBeNull();
    expect(jumpFieldAt(40000, 0, env, 0, t)).toBe(NO_FIELD);
  });

  it('charge the drive twice as fast inside the field, like a star\'s ring', () => {
    const outside = coolTicks(NO_FIELD);
    const lode = coolTicks({ ring: false, lodestone: fixed });
    const ring = coolTicks({ ring: true, lodestone: null });
    expect(outside).toBe(cool);
    expect(lode).toBe(Math.ceil(cool / (1 + t.lodestoneCharge)));
    expect(ring).toBe(lode);
    // Only while cooling: a drive that's ready, spooling or mid-burn isn't touched
    for (const j of [0, 10, burnAt + 5]) expect(fieldCooldown(j, cool, { ring: false, lodestone: fixed }, t)).toBe(j);
  });

  it("don't stack above the star ring's own boost", () => {
    const both = { ring: true, lodestone: fixed };
    expect(fieldCharge(both, t)).toBe(t.solarCharge);
    expect(coolTicks(both)).toBe(coolTicks({ ring: true, lodestone: null }));
    expect(fieldRangeBoost(true, 10, t)).toBe(t.solarRangeBoost);
    expect(fieldRangeBoost(false, 10, t)).toBe(t.lodestoneRangeBoost);
    expect(fieldRangeBoost(true, 0, t)).toBe(t.solarRangeBoost);
    expect(fieldRangeBoost(false, 0, t)).toBe(1);
  });

  it('prime the next jump for 60 s after leaving, and a jump spends it', () => {
    const inField = { ring: false, lodestone: fixed };
    expect(t.lodestonePrimeTicks).toBe(60 * 60);
    let p = stepPrime(0, start, inField, t);
    expect(p).toBe(t.lodestonePrimeTicks);
    // Out of the field: it runs down, and a minute later it's gone
    for (let i = 0; i < t.lodestonePrimeTicks - 1; i++) p = stepPrime(p, 0, NO_FIELD, t);
    expect(p).toBe(1);
    expect(stepPrime(p, 0, NO_FIELD, t)).toBe(0);
    // A jump (its burn) spends it, and the field can't top it up while the burn carries you out
    expect(stepPrime(500, burnAt, NO_FIELD, t)).toBe(0);
    expect(stepPrime(500, burnAt + 3, inField, t)).toBe(0);
    // Spooling doesn't spend it (the burn's first tick does)
    expect(stepPrime(500, burnAt - 1, NO_FIELD, t)).toBe(499);
  });

  it("a pilot's step: the boost from where it starts, the charge from where it ends", () => {
    const ringEdge = solarRingRadius(21000, t);
    const boosts: number[] = [];
    // Starts in the ring, ends just outside it: ring boost for this step, no ring charge after it
    const body = { x: ringEdge - 1, y: 0, jump: start };
    const p = pilotJumpStep(body, 0, env, 0, cool, t, (b) => { boosts.push(b); body.x += 2; body.jump += 1; });
    expect(boosts).toEqual([t.solarRangeBoost]);
    expect(body.jump).toBe(start + 1);
    expect(p).toBe(0);
    // Primed, out in the open: the lodestone's boost
    pilotJumpStep({ x: 40000, y: 0, jump: 0 }, 10, env, 0, cool, t, (b) => boosts.push(b));
    expect(boosts[1]).toBe(t.lodestoneRangeBoost);
    // Ending in a lodestone's field: charged and primed
    const b2 = { x: 59000, y: 0, jump: start };
    expect(pilotJumpStep(b2, 0, env, 0, cool, t, () => { b2.x += 100; })).toBe(t.lodestonePrimeTicks);
    expect(b2.jump).toBe(start + t.lodestoneCharge);
  });

  it('scarred: a share of the charge (in whole ticks) and of the range boost; dead and shattered: no field at all', () => {
    const scarred: LodestoneData = { id: 'scar', position: { x: 60000, y: 0 }, state: 'scarred' };
    const inScar = { ring: false, lodestone: scarred };
    expect(fieldCharge(inScar, t)).toBe(t.lodestoneCharge * t.lodestoneScarredCharge);
    // Half a tick a tick comes out as a whole tick every other tick
    expect([0, 1, 2, 3].map((k) => wholeTicks(0.5, k))).toEqual([0, 1, 0, 1]);
    expect([5, 6, 7].map((k) => wholeTicks(1, k))).toEqual([1, 1, 1]);
    const n = coolTicks(inScar);
    expect(Math.abs(n - cool / (1 + t.lodestoneCharge * t.lodestoneScarredCharge))).toBeLessThanOrEqual(1);
    expect(n).toBeGreaterThan(coolTicks({ ring: false, lodestone: fixed }));
    // Its priming is kept negative, runs up to 0, and reaches less far
    let p = stepPrime(0, start, inScar, t);
    expect(p).toBe(-t.lodestonePrimeTicks);
    p = stepPrime(p, 0, NO_FIELD, t);
    expect(p).toBe(-t.lodestonePrimeTicks + 1);
    expect(stepPrime(-1, 0, NO_FIELD, t)).toBe(0);
    expect(stepPrime(-500, burnAt, NO_FIELD, t)).toBe(0);
    const weak = 1 + (t.lodestoneRangeBoost - 1) * t.lodestoneScarredBoost;
    expect(primeBoost(-10, t)).toBeCloseTo(weak);
    expect(lodestoneBoostOf(scarred, t)).toBeCloseTo(weak);
    expect(fieldRangeBoost(false, -10, t)).toBeCloseTo(weak);
    // A full one's priming takes over from a scarred one's
    expect(stepPrime(-500, 0, { ring: false, lodestone: fixed }, t)).toBe(t.lodestonePrimeTicks);
    // Dead and shattered: nothing, and the map says what they are
    for (const state of ['dead', 'shattered'] as const) {
      const gone: LodestoneData = { id: state, position: { x: 60000, y: 0 }, state };
      expect(lodestoneFieldRadius(gone, t)).toBe(0);
      expect(lodestoneAt(60000, 0, [gone], 0, t)).toBeNull();
      expect(jumpFieldAt(60000, 0, { central: null, lodestones: [gone] }, 0, t)).toBe(NO_FIELD);
      expect(lodestoneBoostOf(gone, t)).toBe(1);
      expect(lodestoneStop(gone, t)).toBeGreaterThan(t.lodestoneSize);
    }
    expect(lodestoneLabel({ id: 'd', position: { x: 0, y: 0 }, state: 'dead' }, t)).toBe(`Dead ${t.lodestoneName.toLowerCase()}`);
    expect(lodestoneLabel({ id: 's', position: { x: 0, y: 0 }, state: 'shattered' }, t)).toBe(`Shattered ${t.lodestoneName.toLowerCase()}`);
    expect(lodestoneLabel(fixed, t)).toBe(t.lodestoneName);
    // A jump locked on to a live one lands inside its field, off the stone
    const stop = lodestoneStop(fixed, t);
    expect(stop).toBeGreaterThan(t.lodestoneSize);
    expect(stop).toBeLessThan(lodestoneFieldRadius(fixed, t));
  });

  it("a pilot's step by a scarred stone agrees with itself tick by tick (whole numbers throughout)", () => {
    const scarred: LodestoneData = { id: 'scar', position: { x: 60000, y: 0 }, state: 'scarred' };
    const e: FieldEnv = { central: null, lodestones: [scarred] };
    const body = { x: 60000, y: 0, jump: start };
    let p = 0;
    for (let tick = 1; tick < 400; tick++) {
      p = pilotJumpStep(body, p, e, tick, cool, t, () => { body.jump = body.jump + 1 >= start + cool ? 0 : body.jump + 1; });
      expect(Number.isInteger(body.jump)).toBe(true);
    }
    expect(p).toBe(-t.lodestonePrimeTicks);
    expect(body.jump).toBeGreaterThan(start + 399);
  });
});
