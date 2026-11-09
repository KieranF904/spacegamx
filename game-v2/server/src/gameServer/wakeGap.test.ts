import { describe, it, expect } from 'vitest';
import { TICK_MS } from '@space-game/common';
import { skipWakeGap, WAKE_GAP_MS } from './wakeGap.js';

describe('wake gap', () => {
  it('leaves a normal wakeup alone', () => {
    const gs = { currentTick: 10, tickAccumulator: 5 };
    const logs: string[] = [];
    expect(skipWakeGap(gs, 20, (m) => logs.push(m))).toBe(0);
    expect(skipWakeGap(gs, WAKE_GAP_MS, (m) => logs.push(m))).toBe(0);
    expect(gs).toEqual({ currentTick: 10, tickAccumulator: 5 });
    expect(logs).toEqual([]);
  });

  it('skips a big gap: tick counter jumps, accumulator cleared, logged once', () => {
    const gs = { currentTick: 100, tickAccumulator: 7 };
    const logs: string[] = [];
    const gap = 3_600_000; // an hour suspended
    const n = skipWakeGap(gs, gap, (m) => logs.push(m));
    expect(n).toBe(Math.floor(gap / TICK_MS));
    expect(gs.currentTick).toBe(100 + n);
    expect(gs.tickAccumulator).toBe(0);
    expect(logs).toHaveLength(1);
  });

  it('ignores NaN', () => {
    expect(skipWakeGap({ currentTick: 1, tickAccumulator: 0 }, NaN)).toBe(0);
  });
});
