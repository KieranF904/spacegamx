import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { registerRockTypes, crowdFactor, rockCrowd, type Bag, type MiningTable } from '@space-game/common';
import { readGameDataFiles } from '../data/loadGameDataFromDisk.js';
import { Mining, type MiningHost } from './Mining.js';

const files = readGameDataFiles(join(__dirname, '../../../data'));
const table = files.mining as unknown as MiningTable;
registerRockTypes(table);

/** A rock at the origin and a miner at (`mx`, `my`): the chunks thrown, as (position, velocity) */
function mine(miner: { x: number; y: number } | null, tool = { yield: 1.6, hardness: 2 }) {
  const thrown: { x: number; y: number; vx: number; vy: number }[] = [];
  const h: MiningHost = {
    spawnChunk: (_s, x, y, vx, vy, _items: Bag) => { thrown.push({ x, y, vx, vy }); },
    minerAt: miner ? () => miner : undefined,
    awardXp: () => {}, notify: () => {}, tick: () => 0, respawn: () => {}, crumble: () => {},
  };
  const m = new Mining(h, table);
  m.register(1, 0, 0, 'asteroid_metal', 'sol:0:0', 4000, 1);
  // Cut from the rock's side facing away from the miner (the rock's own normal points the other way)
  for (let k = 0; k < 300 && thrown.length < 8; k++) m.extract(1, 99, 200, tool, -100, 0, -1, 0);
  return thrown;
}

describe('mined chunks', () => {
  it('are thrown towards whoever mined them, a little faster than they would drift out of the rock', () => {
    const miner = { x: 400, y: 0 };
    const chunks = mine(miner);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const speed = Math.hypot(c.vx, c.vy);
      // Aimed at the miner (the rock's normal here points the other way)
      const toMiner = Math.atan2(miner.y - c.y, miner.x - c.x), heading = Math.atan2(c.vy, c.vx);
      expect(Math.abs(Math.atan2(Math.sin(heading - toMiner), Math.cos(heading - toMiner)))).toBeLessThan(0.2);
      // 1.2 to 2.6, and the boost on top
      expect(speed).toBeGreaterThan(1.2 + 3.4);
      expect(speed).toBeLessThan(2.6 + 3.8);
    }
  });

  it('with nobody to throw to, fly straight out of the rock as before', () => {
    for (const c of mine(null)) {
      expect(c.vx).toBeLessThan(0);
      expect(Math.hypot(c.vx, c.vy)).toBeLessThan(2.7);
    }
  });
});

describe('mining tools', () => {
  it('weapons are half as good at mining as they were; the mining laser, siphon and charges are as they were', () => {
    const t = table.tools as unknown as Record<string, { yield: number }>;
    // (Before: laser 0.55, shells from a fixed gun 0.12, from a turret 0.08, a lance 0.12)
    expect(t.laser.yield).toBeCloseTo(0.275);
    expect(t.fixed.yield).toBeCloseTo(0.06);
    expect(t.turret.yield).toBeCloseTo(0.04);
    expect(t.lance.yield).toBeCloseTo(0.06);
    expect(t.miner.yield).toBe(1.6);
    expect(t.siphon.yield).toBe(1.4);
    expect(t.charge.yield).toBe(2.5);
  });
});

describe('chunks', () => {
  it('break off 5 to 10 units at a time (what is left still drops when the rock is mined out)', () => {
    const sizes: number[] = [];
    let crumbled = false;
    const h: MiningHost = {
      spawnChunk: (_s, _x, _y, _vx, _vy, items: Bag) => { sizes.push(Object.values(items).reduce((a, b) => a + b, 0)); },
      awardXp: () => {}, notify: () => {}, tick: () => 0, respawn: () => {}, crumble: () => { crumbled = true; },
    };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'sol:0:0', 400, 1);
    const units = m.get(1)!.units;
    for (let k = 0; k < 2000 && !crumbled; k++) m.extract(1, 99, 2, { yield: 1.6, hardness: 2 }, 0, 0, 1, 0);
    expect(crumbled).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(units);
    for (const n of sizes.slice(0, -1)) { expect(n).toBeGreaterThanOrEqual(5); expect(n).toBeLessThanOrEqual(10); }
    expect(sizes.at(-1)!).toBeLessThanOrEqual(10);
  });

  it('rocks hold 1.5x the ore they did (0.1 a unit of size before)', () => {
    expect(table.unitsPerSize).toBeCloseTo(0.15);
  });
});

describe('the laser crowd curve', () => {
  it('each laser is most efficient with k on the rock; the total always rises, towards k·q/(q-1)', () => {
    for (const k of [1.5, 4, 5, 10]) for (const q of [2, 3, 4]) {
      expect(crowdFactor(k, k, q)).toBeCloseTo(1, 12);
      for (const d of [0.25, 1, 3]) {
        expect(crowdFactor(k + d, k, q)).toBeLessThan(1);
        if (k - d > 0) expect(crowdFactor(k - d, k, q)).toBeLessThan(1);
      }
      let last = 0;
      for (let n = 1; n <= 60; n++) {
        const total = n * crowdFactor(n, k, q);
        expect(total).toBeGreaterThan(last);
        expect(total).toBeLessThan((k * q) / (q - 1));
        last = total;
      }
    }
    // Kieran's form at q = 2: 2kn / (k² + n²)
    expect(crowdFactor(3, 1.5, 2)).toBeCloseTo((2 * 1.5 * 3) / (1.5 * 1.5 + 9), 12);
  });

  /** Units a second (a full-strength 42 dps mining laser) each of `n` lasers of `gap` grades from the rock's tier gets on a `type` rock */
  function perLaser(type: string, n: number, gap = 0): number {
    let t = 0;
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {}, rockTier: () => 3 };
    const m = new Mining(h, table);
    m.register(1, 0, 0, type, 'k', 1e6, 3);
    const before = m.remaining(1);
    for (t = 0; t < 600; t++) for (let i = 0; i < n; i++) m.extract(1, 100 + i, 42 / 60, { yield: 1.6, hardness: 3, grade: 3 + gap }, 0, 0, 1, 0);
    return (before - m.remaining(1)) / 10 / n;
  }

  it('one matching laser on a soft rock mines about as fast as before (5.6 units a second); more mine faster in all, each a little less past two', () => {
    const one = perLaser('asteroid_metal', 1), two = perLaser('asteroid_metal', 2), four = perLaser('asteroid_metal', 4), six = perLaser('asteroid_metal', 6);
    expect(one).toBeGreaterThan(5.6 * 0.95);
    expect(one).toBeLessThan(5.6 * 1.05);
    expect(2 * two).toBeGreaterThan(one);
    expect(4 * four).toBeGreaterThan(2 * two);
    expect(6 * six).toBeGreaterThan(4 * four);
    expect(four).toBeLessThan(two);
    expect(six).toBeLessThan(four);
  });

  it('hard rocks are slow alone and want about five lasers on them', () => {
    expect(rockCrowd(table, 'rock_cobaltite', 0)!.k).toBe(5);
    const one = perLaser('rock_cobaltite', 1), five = perLaser('rock_cobaltite', 5);
    expect(one).toBeLessThan(5.6 * 0.1);
    expect(five).toBeGreaterThan(one * 5);
  });

  it("a laser below the rock's tier needs more on the rock, and never out-mines matching ones however many", () => {
    expect(rockCrowd(table, 'rock_cobaltite', -1)!.k).toBe(10);
    for (const type of ['asteroid_metal', 'rock_cobaltite']) {
      // Alone, a grade behind is slow work; two behind is hardly worth it
      const own = perLaser(type, 1);
      expect(perLaser(type, 1, -1)).toBeLessThan(own * 0.4);
      expect(perLaser(type, 1, -2)).toBeLessThan(own * 0.1);
      for (const n of [1, 2, 4, 8, 16, 40]) {
        expect(perLaser(type, n, -1)).toBeLessThanOrEqual(perLaser(type, n, 0) * 1.0001);
        expect(perLaser(type, n, -2)).toBeLessThanOrEqual(perLaser(type, n, -1) * 1.0001);
      }
    }
    // A soft rock a grade behind alone: about a third of a matching laser (as it was before the curve)
    expect(perLaser('asteroid_metal', 1, -1) / perLaser('asteroid_metal', 1)).toBeGreaterThan(0.28);
  });

  it('other weapons get no crowd factor', () => {
    let t = 0;
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: () => {}, tick: () => t, respawn: () => {}, crumble: () => {} };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'k', 1e6, 1);
    const before = m.remaining(1);
    for (t = 0; t < 600; t++) for (let i = 0; i < 4; i++) m.extract(1, 100 + i, 10, { yield: 0.06, hardness: 1 }, 0, 0, 1, 0);
    expect(before - m.remaining(1)).toBe(Math.floor((600 * 10 * 0.06) / 12) * 4);
  });

  it('a hard rock with too few lasers on it says so, quietly; a soft rock says nothing', () => {
    const said: string[] = [];
    let t = 0;
    const h: MiningHost = { spawnChunk: () => {}, awardXp: () => {}, notify: (_e, text) => said.push(text), tick: () => t, respawn: () => {}, crumble: () => {}, rockTier: () => 3 };
    const m = new Mining(h, table);
    m.register(1, 0, 0, 'asteroid_metal', 'a', 1e6, 3);
    m.register(2, 0, 0, 'rock_cobaltite', 'b', 1e6, 3);
    for (t = 0; t < 600; t++) m.extract(1, 7, 1, { yield: 1.6, hardness: 3, grade: 3 }, 0, 0, 1, 0);
    expect(said).toEqual([]);
    for (; t < 1200; t++) m.extract(2, 7, 1, { yield: 1.6, hardness: 3, grade: 3 }, 0, 0, 1, 0);
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toBe('Hard rock: works best with 4-6 lasers on it');
    // (Throttled: once every 6 seconds)
    expect(said.length).toBeLessThanOrEqual(2);
  });
});
