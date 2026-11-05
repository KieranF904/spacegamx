import { describe, it, expect } from 'vitest';
import { capsuleConvexEntry, pointConvexDistance, segmentBoxEntry } from './collide.js';
import { segmentConvexEntry } from './geometry.js';
import type { Vec2 } from './types.js';

// A unit square, counter-clockwise (as pointInConvex takes them)
const SQ: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];

describe('collide', () => {
  it('a line that misses the square by 0.5 is caught by a capsule thicker than that, not by a thinner one', () => {
    expect(segmentConvexEntry(SQ, -1, 1.5, 2, 1.5)).toBeNull();
    expect(capsuleConvexEntry(SQ, -1, 1.5, 2, 1.5, 0.4)).toBeNull();
    const t = capsuleConvexEntry(SQ, -1, 1.5, 2, 1.5, 0.6);
    expect(t).not.toBeNull();
    // It first touches the top-left corner's disc: x = -sqrt(0.6² - 0.5²)
    expect(-1 + 3 * t!).toBeCloseTo(-Math.sqrt(0.36 - 0.25), 6);
  });

  it('a capsule head-on meets the face r before it, and one starting inside reads 0', () => {
    expect(capsuleConvexEntry(SQ, -2, 0.5, 2, 0.5, 0.25)! * 4 - 2).toBeCloseTo(-0.25, 6);
    expect(capsuleConvexEntry(SQ, 0.5, 0.5, 3, 3, 0.1)).toBe(0);
    expect(capsuleConvexEntry(SQ, 1.05, 0.5, 3, 0.5, 0.1)).toBe(0);
  });

  it('distance to the outline: 0 inside, to an edge, to a corner', () => {
    expect(pointConvexDistance(SQ, 0.3, 0.7)).toBe(0);
    expect(pointConvexDistance(SQ, 0.5, 1.4)).toBeCloseTo(0.4, 9);
    expect(pointConvexDistance(SQ, 2, 2)).toBeCloseTo(Math.SQRT2, 9);
  });

  it('box entry: where a segment enters a padded box, -1 past it', () => {
    const b = { minX: 0, minY: 0, maxX: 1, maxY: 1 };
    expect(segmentBoxEntry(-1, 0.5, 3, 0.5, b)).toBeCloseTo(0.25, 9);
    expect(segmentBoxEntry(-1, 1.2, 3, 1.2, b)).toBe(-1);
    expect(segmentBoxEntry(-1, 1.2, 3, 1.2, b, 0.3)).toBeGreaterThanOrEqual(0);
    expect(segmentBoxEntry(0.5, 0.5, 0.5, 0.5, b)).toBe(0);
  });
});
