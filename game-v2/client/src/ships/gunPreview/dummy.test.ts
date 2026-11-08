import { describe, expect, it } from 'vitest';
import { castPoly, dummyPoly, normalAt } from './dummy';

describe('preview dummy', () => {
  const poly = dummyPoly(300, 46);
  it('a line from the muzzle meets the plate short of its centre, on its edge', () => {
    const t = castPoly(poly, 0, 0, 400, 0)!;
    expect(t).not.toBeNull();
    expect(t * 400).toBeGreaterThan(300 - 46);
    expect(t * 400).toBeLessThan(300);
  });
  it('a line that stops short or passes wide misses; one starting inside is at once', () => {
    expect(castPoly(poly, 0, 0, 200, 0)).toBeNull();
    expect(castPoly(poly, 0, 120, 400, 120)).toBeNull();
    expect(castPoly(poly, 300, 0, 400, 0)).toBe(0);
  });
  it('the struck edge faces the shell and is off-square (the plate is turned)', () => {
    const t = castPoly(poly, 0, 0, 400, 0)!;
    const n = normalAt(poly, t * 400, 0, 1, 0, { nx: 0, ny: 0 })!;
    expect(n.nx).toBeLessThan(0);
    expect(Math.abs(n.ny)).toBeGreaterThan(0.1);
  });
});
