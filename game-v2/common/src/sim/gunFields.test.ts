/**
 * GUN_FIELDS (sim/state.ts): every gun field rides every copy, both wire forms and the hash. A new field added to the
 * table and the types fails here if one of them drops it.
 */
import { describe, expect, it } from 'vitest';
import { GUN_ARRAYS, GUN_SCALARS, cloneGunState, cloneSimShip, gunScalarsOntoRecord, newSimShip, type GunState } from './state.js';
import { packGunSync, unpackGunSync, laneHash } from './otherGuns.js';
import { cloneOwnExtras, packOwnSync, unpackOwnSync, type OwnExtras } from './ownStep.js';
import { shipHash } from './ring.js';
import type { ShipDerived } from '../ships/rebuild.js';
import type { ShipState } from '../ships/state.js';

/** Every field set, each to its own value (trig above 3 and the trigger held: the hash's conditions on them met) */
function full(): GunState {
  const g = { cooldown: [1, 2], rounds: [3, 4], reload: [5, 6], charge: [7, 8], spin: [0.5, 0.25], aim: [0.1, -0.2] } as GunState;
  const vals: Record<string, unknown> = { triggerHeld: true, clickAt: 41, trig: 9, minePaid: 11, mineUntil: 13, mineShare: 0.75, tow: 17, heldDist: 240, clickMasks: 6 };
  for (const k of GUN_SCALARS) {
    expect(k in vals, `a test value for ${k}`).toBe(true);
    (g as unknown as Record<string, unknown>)[k] = vals[k];
  }
  return g;
}

const extras = (guns: GunState): OwnExtras => ({ charge: { g: 50, b: [10] }, guns, hazard: { empUntil: 0, slowUntil: 0, numb: 1 }, jumpPrime: 0 });

describe('GUN_FIELDS', () => {
  it('the copies carry every field, the arrays their own', () => {
    const g = full();
    const c = cloneGunState(g);
    expect(c).toEqual(g);
    for (const k of GUN_ARRAYS) expect(c[k]).not.toBe(g[k]);
    const s = newSimShip({ id: 3, derived: { alive: [true, true] } as unknown as ShipDerived, body: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }, charge: { g: 1, b: [] } });
    s.guns = g;
    expect(cloneSimShip(s).guns).toEqual(g);
    expect(cloneOwnExtras(extras(g)).guns).toEqual(g);
  });

  it('a record view takes every scalar, trig defaulting to 0', () => {
    const rec = {} as ShipState;
    gunScalarsOntoRecord(full(), rec);
    for (const k of GUN_SCALARS) expect(rec[k]).toEqual(full()[k]);
    const bare = cloneGunState(full());
    bare.trig = undefined;
    gunScalarsOntoRecord(bare, rec);
    expect(rec.trig).toBe(0);
  });

  it('ownSync and gunSync bring every field back', () => {
    const g = full();
    expect(unpackOwnSync(JSON.parse(JSON.stringify(packOwnSync(5, extras(g))))).guns).toEqual(g);
    const back = unpackGunSync(JSON.parse(JSON.stringify(packGunSync(1, 5, extras(g), { bits: 3, dist: 400 })))).x.guns;
    expect(back).toEqual(g);
  });

  it('every scalar moves the hash (the Tow Beam\'s tow aside in a lane\'s)', () => {
    const s = newSimShip({ id: 3, derived: { alive: [true, true] } as unknown as ShipDerived, body: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }, charge: { g: 1, b: [] } });
    s.guns = full();
    const base = shipHash(s), lane = laneHash(3, extras(s.guns));
    for (const k of GUN_SCALARS) {
      if (k === 'triggerHeld') continue;
      const g = cloneGunState(s.guns);
      (g as unknown as Record<string, unknown>)[k] = (g[k] as number) + 1;
      expect(shipHash({ ...s, guns: g }), k).not.toBe(base);
      if (k !== 'tow') expect(laneHash(3, extras(g)), k).not.toBe(lane);
      else expect(laneHash(3, extras(g))).toBe(lane);
    }
  });
});
