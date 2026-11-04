/**
 * The focus grid's geometry and the dropped-cell cache's wire forms (network/cells.ts, CAPS.FOCUS)
 */
import { describe, it, expect } from 'vitest';
import {
  CELL_SIZE, FOCUS_RANGE, RING_RANGE, CELL_HOME_SLACK, focusCellKey, focusCellXY, cellAt, homeCell, cellDist2, focusCells, ringCells,
  cellMemberHash, cellHash, packCellLog, unpackCellLogs, ghostWeight,
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

  it('a cell hash is the same in any member order, moves with any member, never 0', () => {
    const b = { x: 10.25, y: -3.5, vx: 1.0001, vy: 0, angle: 0.12345, angVel: 0 };
    const a = cellMemberHash(5, b, 3, 7), c = cellMemberHash(9, b, 3, 7);
    expect(cellHash([[5, a], [9, c]])).toBe(cellHash([[9, c], [5, a]]));
    expect(cellMemberHash(5, { ...b, x: 10.26 }, 3, 7)).not.toBe(a);
    expect(cellMemberHash(5, b, 3, 8)).not.toBe(a);
    expect(cellHash([])).not.toBe(0);
  });

  it('logs round-trip', () => {
    const out: number[] = [];
    packCellLog(out, focusCellKey(2, -3), 1000, [{ id: 7, events: [[1003, 5, 100], [1100, 0, 90]] }, { id: 8, events: [] }]);
    packCellLog(out, focusCellKey(1, 1), 1200, []);
    expect(unpackCellLogs(out)).toEqual([
      { cell: focusCellKey(2, -3), T: 1000, ships: [{ id: 7, events: [[1003, 5, 100], [1100, 0, 90]] }, { id: 8, events: [] }] },
      { cell: focusCellKey(1, 1), T: 1200, ships: [] },
    ]);
  });
});
