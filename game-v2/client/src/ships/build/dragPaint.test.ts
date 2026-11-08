import { describe, it, expect } from 'vitest';
import { cellsAlong, DragPaint } from './dragPaint';

const cells = (pts: [number, number][]) => pts.map((p) => `${Math.floor(p[0])},${Math.floor(p[1])}`);

describe('cellsAlong', () => {
  it('stays in one cell', () => {
    expect(cells(cellsAlong([0.2, 0.2], [0.8, 0.9]))).toEqual(['0,0']);
  });
  it('walks a horizontal run without skipping', () => {
    expect(cells(cellsAlong([0.5, 0.5], [4.5, 0.5]))).toEqual(['0,0', '1,0', '2,0', '3,0', '4,0']);
  });
  it('walks backwards and diagonally', () => {
    expect(cells(cellsAlong([3.5, 3.5], [0.5, 0.5]))).toEqual(['3,3', '2,2', '1,1', '0,0']);
  });
  it('visits every cell a shallow line crosses, in order, each once', () => {
    const c = cells(cellsAlong([0.1, 0.1], [5.9, 1.9]));
    expect(new Set(c).size).toBe(c.length);
    expect(c[0]).toBe('0,0');
    expect(c[c.length - 1]).toBe('5,1');
    for (let i = 1; i < c.length; i++) {
      const [x0, y0] = c[i - 1].split(',').map(Number), [x1, y1] = c[i].split(',').map(Number);
      expect(Math.abs(x1 - x0) + Math.abs(y1 - y0)).toBe(1); // never jumps
    }
  });
  it('handles negative coordinates', () => {
    expect(cells(cellsAlong([-0.5, -0.5], [-2.5, -0.5]))).toEqual(['-1,-1', '-2,-1', '-3,-1']);
  });
  it('ends on the true end point', () => {
    const p = cellsAlong([0.5, 0.5], [3.25, 2.75]);
    expect(p[p.length - 1]).toEqual([3.25, 2.75]);
  });
});

describe('DragPaint', () => {
  it('counts the start cell as visited', () => {
    const d = new DragPaint([0.5, 0.5]);
    expect(d.visit([0.9, 0.1])).toEqual([]);
  });
  it('hands out each cell once however the cursor wanders', () => {
    const d = new DragPaint([0.5, 0.5]);
    const a = cells(d.visit([3.5, 0.5]));
    expect(a).toEqual(['1,0', '2,0', '3,0']);
    const b = cells(d.visit([1.5, 0.5])); // back over cells already done
    expect(b).toEqual([]);
    const c = cells(d.visit([1.5, 2.5]));
    expect(c).toEqual(['1,1', '1,2']);
  });
  it('does not skip cells on a fast drag', () => {
    const d = new DragPaint([0.5, 0.5]);
    expect(cells(d.visit([20.5, 0.5])).length).toBe(20);
  });
});
