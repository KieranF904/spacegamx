/**
 * Belt asteroids (gameServer/asteroids.ts): a rock keeps its belt index when it breaks and grows back (its entity id is
 * new, the index is what clients and the mining table go by), and a rock is the same from the same (system, index, tick).
 */
import { describe, it, expect } from 'vitest';
import { Asteroid, InSystem } from '@space-game/common';
import { makeServer, resetGlobals } from '../testkits/world.testkit.js';
import { createAsteroid, forgetAsteroid, respawnAsteroid } from './asteroids.js';

function rig() {
  resetGlobals();
  const server = makeServer();
  const [systemNum, ids] = [...server.asteroidIdsBySystem.entries()].find(([, l]) => l.length > 3)!;
  const system = server.gameData.getSystemByNum(systemNum)!;
  return { server, systemNum, system, ids };
}

describe('asteroid ids', () => {
  it('a broken rock grown back is the same belt index under a new entity, listed once', () => {
    const { server, systemNum, ids } = rig();
    const old = ids[2];
    const index = server.asteroidIndexById.get(old)!;
    expect(index).toBeGreaterThanOrEqual(0);
    forgetAsteroid(server, old);
    expect(server.asteroidIdsBySystem.get(systemNum)!.includes(old)).toBe(false);
    expect(server.asteroidIndexById.has(old)).toBe(false);
    respawnAsteroid(server, systemNum, index);
    const list = server.asteroidIdsBySystem.get(systemNum)!;
    const fresh = list[list.length - 1];
    expect(server.asteroidIndexById.get(fresh)).toBe(index);
    expect(server.asteroidSpawnData(fresh).index).toBe(index);
    expect(InSystem.systemId[fresh]).toBe(systemNum);
    expect(new Set(list).size).toBe(list.length);
    expect(server.respawnedAsteroids.has(fresh)).toBe(true);
  });

  it('a rock is the same from the same (system, index, tick): clients derive the orbit and shape the server did', () => {
    const { server, systemNum, system, ids } = rig();
    const index = server.asteroidIndexById.get(ids[1])!;
    const a = createAsteroid(server, system, systemNum, index, 777);
    const b = createAsteroid(server, system, systemNum, index, 777);
    expect(a).not.toBe(b);
    for (const f of ['size', 'resourceType', 'orbitType', 'semiMajorAxis', 'eccentricity', 'argPeriapsis', 'meanAnomaly0', 'epochTick', 'wobblePhase'] as const) {
      expect(Asteroid[f][a]).toBe(Asteroid[f][b]);
    }
    expect(server.asteroidIndexById.get(a)).toBe(index);
    expect(server.asteroidTypeById.get(a)).toBe(server.asteroidTypeById.get(b));
  });
});
