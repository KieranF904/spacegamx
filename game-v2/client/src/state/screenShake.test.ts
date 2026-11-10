/** Camera shake (state/screenShake.ts): trauma adds up and caps, drains with time, and the shake is trauma squared. */
import { describe, expect, it } from 'vitest';
import { triggerScreenShake, updateScreenShake, type ScreenShake } from './screenShake';

const fresh = (): ScreenShake => ({ trauma: 0, time: 0, offsetX: 0, offsetY: 0, rotation: 0 });

describe('screen shake', () => {
  it('a strong hit on top of a weak one shakes harder, and trauma never passes 1', () => {
    const a = fresh();
    triggerScreenShake(a, 2, 0.1);
    const weak = a.trauma;
    triggerScreenShake(a, 10, 0.5);
    expect(a.trauma).toBeGreaterThan(weak);
    for (let i = 0; i < 20; i++) triggerScreenShake(a, 18, 1);
    expect(a.trauma).toBe(1);
  });

  it('no or negative intensity adds nothing', () => {
    const a = fresh();
    triggerScreenShake(a, 0, 1);
    triggerScreenShake(a, -5, 1);
    expect(a.trauma).toBe(0);
  });

  it('with no trauma there is no offset or roll', () => {
    const a = fresh();
    updateScreenShake(a, 0.016);
    expect([a.offsetX, a.offsetY, a.rotation]).toEqual([0, 0, 0]);
  });

  it('drains to exactly 0 and stays there, and a long frame drains no more than a 0.1 s one', () => {
    const a = fresh(), b = fresh();
    a.trauma = b.trauma = 0.5;
    updateScreenShake(a, 0.1);
    updateScreenShake(b, 5);
    expect(b.trauma).toBeCloseTo(a.trauma, 9);
    for (let i = 0; i < 100; i++) updateScreenShake(a, 0.1);
    expect(a.trauma).toBe(0);
    expect(a.offsetX).toBe(0);
  });

  it('the offset stays within the full-trauma bound and the same state gives the same offset', () => {
    const a = fresh(), b = fresh();
    for (let i = 0; i < 50; i++) {
      a.trauma = b.trauma = 0.8;
      updateScreenShake(a, 0.016); updateScreenShake(b, 0.016);
      expect(Math.abs(a.offsetX)).toBeLessThanOrEqual(24 * 0.64 * 0.8 + 24 * 0.2);
      expect(Math.abs(a.offsetY)).toBeLessThanOrEqual(24);
      expect(a.offsetX).toBe(b.offsetX);
      expect(a.rotation).toBe(b.rotation);
    }
  });

  it('a small knock is much smaller than a big one (trauma squared)', () => {
    let small = 0, big = 0;
    for (let i = 0; i < 200; i++) {
      const s = fresh(), g = fresh();
      s.trauma = 0.2; g.trauma = 0.8; s.time = g.time = i * 0.37;
      updateScreenShake(s, 0.0001); updateScreenShake(g, 0.0001);
      small = Math.max(small, Math.abs(s.offsetX)); big = Math.max(big, Math.abs(g.offsetX));
    }
    expect(big).toBeGreaterThan(small * 8);
  });
});
