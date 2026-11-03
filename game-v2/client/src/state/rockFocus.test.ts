import { afterEach, describe, expect, it, vi } from 'vitest';
import { EntityType, type ServerSnapshotMessage } from '@space-game/common';
import { GameState, type InterpolatedEntity } from './GameState';

const TICK_MS = 1000 / 60;
const snap = (tick: number): ServerSnapshotMessage =>
  ({ type: 'snapshot', tick, lastProcessedInput: 0, entities: [], removed: [] } as unknown as ServerSnapshotMessage);

/** A rock on a circular orbit of radius 5000 round the origin, `size` across its half-width */
function rock(id: number, size: number): InterpolatedEntity {
  return {
    id, type: EntityType.Asteroid, x: 0, y: 0, angle: 0, vx: 0, vy: 0, renderX: 0, renderY: 0, renderAngle: 0,
    data: [size, 0], isDeterministic: true, orbitType: 0, semiMajorAxis: 5000, eccentricity: 0, argPeriapsis: 0, meanAnomaly0: 0, epochTick: 0,
  } as InterpolatedEntity;
}

/** How many of `frames` ticks the rock was placed on, with the view's edge `gap` short of its middle */
function placements(size: number, gap: number, frames = 32): number {
  const s = new GameState();
  s.predictionEnabled = false;
  s.applySnapshot(snap(1000));
  s.applySnapshot(snap(1003));
  const r = rock(9, size);
  s.entities.set(r.id, r);
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const st = s as unknown as { serverTickTarget: number; serverTickTargetTime: number };
  st.serverTickTarget = 1003; st.serverTickTargetTime = 0;
  // First frame places it wherever it is; the view is then set just off it
  s.interpolate(1 / 60);
  const hw = 1000;
  s.orbitFocus = { cx: r.x - (hw + gap), cy: r.y, px: r.x - (hw + gap), py: r.y, hw, hh: hw };
  let placed = 0;
  for (let i = 1; i <= frames; i++) {
    now = i * TICK_MS;
    const before = r.orbitTick;
    s.interpolate(1 / 60);
    if (r.orbitTick !== before) placed++;
  }
  return placed;
}

describe('rocks just off the view (GameState.orbitFocus)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a big rock whose middle is off the view but whose body is on it is placed every tick', () => {
    // Middle 500 past the box's edge; reaches 800 × 1.3 = 1040: some of it is in view
    expect(placements(800, 500)).toBe(32);
  });

  it('a small rock as far off is placed only now and then', () => {
    expect(placements(30, 500)).toBeLessThan(10);
  });
});
