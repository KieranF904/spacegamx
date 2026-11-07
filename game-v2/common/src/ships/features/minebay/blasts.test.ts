import { describe, it, expect } from 'vitest';
import { MINES, dropSeed, mineId, mineTouches, type MineDrop } from './minebay.js';
import { MineBuckets, findMineBlasts, mineFindable, mineRest, type SearchDrop, type SearchShips } from './blasts.js';
import { SIDE } from '../../hitRules.js';

const drop: MineDrop = { owner: 4321, bay: 7, tick: 1000, n: 4, x: 100, y: -50, angle: Math.PI / 2, vx: 2, vy: 0, seed: dropSeed(4321, 7, 1000) };
const armed = drop.tick + MINES.armTicks;
const live = (d: MineDrop, gone: (number | undefined)[] = []): SearchDrop => ({ d, goneFrom: (i) => gone[i] ?? Infinity });
/** Ships at fixed spots from tick `from` (their end-of-tick poses), elsewhere before */
const ships = (spots: Record<number, [number, number]>, from = -Infinity, side: (id: number) => number = () => 0, r = 20): SearchShips => ({
  ids: Object.keys(spots).map(Number), side, radius: () => r,
  at: (id, t) => (t >= from ? { x: spots[id][0], y: spots[id][1] } : null),
});

describe('mine blasts: who may be found setting a mine off', () => {
  it('a ship a pilot may hurt that is not a pilot: not a pilot, a ward, a berthed ship or a person\'s craft', () => {
    expect(mineFindable(0)).toBe(true);
    expect(mineFindable(SIDE.PILOT)).toBe(false);
    expect(mineFindable(SIDE.WARD)).toBe(false);
    expect(mineFindable(SIDE.DOCKED)).toBe(false);
    expect(mineFindable(SIDE.PERSON)).toBe(false);
  });

  it('buckets find exactly the mines mineTouches says, wherever they sit against the cells', () => {
    const b = new MineBuckets<number>();
    const spots: [number, number][] = [];
    for (let k = 0; k < 200; k++) spots.push([((k * 7919) % 2000) - 1000, ((k * 104729) % 2000) - 1000]);
    spots.forEach((p, k) => b.add(k, p[0], p[1]));
    for (let s = 0; s < 50; s++) {
      const x = ((s * 31337) % 2200) - 1100, y = ((s * 2711) % 2200) - 1100, r = 10 + (s % 7) * 40;
      const got: number[] = [];
      b.touching(x, y, r, (k) => got.push(k));
      const want = spots.map((p, k) => (mineTouches(p[0], p[1], x, y, r) ? k : -1)).filter((k) => k >= 0);
      expect(got.sort((p, q) => p - q)).toEqual(want);
    }
    b.clear();
    let n = 0;
    b.touching(0, 0, 5000, () => n++);
    expect(n).toBe(0);
  });
});

describe('mine blasts: a window searched', () => {
  const spot0 = mineRest(drop, 0);
  it('an armed mine a findable ship touches goes off on the first tick it does, once; not before it arms', () => {
    // (in reach from the end of armed-5: the pass of armed-4 sees it, but the mine arms only on `armed`)
    const got = findMineBlasts([live(drop)], armed - 10, armed + 5, ships({ 9: spot0 }, armed - 5));
    const zero = got.filter((f) => f.i === 0);
    expect(zero).toHaveLength(1);
    expect(zero[0]).toMatchObject({ id: mineId(drop.owner, drop.tick, 0), tick: armed, by: 9 });
    // (each mine at most once, in tick order)
    expect(new Set(got.map((f) => f.i)).size).toBe(got.length);
  });

  it('the pose is the end of the tick before (as the pass has a pilotless ship)', () => {
    const got = findMineBlasts([live(drop)], armed + 10, armed + 20, ships({ 9: spot0 }, armed + 14));
    expect(got.find((f) => f.i === 0)?.tick).toBe(armed + 15);
  });

  it('the lowest id touching sets it off; never the owner; a pilot is the server\'s', () => {
    const got = findMineBlasts([live(drop)], armed, armed + 1, ships({ 30: spot0, 12: spot0 }));
    expect(got.find((f) => f.i === 0)?.by).toBe(12);
    expect(findMineBlasts([live(drop)], armed, armed + 3, ships({ [drop.owner]: spot0 }))).toHaveLength(0);
    expect(findMineBlasts([live(drop)], armed, armed + 3, ships({ 12: spot0 }, -Infinity, () => SIDE.PILOT))).toHaveLength(0);
  });

  it('a mine already gone (or only told) is left out from that tick', () => {
    expect(findMineBlasts([live(drop, [armed + 2])], armed + 2, armed + 5, ships({ 9: spot0 })).some((f) => f.i === 0)).toBe(false);
    expect(findMineBlasts([live(drop, [armed + 4])], armed + 1, armed + 5, ships({ 9: spot0 })).find((f) => f.i === 0)?.tick).toBe(armed + 2);
    expect(findMineBlasts([live(drop, [-Infinity])], armed, armed + 5, ships({ 9: spot0 })).some((f) => f.i === 0)).toBe(false);
  });

  it('out of reach by a hair: nothing; in reach by a hair: found', () => {
    const r = 20, edge = r + MINES.triggerReach, one = { ...drop, n: 1 }, s1 = mineRest(one, 0);
    expect(findMineBlasts([live(one)], armed, armed + 2, ships({ 9: [s1[0] + edge + 0.01, s1[1]] }, -Infinity, () => 0, r))).toHaveLength(0);
    expect(findMineBlasts([live(one)], armed, armed + 2, ships({ 9: [s1[0] + edge, s1[1]] }, -Infinity, () => 0, r))).toHaveLength(1);
  });
});
