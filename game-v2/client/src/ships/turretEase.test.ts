import { describe, it, expect } from 'vitest';
import { easeTurret, fireCatch, EASE_FRAMES, FIRE_GAP } from './turretEase';

describe('drawn turret easing (visual only: turretEase.ts)', () => {
  it('chases the simulated angle: no snap, most of a gap gone in a few frames, on it in the end', () => {
    const target = 0.5;
    let d = easeTurret(0, target, 1, false);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(target * 0.4);
    for (let i = 1; i < EASE_FRAMES * 3; i++) d = easeTurret(d, target, 1, false);
    expect(target - d).toBeLessThan(target * 0.06);
    for (let i = 0; i < 60; i++) d = easeTurret(d, target, 1, false);
    expect(d).toBe(target);
  });

  it('the same however the frames are cut (frame-rate independent)', () => {
    let a = 0;
    for (let i = 0; i < 4; i++) a = easeTurret(a, 1, 1, false);
    const b = easeTurret(easeTurret(0, 1, 2, false), 1, 2, false);
    expect(a).toBeCloseTo(b, 12);
  });

  it('a full-circle turret goes the short way round; a limited one never through its back', () => {
    const full = easeTurret(3.0, -3.0, 1, true);
    expect(full > 3.0 || full < -3.0).toBe(true);
    const lim = easeTurret(2.5, -2.5, 1, false);
    expect(lim).toBeLessThan(2.5);
    expect(lim).toBeGreaterThan(-2.5);
  });

  it('first sight: on the target', () => {
    expect(easeTurret(NaN, 0.7, 1, false)).toBe(0.7);
  });

  it('on a shot: pulled within FIRE_GAP of the angle it fired at; already within, untouched', () => {
    expect(fireCatch(0, 1, false)).toBeCloseTo(1 - FIRE_GAP, 12);
    expect(fireCatch(1, 0, false)).toBeCloseTo(FIRE_GAP, 12);
    expect(fireCatch(0.99, 1, false)).toBe(0.99);
    // (the short way round, a full-circle turret)
    const w = fireCatch(3.1, -3.1, true);
    let gap = -3.1 - w;
    while (gap > Math.PI) gap -= 2 * Math.PI;
    while (gap < -Math.PI) gap += 2 * Math.PI;
    expect(Math.abs(gap)).toBeLessThanOrEqual(FIRE_GAP + 1e-12);
  });
});
