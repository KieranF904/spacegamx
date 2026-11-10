/**
 * Small client state modules: a rock's first position is its orbit position at the current tick (asteroidEntities), and
 * the guide marks are empty unless a lesson step sets some (guideMarks).
 */
import { describe, expect, it } from 'vitest';
import { calcAsteroidPosition, type AsteroidSpawnData } from '@space-game/common';
import { spawnAsteroids, type AsteroidHost } from './asteroidEntities';
import { guideMarks, setGuideMarks } from './guideMarks';
import type { EntityMap } from './entities';

describe('a rock\'s first position is its orbit position at the current tick, not (0, 0)', () => {
  it('x, y and the render position are the orbit at the raw server tick, at once', () => {
    const entities = new Map() as unknown as EntityMap;
    const host: AsteroidHost = { entities, composeAsteroid: null, getRawServerTick: () => 5000, clearDeterministicAsteroids: () => {} };
    const orbit = { orbitType: 'ellipse', semiMajorAxis: 3000, eccentricity: 0.1, argPeriapsis: 0.5, meanAnomaly0: 1.2, epochTick: 100 };
    spawnAsteroids(host, 5000, [{ id: 77, size: 3, resourceType: 1, hp: 10, maxHp: 10, wobblePhase: 0, ...orbit } as unknown as AsteroidSpawnData]);
    const e = entities.get(77)!;
    const want = calcAsteroidPosition(orbit as never, 5000);
    expect(Math.hypot(want.x, want.y)).toBeGreaterThan(100); // a real spot, not the origin
    expect([e.x, e.y]).toEqual([want.x, want.y]);
    expect([e.renderX, e.renderY]).toEqual([want.x, want.y]);
  });
});

describe('guide marks are empty unless a lesson step is pointing at a spot', () => {
  it('none to start with, the lesson\'s list while set, none again when cleared', () => {
    expect(guideMarks()).toEqual([]);
    const spot = { x: 10, y: 20, radius: 300, label: 'Jump here' };
    setGuideMarks([spot]);
    expect(guideMarks()).toEqual([spot]);
    setGuideMarks([]);
    expect(guideMarks()).toEqual([]);
  });
});
