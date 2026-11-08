import { describe, it, expect } from 'vitest';
import { clamp, lerp, smoothstep, wrapPi, cloneJson } from './basic.js';
import { wrapAngle } from '../ships/flight.js';
import { wrapPi as turretWrapPi } from '../ships/turret.js';

describe('math/basic', () => {
  it('clamp and lerp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(lerp(10, 20, 0.25)).toBe(12.5);
  });
  it('smoothstep clamps and eases, either edge order', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(1, 0, 0.9)).toBeCloseTo(0.028, 12);
  });
  it('wrapPi matches the sim wraps bit for bit', () => {
    for (let a = -50; a <= 50; a += 0.173) {
      expect(wrapPi(a)).toBe(wrapAngle(a));
      expect(wrapPi(a)).toBe(turretWrapPi(a));
    }
  });
  it('cloneJson is deep', () => {
    const o = { a: [1, { b: 2 }] };
    const c = cloneJson(o);
    expect(c).toEqual(o);
    expect(c.a).not.toBe(o.a);
  });
});
