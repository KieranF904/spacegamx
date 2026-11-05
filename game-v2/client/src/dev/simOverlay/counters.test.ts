import { describe, it, expect } from 'vitest';
import { RateCounter, ValueWindow, ReconcileWatcher } from './counters';

describe('overlay counters', () => {
  it('RateCounter gives events a second over its window and forgets old ones', () => {
    const r = new RateCounter(2000);
    for (let t = 0; t < 2000; t += 100) r.add(t);
    expect(r.perSec(1999)).toBeCloseTo(10, 5);
    expect(r.perSec(5000)).toBe(0);
  });

  it('ValueWindow keeps the mean and max of the window', () => {
    const w = new ValueWindow(1000);
    w.push(0, 1); w.push(500, 3); w.push(900, 8);
    expect(w.mean(900)).toBeCloseTo(4);
    expect(w.max(900)).toBe(8);
    expect(w.max(1600)).toBe(8);
    expect(w.count(2500)).toBe(0);
  });

  it('ReconcileWatcher notices a change in the reconcile stats, not a repeat', () => {
    const w = new ReconcileWatcher();
    const s = { predErrorPre: 0, predErrorPreAvg: 0, predPendingCount: 0, predSnapCount: 0 };
    expect(w.observe(0, s)).toBeNull();
    expect(w.observe(16, s)).toBeNull();
    const hit = w.observe(32, { ...s, predErrorPre: 2.5, predErrorPreAvg: 0.4, predPendingCount: 6 });
    expect(hit).toEqual({ size: 2.5, ticks: 6, snapped: false });
    expect(w.observe(48, { ...s, predErrorPre: 2.5, predErrorPreAvg: 0.4, predPendingCount: 6 })).toBeNull();
    expect(w.observe(64, { ...s, predErrorPre: 9, predErrorPreAvg: 1, predPendingCount: 5, predSnapCount: 1 })?.snapped).toBe(true);
    expect(w.sizes.max(64)).toBe(9);
    expect(w.resteps.perSec(64)).toBeGreaterThan(0);
  });
});
