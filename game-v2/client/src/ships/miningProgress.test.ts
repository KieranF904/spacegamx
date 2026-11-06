import { describe, expect, it, vi } from 'vitest';
import { unitsPerDrop, type MiningTable } from '@space-game/common';

// (No canvas here: the strike's particle textures are stand-ins)
vi.mock('../rendering/fxTextures', () => ({ disc: () => 'disc', rock: (i: number) => `rock:${Math.abs(i) % 4}` }));

import miningJson from '../../../data/mining.json';
import { MiningProgress, SHOW_FOR, FADE } from './MiningProgress';
import { POD_NEAR, POD_WITHIN } from '../rendering/weapons/MiningStrikeFx';

const table = miningJson as unknown as MiningTable;

function rig() {
  let t = 100;
  const p = new MiningProgress(null, table, () => t);
  return { p, at: (s: number) => { t = s; }, now: () => t };
}

describe('the mining progress ring (your work towards your next drop, worked out from your own hits)', () => {
  it("a starter's Pips fill it in about the server's average time between their drops on Mk I rock", () => {
    const { p, at } = rig();
    // Two Pips, a 28 shell each every 30 ticks (112 a second between them), on soft Mk I rock
    let t = 100, filled = -1;
    for (let k = 0; k < 4000 && filled < 0; k++) {
      t += 15 / 60;
      at(t);
      if (p.shell(7, 'fixed', 28, 1, 0, 0) >= 1) filled = t - 100;
    }
    const want = (unitsPerDrop(table, table.guns!.keep) * table.damagePerUnit) / (112 * table.tools.fixed.yield);
    expect(filled).toBeGreaterThan(want * 0.9);
    expect(filled).toBeLessThan(want * 1.1);
  });

  it("a Mk I laser on its own grade's rock fills it in the server's average (it keeps it all)", () => {
    const { p, at } = rig();
    let t = 100, filled = -1;
    for (let k = 0; k < 4000 && filled < 0; k++) {
      t += 1 / 60;
      at(t);
      if (p.laser(7, 42, 1 / 60, 1, 1, 0, 0) >= 1) filled = t - 100;
    }
    const want = (unitsPerDrop(table, 1) * table.damagePerUnit) / (42 * table.tools.miner.yield);
    expect(filled).toBeGreaterThan(want * 0.95);
    expect(filled).toBeLessThan(want * 1.05);
    // Mk III rock is past a Mk I laser: no work, no ring
    expect(p.laser(8, 42, 1, 1, 4, 0, 0)).toBe(0);
  });

  it('a chunk appearing by your strikes is your drop: the ring starts over; one far off or long after is not', () => {
    const { p, at } = rig();
    for (let k = 0; k < 6; k++) p.shell(7, 'fixed', 28, 1, 50, 0);
    expect(p.progress(7)).toBeGreaterThan(0);
    expect(p.dropAt(50 + POD_NEAR * 2, 0)).toBe(false);
    at(100 + POD_WITHIN * 2);
    expect(p.dropAt(60, 0)).toBe(false);
    at(100);
    expect(p.dropAt(60, 10)).toBe(true);
    expect(p.progress(7)).toBe(0);
  });

  it("ore you mined coming into your hold is the drop of the rock you worked last (a pod already seen isn't counted twice)", () => {
    const { p, at } = rig();
    for (let k = 0; k < 6; k++) p.shell(7, 'fixed', 28, 1, 50, 0);
    at(100.3);
    for (let k = 0; k < 6; k++) p.shell(8, 'fixed', 28, 1, 900, 0);
    at(100.5);
    expect(p.dropped()).toBe(true);
    expect(p.progress(8)).toBe(0);
    expect(p.progress(7)).toBeGreaterThan(0);
    // (Its pod seen, then caught: one drop)
    p.shell(7, 'fixed', 28, 1, 50, 0);
    expect(p.dropAt(55, 0)).toBe(true);
    p.shell(7, 'fixed', 28, 1, 50, 0);
    expect(p.dropped()).toBe(false);
    expect(p.progress(7)).toBeGreaterThan(0);
    // Long after you stopped mining: not a drop of anything
    at(200);
    expect(p.dropped()).toBe(false);
  });

  it('is up while you work the rock, fades a little after you stop', () => {
    const { p, at } = rig();
    p.shell(7, 'fixed', 28, 1, 0, 0);
    expect(p.visibility(7)).toBe(1);
    at(100 + SHOW_FOR + FADE / 2);
    expect(p.visibility(7)).toBeCloseTo(0.5, 1);
    at(100 + SHOW_FOR + FADE + 0.1);
    expect(p.visibility(7)).toBe(0);
    expect(p.visibility(99)).toBe(0);
  });
});
