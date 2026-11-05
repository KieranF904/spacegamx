/**
 * The focus grid's geometry and the ships-away list both ends keep (network/cells.ts, CAPS.FOCUS)
 */
import { describe, it, expect } from 'vitest';
import {
  CELL_SIZE, FOCUS_RANGE, RING_RANGE, CELL_HOME_SLACK, focusCellKey, focusCellXY, cellAt, homeCell, cellDist2, focusCells, ringCells,
  ghostWeight, AwayShips, AWAY_TICKS, AWAY_CAP,
} from './cells.js';

describe('focus grid cells', () => {
  it('keys round-trip, negative cells too', () => {
    for (const [x, y] of [[0, 0], [-1, -1], [37, -12], [-4000, 4000]]) expect(focusCellXY(focusCellKey(x, y))).toEqual([x, y]);
    expect(cellAt(-1, 0)).toBe(focusCellKey(-1, 0));
    expect(cellAt(CELL_SIZE, CELL_SIZE - 0.01)).toBe(focusCellKey(1, 0));
  });

  it('focus is every cell whose nearest point is within 19 km, flat; ring out to 35 km without it', () => {
    let fSum = 0, rSum = 0, n = 0;
    for (let i = 0; i < 64; i++) {
      const x = (i * 1237) % CELL_SIZE, y = (i * 3571) % CELL_SIZE;
      const f = focusCells(x, y), r = ringCells(x, y);
      for (const k of f) expect(cellDist2(k, x, y)).toBeLessThanOrEqual(FOCUS_RANGE ** 2);
      for (const k of r) { expect(f).not.toContain(k); expect(cellDist2(k, x, y)).toBeLessThanOrEqual(RING_RANGE ** 2); }
      fSum += f.length; rSum += r.length; n++;
    }
    // (about 27 and 48: the decision's figures)
    expect(fSum / n).toBeGreaterThan(24);
    expect(fSum / n).toBeLessThan(31);
    expect(rSum / n).toBeGreaterThan(40);
    expect(rSum / n).toBeLessThan(56);
  });

  it('a cell just past 19 km goes, just inside comes: no in/out band', () => {
    // The cell at cx = 3 starts at 24,576: from x = 24,576 - 19,000 it's in, a hair less it's out
    const k = focusCellKey(3, 0);
    expect(focusCells(24576 - 19000, 100)).toContain(k);
    expect(focusCells(24576 - 19000 - 0.01, 100)).not.toContain(k);
  });

  it('home cells change only past the slack', () => {
    const h = cellAt(100, 100);
    expect(homeCell(h, CELL_SIZE + CELL_HOME_SLACK - 1, 100)).toBe(h);
    expect(homeCell(h, CELL_SIZE + CELL_HOME_SLACK + 1, 100)).toBe(focusCellKey(1, 0));
    expect(homeCell(h, -CELL_HOME_SLACK - 1, 100)).toBe(focusCellKey(-1, 0));
    expect(homeCell(undefined, -1, -1)).toBe(focusCellKey(-1, -1));
  });

  it('ghost weight runs 0 to 1 over 18-19 km', () => {
    expect(ghostWeight(17000)).toBe(0);
    expect(ghostWeight(18500)).toBeCloseTo(0.5);
    expect(ghostWeight(30000)).toBe(1);
  });

  it('ships away: swept by age and capped by count, oldest first, the same at both ends', () => {
    const a = new AwayShips<string>(), b = new AwayShips<number>();
    const goneA: number[] = [], goneB: number[] = [];
    // (The same changes in the same order: both let the same ships go, without telling each other)
    for (let i = 0; i < AWAY_CAP + 10; i++) { a.leave(i, 100 + i, `s${i}`, (id) => goneA.push(id)); b.leave(i, 100 + i, i, (id) => goneB.push(id)); }
    expect(goneA).toEqual([...Array(10).keys()]);
    expect(goneB).toEqual(goneA);
    expect(a.size).toBe(AWAY_CAP);
    // (Back: taken out; leaving again puts it last)
    expect(a.take(20)).toBe('s20');
    expect(a.has(20)).toBe(false);
    a.leave(11, 5000, 'again');
    expect([...a.ids()].at(-1)).toBe(11);
    a.sweep(100 + 15 + AWAY_TICKS, (id) => goneA.push(id));
    // (Left at ticks 110..115 (bar 11, left again later): more than AWAY_TICKS ago at 115 + AWAY_TICKS: 110..114)
    expect(goneA.slice(10)).toEqual([10, 12, 13, 14]);
    expect(a.get(11)).toBe('again');
  });
});
