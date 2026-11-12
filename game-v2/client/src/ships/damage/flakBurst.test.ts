import { describe, expect, it } from 'vitest';
import { FRAGMENT_FRAMES, FRAGMENT_SHORT, fragmentCount, fragmentEnd, fragmentPlan, insideConvex, type Fragment } from './flakBurst';

describe('flak fragments', () => {
  it('throws 10 to 16 by quality tier', () => {
    expect(fragmentCount(1)).toBe(16);
    expect(fragmentCount(0.8)).toBe(13);
    expect(fragmentCount(0.6)).toBe(13);
    expect(fragmentCount(0.3)).toBe(10);
    expect(fragmentCount(0)).toBe(10);
  });

  it.each([[10, 170], [13, 250], [16, 170], [16, 250]])('%i fragments of uneven length, none past a %i radius', (count, radius) => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const plan = fragmentPlan(count, radius, rnd);
    expect(plan).toHaveLength(count);
    const end = { x: 0, y: 0 };
    const reaches = plan.map((f) => f.speed * FRAGMENT_FRAMES);
    for (const [i, f] of plan.entries()) {
      expect(reaches[i]).toBeLessThanOrEqual(radius + 1e-9);
      expect(reaches[i]).toBeGreaterThanOrEqual(radius * FRAGMENT_SHORT - 1e-9);
      fragmentEnd(40, -20, f, end);
      expect(Math.hypot(end.x - 40, end.y + 20)).toBeCloseTo(reaches[i], 6);
    }
    // (the longest shows the damage radius; the rest are well spread short of it)
    expect(Math.max(...reaches)).toBeCloseTo(radius, 9);
    expect(Math.min(...reaches)).toBeLessThan(radius * 0.75);
    expect(new Set(reaches.map((r) => Math.round(r))).size).toBeGreaterThan(count / 3);
  });

  it('spreads the fragments round the whole circle', () => {
    const plan: Fragment[] = fragmentPlan(12, 100, () => 0.5);
    const angles = plan.map((f) => ((f.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i++) expect(angles[i] - angles[i - 1]).toBeCloseTo((Math.PI * 2) / 12, 6);
  });
});

describe('a fragment end on a ship', () => {
  const square = [[0, 0], [4, 0], [4, 4], [0, 4]];
  it('is inside a part outline only within it', () => {
    expect(insideConvex(square, 2, 2)).toBe(true);
    expect(insideConvex(square, 5, 2)).toBe(false);
    expect(insideConvex(square, -0.1, 2)).toBe(false);
  });
  it('works for either winding', () => {
    expect(insideConvex([...square].reverse(), 1, 3)).toBe(true);
  });
});
