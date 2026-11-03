import { describe, expect, it } from 'vitest';
import { packRanges, unpackRanges } from './ranges.js';

describe('packRanges', () => {
  it('turns counting runs into [start, count]', () => {
    expect(packRanges([5, 6, 7, 8, 20, 21, 40])).toEqual([5, 4, 20, 2, 40, 1]);
    expect(packRanges([])).toEqual([]);
  });
  it('round trips any list, sorted or not, with gaps and repeats', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let n = 0; n < 200; n++) {
      const list = Array.from({ length: Math.floor(rnd() * 60) }, () => (rnd() < 0.7 ? -1 : Math.floor(rnd() * 5000)));
      for (let i = 0; i < list.length; i++) if (list[i] === -1) list[i] = i ? list[i - 1] + 1 : 3;
      expect(unpackRanges(packRanges(list))).toEqual(list);
    }
  });
  it('stops at max', () => {
    expect(unpackRanges([0, 100], 10)).toHaveLength(10);
  });
});
