import { describe, it, expect } from 'vitest';
import { MINES, minePos, mineArmed, mineExpired, mineTouches, mineId, mineIdParts, dropSeed, minesMissing, makeDrop, pickBay, nextReady, bayLoaded, type MineDrop, type MineBayInfo } from './minebay.js';
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

describe('mine bay: the drop decision', () => {
  const bay = (uid: number, mouth: [number, number], dir: [number, number]) => ({ part: 0, uid, batch: 4, capacity: 12, cooldown: 120, mouth, dir });
  const info: MineBayInfo = { bays: [bay(5, [1, 2], [0, 1]), bay(9, [0, 0], [1, 0])] };

  it('the record: the mouth in the world and the way out, rounded as carried, the same from the same pose', () => {
    // Heading north (-y in the world): grid +y (the back) is world +y, grid +x is world -x... worked out by the ship's own rotation
    const pose = { x: 100, y: 200, angle: -Math.PI / 2, vx: 1.234, vy: -2.5 };
    const d = makeDrop(42, info.bays[0], 1000, 4, [1, 0.5], 10, pose);
    expect(d).toMatchObject({ owner: 42, bay: 5, tick: 1000, n: 4, vx: 1.23, vy: -2.5, seed: dropSeed(42, 5, 1000) });
    expect(d.x).toBeCloseTo(100, 6);
    expect(d.y).toBeCloseTo(215, 6);
    // (Out of the back: the way the ship isn't heading)
    expect(Math.abs(d.angle - Math.PI / 2)).toBeLessThan(1e-5);
    expect(makeDrop(42, info.bays[0], 1000, 4, [1, 0.5], 10, pose)).toEqual(d);
    // A side bay faces out of the ship's side
    const s = makeDrop(42, info.bays[1], 1000, 4, [1, 0.5], 10, pose);
    expect(Math.abs(s.angle)).toBeLessThan(1e-5);
  });

  it('the fullest ready bay drops; cooling or empty bays wait', () => {
    expect(pickBay(info, undefined, undefined, 0)).toBe(-1);
    expect(pickBay(info, { 5: 4, 9: 8 }, undefined, 0)).toBe(1);
    expect(pickBay(info, { 5: 8, 9: 8 }, undefined, 0)).toBe(0);
    expect(pickBay(info, { 5: 8, 9: 4 }, { 5: 100 }, 50)).toBe(1);
    expect(pickBay(info, { 5: 8, 9: 4 }, { 5: 100, 9: 100 }, 99)).toBe(-1);
    expect(pickBay(info, { 5: 8 }, { 5: 100 }, 100)).toBe(0);
    expect(nextReady(info, { 5: 8, 9: 4 }, { 5: 100, 9: 80 })).toBe(80);
    expect(nextReady(info, {}, {})).toBe(Infinity);
    expect(bayLoaded(info.bays[0], { 5: 99 })).toBe(12);
  });
});
