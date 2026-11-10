/**
 * The tick driver (app/tickDriver.ts): online, every tick number is stepped exactly once up to the estimated server tick
 * (at most 4 a frame, the rest next frame); the 1 Hz state hash goes out stamped with the tick the prediction is at.
 */
import { describe, expect, it, vi } from 'vitest';

const sampled: number[] = [];
const fake = {
  cachedServerTick: 0,
  predictedTick: 100,
  target: 100,
  boostFuel: 5,
  systemId: 1,
  entities: new Map<number, unknown>(),
  playerId: 7,
  drained: 0,
  cachedUpdates: 0,
  ticksDue() { return Math.max(0, this.target - this.predictedTick); },
  drainDelayQueue() { this.drained++; },
  updateCachedServerTick() { this.cachedUpdates++; },
};
vi.mock('./inputSend', () => ({ tickInput: vi.fn(() => { sampled.push(fake.cachedServerTick); }) }));
import { TickDriver, type TickHost } from './tickDriver';

function host(sent: unknown[] = []): TickHost {
  return { state: fake as never, ctx: {} as never, send: (m) => { sent.push(m); } };
}

describe('TickDriver online', () => {
  it('steps each due tick once, stamping the tick before sampling input', () => {
    sampled.length = 0; fake.predictedTick = 100; fake.target = 103; fake.drained = 0;
    new TickDriver(host()).run();
    expect(sampled).toEqual([100, 101, 102]);
    expect(fake.predictedTick).toBe(103);
    expect(fake.drained).toBe(3);
    expect(fake.cachedServerTick).toBe(103);
  });

  it('runs at most 4 steps a frame and carries on next frame without skipping or repeating a tick number', () => {
    sampled.length = 0; fake.predictedTick = 200; fake.target = 209;
    const d = new TickDriver(host());
    d.run();
    expect(sampled).toEqual([200, 201, 202, 203]);
    d.run();
    d.run();
    expect(sampled).toEqual([200, 201, 202, 203, 204, 205, 206, 207, 208]);
    d.run();
    expect(sampled).toHaveLength(9);
    expect(fake.predictedTick).toBe(209);
  });

  it('runs nothing when the prediction is already at the target', () => {
    sampled.length = 0; fake.predictedTick = 50; fake.target = 50;
    new TickDriver(host()).run();
    expect(sampled).toEqual([]);
    expect(fake.cachedServerTick).toBe(50);
  });
});

describe('TickDriver.sendHash', () => {
  it('sends at most once a second, stamped with the prediction tick, and not without a ship', () => {
    const sent: Array<{ type: string; tick: number; hash: number }> = [];
    const d = new TickDriver(host(sent));
    fake.cachedServerTick = 321;
    fake.entities.clear();
    d.sendHash(5000);
    expect(sent).toHaveLength(0);
    fake.entities.set(7, { x: 1, y: 2, angle: 0, vx: 0, vy: 0, hp: 10 });
    d.sendHash(5000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'stateHash', tick: 321 });
    d.sendHash(5500);
    expect(sent).toHaveLength(1);
    d.sendHash(6100);
    expect(sent).toHaveLength(2);
  });

  it('the hash follows the ship', () => {
    const sent: Array<{ hash: number }> = [];
    const d = new TickDriver(host(sent));
    fake.entities.set(7, { x: 1, y: 2, angle: 0, vx: 0, vy: 0, hp: 10 });
    d.sendHash(10_000);
    fake.entities.set(7, { x: 1.5, y: 2, angle: 0, vx: 0, vy: 0, hp: 10 });
    d.sendHash(12_000);
    expect(sent[0].hash).not.toBe(sent[1].hash);
  });
});
