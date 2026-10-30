import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { registerRockTypes, type Bag, type MiningTable } from '@space-game/common';
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
