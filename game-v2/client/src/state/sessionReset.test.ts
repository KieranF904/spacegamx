/**
 * A new connection (GameState.resetSession): nothing of the last session's world or clock is kept. The new session never
 * removes what the old one sent (a ghost of your old ship stayed in the world), and a restarted server's ticks start
 * again, which the prediction and the delay queue must follow from scratch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityType, type ServerSnapshotMessage } from '@space-game/common';
import { GameState } from './GameState';

const snap = (tick: number, ids: number[]): ServerSnapshotMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 0, removed: [], entities: ids.map((id) => ({ id, type: EntityType.Player, x: 0, y: 0, vx: 0, vy: 0, angle: 0, data: [] })) } as unknown as ServerSnapshotMessage);

describe('GameState on a new connection', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('forgets the old world and clock: the next session starts as the first did', () => {
    let now = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const s = new GameState();
    s.playerId = 5;
    s.handlePong(Date.now(), 0, 90_000);
    s.applySnapshot(snap(90_000, [5, 6]));
    s.ticksDue(now);
    expect(s.predictedTick).toBeGreaterThan(89_000);
    expect(s.entities.size).toBe(2);

    s.resetSession();
    expect(s.entities.size).toBe(0);
    expect(s.playerId).toBe(0);
    expect([s.predictedTick, s.serverTick, s.clockSynced]).toEqual([0, 0, false]);

    // (The restarted server: tick 300, only the new ship)
    now += 100;
    s.playerId = 5;
    s.handlePong(Date.now(), 0, 300);
    s.applySnapshot(snap(300, [5]));
    expect([...s.entities.keys()]).toEqual([5]);
    s.ticksDue(now);
    expect(Math.abs(s.predictedTick - 300)).toBeLessThan(20);
  });
});
