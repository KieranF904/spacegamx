import { describe, it, expect } from 'vitest';
import { MINES, minePos, mineArmed, mineExpired, mineTouches, mineId, mineIdParts, dropSeed, minesMissing, type MineDrop } from './minebay.js';
import { REARM, rearmBill, rearmWork } from '../../../econ/field/rules.js';

const drop: MineDrop = { owner: 4321, bay: 7, tick: 1000, n: 4, x: 100, y: -50, angle: Math.PI / 2, vx: 2, vy: 0, seed: dropSeed(4321, 7, 1000) };

describe('mine bay: mines from one drop record', () => {
  it('each mine slides out from the mouth, slows evenly and stops after slideTicks, the same every time', () => {
    const at0 = minePos(drop, 0, 1000);
    expect(at0).toEqual([100, -50]);
    const rest = minePos(drop, 1, 1000 + MINES.slideTicks);
    expect(minePos(drop, 1, 1000 + MINES.slideTicks + 500)).toEqual(rest);
    expect(minePos(drop, 1, 1000 + 10)).not.toEqual(rest);
    // (a batch fans out: no two mines rest on the same spot)
    const spots = new Set([0, 1, 2, 3].map((i) => minePos(drop, i, 5000).join(',')));
    expect(spots.size).toBe(4);
    // (on 2 decimals, as ships are)
    for (const v of rest) expect(Math.round(v * 100) / 100).toBe(v);
  });

  it('arms after armTicks, expires after lifeTicks; triggers by hull reach', () => {
    expect(mineArmed(drop, 1000 + MINES.armTicks - 1)).toBe(false);
    expect(mineArmed(drop, 1000 + MINES.armTicks)).toBe(true);
    expect(mineExpired(drop, 1000 + MINES.lifeTicks)).toBe(true);
    expect(mineArmed(drop, 1000 + MINES.lifeTicks)).toBe(false);
    expect(mineTouches(0, 0, MINES.triggerReach + 30, 0, 30)).toBe(true);
    expect(mineTouches(0, 0, MINES.triggerReach + 31, 0, 30)).toBe(false);
  });

  it('names: owner, tick and index round trip', () => {
    const id = mineId(123456, 0xabcdef, 3);
    expect(mineIdParts(id)).toEqual({ owner: 123456, tick24: 0xabcdef, i: 3 });
    expect(Number.isSafeInteger(mineId(2 ** 24 - 1, 2 ** 24 - 1, 15))).toBe(true);
  });

  it('rearming: what the bays lack, and the placeholder cost', () => {
    const info = { bays: [{ part: 0, uid: 5, batch: 4, capacity: 12, cooldown: 120, mouth: [0, 0] as [number, number], dir: [0, 1] as [number, number] }] };
    expect(minesMissing(info, { 5: 10 })).toBe(2);
    expect(minesMissing(info, undefined)).toBe(12);
    expect(rearmBill(REARM.perJob)).toEqual({ alloy_plate: REARM.perJob, copper_wire: REARM.perJob });
    expect(rearmWork(2)).toBe(2 * REARM.secondsPerMine);
  });
});
