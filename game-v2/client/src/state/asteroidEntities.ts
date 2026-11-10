/**
 * @contract client.state.asteroid-entities
 * owns:       making the client's asteroid entities from spawn messages and from the deterministic belt seed, and clearing them
 * needs:      AsteroidHost (entities, composeAsteroid, getRawServerTick), common asteroid orbit maths
 * invariants: a rock's first position is its orbit position at the current tick, not (0, 0) — client/src/state/asteroidGuideState.test.ts
 * extend:     a new way asteroids arrive is one more exported function here and one delegating method on GameState
 */

import { EntityType, asteroidParamsAt, calcAsteroidPosition } from '@space-game/common';
import type { AsteroidSpawnData, AsteroidBeltData, Composition } from '@space-game/common';
import type { EntityMap, InterpolatedEntity } from './entities';

/** What the asteroid handlers read from the game state */
export interface AsteroidHost {
  readonly entities: EntityMap;
  composeAsteroid: ((type: string, key: string, size: number, systemId: string, stage?: number) => Composition) | null;
  getRawServerTick(now?: number): number;
  clearDeterministicAsteroids(): void;
}

/**
 * Handle one-time asteroid spawn data.
 * Creates InterpolatedEntity objects with orbit params — positions will be
 * calculated deterministically in interpolate() instead of from snapshots.
 */
export function spawnAsteroids(gs: AsteroidHost, tick: number, asteroids: AsteroidSpawnData[]): void {
  for (const a of asteroids) {
    // Skip if we already have this entity (shouldn't happen, but be safe)
    if (gs.entities.has(a.id)) continue;

    const entity: InterpolatedEntity = {
      id: a.id,
      type: EntityType.Asteroid,
      x: 0,
      y: 0,
      angle: 0,
      vx: 0,
      vy: 0,
      renderX: 0,
      renderY: 0,
      renderAngle: 0,
      hp: a.hp,
      maxHp: a.maxHp,
      data: [a.size, a.resourceType],
      // Deterministic orbit params
      orbitType: a.orbitType,
      semiMajorAxis: a.semiMajorAxis,
      eccentricity: a.eccentricity,
      argPeriapsis: a.argPeriapsis,
      meanAnomaly0: a.meanAnomaly0,
      epochTick: a.epochTick,
      wobblePhase: a.wobblePhase,
      isDeterministic: true,
      composition: a.definitionId && a.index !== undefined && a.systemId
        ? gs.composeAsteroid?.(a.definitionId, `${a.systemId}:${a.index}:${a.epochTick}`, a.size, a.systemId, a.stage ?? undefined) : undefined,
    };

    // Calculate initial position so the first frame isn't at (0,0)
    const currentTick = Math.round(gs.getRawServerTick());
    const { x, y } = calcAsteroidPosition({
      orbitType: a.orbitType,
      semiMajorAxis: a.semiMajorAxis,
      eccentricity: a.eccentricity,
      argPeriapsis: a.argPeriapsis,
      meanAnomaly0: a.meanAnomaly0,
      epochTick: a.epochTick,
    }, currentTick);
    entity.x = x;
    entity.y = y;
    entity.renderX = x;
    entity.renderY = y;

    gs.entities.set(a.id, entity);
  }
}

/**
 * Deterministic asteroid seed message — client derives params locally.
 */
export function seedAsteroids(
  gs: AsteroidHost,
  tick: number,
  systemId: string,
  seed: string,
  belt: AsteroidBeltData,
  ids: number[],
  indices: number[],
  asteroidField?: string,
): void {
  // Replace any existing deterministic asteroids to avoid stale state
  gs.clearDeterministicAsteroids();
  
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const index = indices[i] ?? i;
    if (gs.entities.has(id)) continue;

    // Use definition-based generation if field config exists
    const params = asteroidParamsAt(systemId, index, seed, tick, belt, asteroidField);
    
    // Calculate health using definition's healthPerUnit
    const hp = Math.floor(params.size * params.healthPerUnit);

    const entity: InterpolatedEntity = {
      id,
      type: EntityType.Asteroid,
      x: 0,
      y: 0,
      angle: 0,
      vx: 0,
      vy: 0,
      renderX: 0,
      renderY: 0,
      renderAngle: 0,
      hp,
      maxHp: hp,
      data: [params.size, params.resourceType],
      orbitType: params.orbitType,
      semiMajorAxis: params.semiMajorAxis,
      eccentricity: params.eccentricity,
      argPeriapsis: params.argPeriapsis,
      meanAnomaly0: params.meanAnomaly0,
      epochTick: params.epochTick,
      wobblePhase: params.wobblePhase,
      isDeterministic: true,
      composition: gs.composeAsteroid?.(params.definitionId || 'asteroid_metal', `${systemId}:${index}:${params.epochTick}`, params.size, systemId, params.outlier ? 0 : undefined),
    };

    const currentTick = Math.round(gs.getRawServerTick());
    const { x, y } = calcAsteroidPosition({
      orbitType: params.orbitType,
      semiMajorAxis: params.semiMajorAxis,
      eccentricity: params.eccentricity,
      argPeriapsis: params.argPeriapsis,
      meanAnomaly0: params.meanAnomaly0,
      epochTick: params.epochTick,
    }, currentTick);
    entity.x = x;
    entity.y = y;
    entity.renderX = x;
    entity.renderY = y;

    gs.entities.set(id, entity);
  }
}

export function clearDeterministicAsteroids(entities: EntityMap): void {
  for (const [id, entity] of entities) {
    if (entity.isDeterministic) {
      entities.delete(id);
    }
  }
}
