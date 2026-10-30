import { describe, expect, it } from 'vitest';
import { AutoQuality, PROFILES } from './quality';

describe('AutoQuality', () => {
  it('stays high while frames are on time', () => {
    const q = new AutoQuality();
    for (let t = 0; t < 10000; t += 16.7) q.sample(16.7, t, 0);
    expect(q.tier).toBe('high');
  });

  it('steps down one tier at a time when frames stay slow, and stops at low', () => {
    const q = new AutoQuality();
    const seen: string[] = [];
    for (let t = 1; t < 40000; t += 40) if (q.sample(40, t, 0)) seen.push(q.tier);
    expect(seen).toEqual(['medium', 'low']);
  });

  it('does not count a cap as slow, or a stall as a frame', () => {
    const q = new AutoQuality();
    for (let t = 1; t < 20000; t += 33.3) q.sample(33.3, t, 33.3);
    for (let t = 20000; t < 30000; t += 1000) q.sample(1000, t, 0);
    expect(q.tier).toBe('high');
  });
});

describe('profiles', () => {
  it('high keeps the original look', () => {
    expect(PROFILES.high).toMatchObject({ msaa: true, maxDpr: 2, bloomScale: 0.25, particles: 1, hazeScale: 0.5 });
    expect(PROFILES.high.starLayers.every(Boolean)).toBe(true);
  });
});
