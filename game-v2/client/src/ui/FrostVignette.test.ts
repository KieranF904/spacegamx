import { describe, it, expect } from 'vitest';
import { frostAmount, frostMask } from './FrostVignette';
import { PROFILES } from '../settings/quality';

describe('frost vignette', () => {
  it('no frost while warm; more as warmth runs down, all of it frozen through', () => {
    expect(frostAmount(100)).toBe(0);
    expect(frostAmount(99)).toBe(0);
    expect(frostAmount(90)).toBeGreaterThan(0);
    expect(frostAmount(50)).toBeCloseTo(0.5, 6);
    expect(frostAmount(0)).toBe(1);
    for (let p = 0; p < 100; p++) expect(frostAmount(p)).toBeGreaterThanOrEqual(frostAmount(p + 1));
  });

  it('frosts in from the edges: corners first, a band round the sides later, the middle always clear', () => {
    const corners = frostMask(frostAmount(90)), half = frostMask(frostAmount(50)), frozen = frostMask(1);
    // (The mask runs from the centre, 100 at a corner and about 71 at the middle of a side)
    expect(corners.inner).toBeGreaterThan(71);
    expect(half.inner).toBeLessThan(corners.inner);
    expect(frozen.inner).toBeLessThan(71);
    expect(frozen.inner).toBeGreaterThan(45);
    for (const m of [corners, half, frozen]) expect(m.outer).toBeGreaterThan(m.inner);
  });

  it('cheap on low: a tint only, no frost texture', () => {
    expect(PROFILES.low.frostTexture).toBe(0);
    expect(PROFILES.medium.frostTexture).toBeGreaterThan(0);
    expect(PROFILES.high.frostTexture).toBeGreaterThan(PROFILES.medium.frostTexture);
  });
});
