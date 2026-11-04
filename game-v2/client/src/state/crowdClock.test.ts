/**
 * The client's clock in a slowed system (CAPS.CROWD, time dilation: common network/crowd.ts): a rate said ahead turns
 * it at its tick, carrying on from where it was; another system's clock (a tick far off) is taken at once.
 */
import { describe, expect, it } from 'vitest';
import { GameState } from './GameState';

describe('crowd clock (CAPS.CROWD)', () => {
  it('turns at the stated tick: 60 ticks a second before, 30 after, with no jump', () => {
    const s = new GameState();
    const t0 = 10_000;
    // (a pong: tick 1000 at t0, no round trip to speak of)
    const realNow = Date.now;
    Date.now = () => 0;
    try { s.handlePong(0, 0, 1000); } finally { Date.now = realNow; }
    (s as unknown as { serverTickTargetTime: number }).serverTickTargetTime = t0;
    (s as unknown as { tickOffset: number }).tickOffset = 1000 - t0 / s.tickMs;
    expect(s.getEstimatedServerTick(t0)).toBeCloseTo(1000, 5);
    s.onCrowd({ tick: 1030, lv: 7, f: 10000, w: 9, r: 30 }, t0);
    expect(s.crowd).toMatchObject({ lv: 7, rate: 30, window: 9, focus: 10000 });
    // 0.5 s at 60 a second: tick 1030, where it turns
    expect(s.getEstimatedServerTick(t0 + 500)).toBeCloseTo(1030, 3);
    // then 1 s at 30 a second
    expect(s.getEstimatedServerTick(t0 + 1500)).toBeCloseTo(1060, 3);
    expect(s.tickMs).toBeCloseTo(1000 / 30, 6);
    // (the window's wider: snapshots further apart, the interpolation waits for them)
    expect(s.crowdDelayMs).toBeCloseTo(6 * (1000 / 30), 6);
    // Back to 60 from 1090
    s.onCrowd({ tick: 1090, lv: 0, f: 19000, w: 3, r: 60 }, t0 + 1500);
    expect(s.getEstimatedServerTick(t0 + 2500)).toBeCloseTo(1090, 3);
    expect(s.getEstimatedServerTick(t0 + 3500)).toBeCloseTo(1150, 3);
    expect(s.crowdDelayMs).toBe(0);
  });

  it("another system's clock (its tick far from this one) is taken at once", () => {
    const s = new GameState();
    const t0 = 10_000;
    (s as unknown as { serverTickTarget: number }).serverTickTarget = 5000;
    (s as unknown as { serverTickTargetTime: number }).serverTickTargetTime = t0;
    (s as unknown as { tickOffset: number }).tickOffset = 5000 - t0 / s.tickMs;
    s.onCrowd({ tick: 4200, lv: 7, f: 10000, w: 9, r: 30 }, t0);
    expect(s.getEstimatedServerTick(t0)).toBeCloseTo(4200, 3);
    expect(s.getEstimatedServerTick(t0 + 1000)).toBeCloseTo(4230, 3);
  });
});
