import { describe, it, expect } from 'vitest';
import { packMapDot, type MapDot } from '@space-game/common';
import { FarShips } from './FarShips';

const msg = (tick: number, dots: MapDot[], names?: (number | string)[]) => {
  const out: number[] = [];
  for (const d of dots) packMapDot(out, d);
  return { type: 'mapDots' as const, tick, dots: out, names };
};
const dot = (id: number, x: number, y: number, vx: number, vy: number): MapDot => ({ id, x, y, vx, vy, kind: 3, rank: 0, calm: false, faction: 1, rating: 12 });

describe('far ships on the map', () => {
  it('carry on along their velocity between lists, and ease a correction out instead of jumping', () => {
    const f = new FarShips();
    f.apply(msg(1000, [dot(7, 50000, 0, 4, 0)], [7, 'Raider']), 'sol', 1000);
    const at = (t: number) => f.list('sol', t)[0];
    expect(at(1000).name).toBe('Raider');
    expect(at(1030).renderX).toBeCloseTo(50120, 0);
    // The next list has it a little further on than carried (it sped up): drawn where it was, then eased over
    const before = at(1060).renderX;
    f.apply(msg(1060, [dot(7, 50400, 0, 6, 0)]), 'sol', 1060);
    expect(Math.abs(at(1060).renderX - before)).toBeLessThan(1);
    let last = at(1060).renderX;
    for (let t = 1061; t < 1120; t++) {
      const x = at(t).renderX;
      expect(x - last).toBeGreaterThan(0);
      expect(x - last).toBeLessThan(15);
      last = x;
    }
    expect(at(1120).renderX).toBeCloseTo(50400 + 6 * 60, 0);
    // Gone from the list: gone from the map; another system's list: nothing here
    f.apply(msg(1120, []), 'sol', 1120);
    expect(f.list('sol', 1120).length).toBe(0);
    f.apply(msg(1180, [dot(9, 0, 0, 0, 0)]), 'ashfall', 1180);
    expect(f.list('sol', 1180).length).toBe(0);
    expect(f.list('ashfall', 1180).length).toBe(1);
    // Ones the client has as real ships are left to them
    expect(f.list('ashfall', 1180, (id) => id === 9).length).toBe(0);
  });
});
