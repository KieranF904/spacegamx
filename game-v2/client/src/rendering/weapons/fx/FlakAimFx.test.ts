import { describe, expect, it } from 'vitest';
import { dashCount, dashEnds } from './FlakAimFx';

describe('flak aim marker dashes', () => {
  it('has more dashes for a bigger circle, within bounds', () => {
    expect(dashCount(50)).toBe(10);
    expect(dashCount(170)).toBe(14);
    expect(dashCount(250)).toBe(21);
    expect(dashCount(9999)).toBe(28);
  });
  it('puts every dash end on the circle, evenly spaced and turned by the phase', () => {
    const out = [0, 0, 0, 0], n = 14, r = 170, slot = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      dashEnds(100, -50, r, n, i, 0.3, out);
      expect(Math.hypot(out[0] - 100, out[1] + 50)).toBeCloseTo(r, 6);
      expect(Math.hypot(out[2] - 100, out[3] + 50)).toBeCloseTo(r, 6);
      expect(Math.atan2(out[1] + 50, out[0] - 100)).toBeCloseTo(Math.atan2(Math.sin(0.3 + i * slot), Math.cos(0.3 + i * slot)), 6);
    }
  });
});
