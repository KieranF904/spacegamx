/**
 * @contract server.gameserver.asteroids
 * owns:       creating, breaking, respawning and announcing asteroids and their ids
 * needs:      GameServer (type), common asteroid helpers; npm: bitecs
 * invariants: asteroid ids stay stable across respawns — none pinned
 * extend:      a new asteroid stage rule goes into shedAsteroid or createAsteroid
 */

import { addEntity, addComponent, hasComponent } from 'bitecs';
import { Position, Velocity, Radius, Health, Asteroid, NetworkSync, InSystem, Dead, ASTEROID_SEED, asteroidParamsAt, beltTotal, calcAsteroidPosition, calcOrbitStateRaw, OrbitType } from '@space-game/common';
import { EntityType, TUTORIAL_ROCK_TYPE, datan2, dhypot } from '@space-game/common';
import { asteroidQuery } from './shared.js';
import type { GameServer } from '../GameServer.js';

export function createAsteroids(gs: GameServer, system: any, systemNum: number): void {
  const belt = system.asteroidBelt;
  if (!belt) return;
  const ids: number[] = [];
  const seedTick = gs.currentTick;
  for (let i = 0; i < beltTotal(belt); i++) ids.push(createAsteroid(gs, system, systemNum, i, seedTick));
  gs.asteroidIdsBySystem.set(systemNum, ids);
  gs.asteroidSeedTickBySystem.set(systemNum, seedTick);
}

/**
 * One belt asteroid, deterministic from (system, index, spawn tick) so clients
 * derive the same orbit, shape and composition. Respawns use a new tick.
 */
export function createAsteroid(gs: GameServer, system: any, systemNum: number, i: number, spawnTick: number): number {
  const belt = system.asteroidBelt;
  const systemId = system.id || String(systemNum);
  const params = asteroidParamsAt(systemId, i, ASTEROID_SEED, spawnTick, belt, system.asteroidField as string | undefined);
  const { x, y } = calcAsteroidPosition({
    orbitType: params.orbitType,
    semiMajorAxis: params.semiMajorAxis,
    eccentricity: params.eccentricity,
    argPeriapsis: params.argPeriapsis,
    meanAnomaly0: params.meanAnomaly0,
    epochTick: params.epochTick,
  }, gs.currentTick);
  const eid = addEntity(gs.world);
  for (const c of [Position, Velocity, Radius, Asteroid, Health, InSystem, NetworkSync]) addComponent(gs.world, c, eid);
  const size = params.size;
  const hp = Math.floor(size * params.healthPerUnit);
  Position.x[eid] = x;
  Position.y[eid] = y;
  Velocity.x[eid] = 0;
  Velocity.y[eid] = 0;
  Radius.value[eid] = size;
  Asteroid.size[eid] = size;
  Asteroid.hp[eid] = hp;
  Asteroid.maxHp[eid] = hp;
  Asteroid.resourceType[eid] = params.resourceType;
  Asteroid.resourceAmount[eid] = Math.floor(size / 10) + 1;
  Asteroid.orbitType[eid] = params.orbitType;
  Asteroid.semiMajorAxis[eid] = params.semiMajorAxis;
  Asteroid.eccentricity[eid] = params.eccentricity;
  Asteroid.argPeriapsis[eid] = params.argPeriapsis;
  Asteroid.meanAnomaly0[eid] = params.meanAnomaly0;
  Asteroid.epochTick[eid] = params.epochTick;
  Asteroid.wobblePhase[eid] = params.wobblePhase;
  Health.current[eid] = hp;
  Health.max[eid] = hp;
  InSystem.systemId[eid] = systemNum;
  gs.asteroidIndexById.set(eid, i);
  gs.asteroidTypeById.set(eid, params.definitionId || 'asteroid_metal');
  // (From the stored fields: they're what its position is worked out from)
  gs.asteroidOrbits.add(eid, systemNum, {
    semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: Asteroid.eccentricity[eid], argPeriapsis: Asteroid.argPeriapsis[eid],
    meanAnomaly0: Asteroid.meanAnomaly0[eid], epochTick: Asteroid.epochTick[eid], size: Asteroid.size[eid],
    fixed: Asteroid.orbitType[eid] === OrbitType.Fixed,
  });
  if (params.outlier) gs.asteroidStageById.set(eid, { stage: 0, wholeSize: size });
  gs.mining.register(eid, systemNum, i, params.definitionId || 'asteroid_metal', `${systemId}:${i}:${spawnTick}`, size, system.danger ?? 1, params.outlier ? { stage: 0, wholeSize: size } : undefined);
  return eid;
}

/** A training body's hp: never reached (the training counters are per pilot: game/tutorial/Tutorial.ts) */
const TRAINING_HP = 1_000_000;

/**
 * A rock or drone of the training yard: a real asteroid in the shared sim that never moves (a fixed orbit), never loses
 * hp and never breaks, so every pilot collides with it alike. Told to clients like a regrown rock (asteroidSpawn on
 * entering the system), by an index above any belt's (TUTORIAL_INDEX_BASE + its place in data/tutorial.json).
 */
export function createTrainingBody(gs: GameServer, systemNum: number, index: number, size: number, x: number, y: number): number {
  const eid = addEntity(gs.world);
  for (const c of [Position, Velocity, Radius, Asteroid, Health, InSystem, NetworkSync]) addComponent(gs.world, c, eid);
  Radius.value[eid] = size;
  Asteroid.size[eid] = size;
  Asteroid.hp[eid] = Asteroid.maxHp[eid] = Health.current[eid] = Health.max[eid] = TRAINING_HP;
  Asteroid.resourceType[eid] = 0;
  Asteroid.resourceAmount[eid] = 0;
  Asteroid.orbitType[eid] = OrbitType.Fixed;
  Asteroid.semiMajorAxis[eid] = dhypot(x, y);
  Asteroid.eccentricity[eid] = 0;
  Asteroid.argPeriapsis[eid] = datan2(y, x);
  Asteroid.meanAnomaly0[eid] = 0;
  Asteroid.epochTick[eid] = 0;
  Asteroid.wobblePhase[eid] = 0;
  Velocity.x[eid] = Velocity.y[eid] = 0;
  InSystem.systemId[eid] = systemNum;
  gs.asteroidIndexById.set(eid, index);
  gs.asteroidTypeById.set(eid, TUTORIAL_ROCK_TYPE);
  gs.asteroidOrbits.add(eid, systemNum, {
    semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: 0, argPeriapsis: Asteroid.argPeriapsis[eid],
    meanAnomaly0: 0, epochTick: 0, size, fixed: true,
  });
  gs.placeAsteroid(eid);
  const ids = gs.asteroidIdsBySystem.get(systemNum);
  if (ids) ids.push(eid);
  gs.respawnedAsteroids.add(eid);
  return eid;
}

/**
 * An outlier's stage broke away: the smaller rock it leaves, on the same
 * orbit (a new entity, so a new shape), holding the ore that's left.
 */
export function shedAsteroid(gs: GameServer, old: number, stage: number, size: number, left: number): void {
  const systemNum = InSystem.systemId[old];
  const system = gs.gameData.getSystemByNum(systemNum);
  const index = gs.asteroidIndexById.get(old) ?? 0;
  const type = gs.asteroidTypeById.get(old) ?? 'asteroid_metal';
  const wholeSize = gs.asteroidStageById.get(old)?.wholeSize ?? Asteroid.size[old];
  const eid = addEntity(gs.world);
  for (const c of [Position, Velocity, Radius, Asteroid, Health, InSystem, NetworkSync]) addComponent(gs.world, c, eid);
  // Its health per size as the whole rock's
  const hp = Math.floor(size * (Asteroid.maxHp[old] / (Asteroid.size[old] || 1)));
  Asteroid.size[eid] = size;
  Radius.value[eid] = size;
  Asteroid.hp[eid] = Asteroid.maxHp[eid] = Health.current[eid] = Health.max[eid] = hp;
  Asteroid.resourceType[eid] = Asteroid.resourceType[old];
  Asteroid.resourceAmount[eid] = Math.floor(size / 10) + 1;
  Asteroid.orbitType[eid] = Asteroid.orbitType[old];
  Asteroid.semiMajorAxis[eid] = Asteroid.semiMajorAxis[old];
  Asteroid.eccentricity[eid] = Asteroid.eccentricity[old];
  Asteroid.argPeriapsis[eid] = Asteroid.argPeriapsis[old];
  Asteroid.meanAnomaly0[eid] = Asteroid.meanAnomaly0[old];
  Asteroid.epochTick[eid] = Asteroid.epochTick[old];
  Asteroid.wobblePhase[eid] = Asteroid.wobblePhase[old];
  Velocity.x[eid] = Velocity.y[eid] = 0;
  InSystem.systemId[eid] = systemNum;
  gs.asteroidIndexById.set(eid, index);
  gs.asteroidTypeById.set(eid, type);
  gs.asteroidStageById.set(eid, { stage, wholeSize });
  gs.asteroidOrbits.add(eid, systemNum, {
    semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: Asteroid.eccentricity[eid], argPeriapsis: Asteroid.argPeriapsis[eid],
    meanAnomaly0: Asteroid.meanAnomaly0[eid], epochTick: Asteroid.epochTick[eid], size,
    fixed: Asteroid.orbitType[eid] === OrbitType.Fixed,
  });
  gs.placeAsteroid(eid);
  gs.mining.register(eid, systemNum, index, type, `${system?.id || String(systemNum)}:${index}:${Asteroid.epochTick[eid]}`, size, system?.danger ?? 1, { stage, wholeSize, left });
  announceAsteroid(gs, eid);
}

/** A broken asteroid grows back: re-create it and tell everyone in the system */
export function respawnAsteroid(gs: GameServer, systemNum: number, index: number): void {
  const system = gs.gameData.getSystemByNum(systemNum);
  if (!system?.asteroidBelt) return;
  announceAsteroid(gs, createAsteroid(gs, system, systemNum, index, gs.currentTick));
}

/** A rock that's not in its belt's seed (grown back, or an outlier's next stage): tell everyone in the system */
export function announceAsteroid(gs: GameServer, eid: number): void {
  const systemNum = InSystem.systemId[eid];
  gs.respawnedAsteroids.add(eid);
  const ids = gs.asteroidIdsBySystem.get(systemNum);
  if (ids) ids.push(eid);
  for (const c of gs.clients.values()) if (InSystem.systemId[c.playerId] === systemNum) c.knownEntities.add(eid);
  gs.broadcastToSystem(systemNum, { type: 'asteroidSpawn', tick: gs.currentTick, asteroids: [gs.asteroidSpawnData(eid)] });
}

export function asteroidSpawnData(gs: GameServer, eid: number) {
  const system = gs.gameData.getSystemByNum(InSystem.systemId[eid]);
  return {
    id: eid, size: Asteroid.size[eid], resourceType: Asteroid.resourceType[eid], orbitType: Asteroid.orbitType[eid],
    semiMajorAxis: Asteroid.semiMajorAxis[eid], eccentricity: Asteroid.eccentricity[eid], argPeriapsis: Asteroid.argPeriapsis[eid],
    meanAnomaly0: Asteroid.meanAnomaly0[eid], epochTick: Asteroid.epochTick[eid], wobblePhase: Asteroid.wobblePhase[eid],
    hp: Math.max(0, Asteroid.hp[eid]), maxHp: Asteroid.maxHp[eid], stage: gs.asteroidStageById.get(eid)?.stage,
    index: gs.asteroidIndexById.get(eid), definitionId: gs.asteroidTypeById.get(eid), systemId: system?.id,
  };
}

/** A broken asteroid leaves its system's list (its entity id will be reused) */
export function forgetAsteroid(gs: GameServer, eid: number): void {
  const ids = gs.asteroidIdsBySystem.get(InSystem.systemId[eid]);
  if (ids) { const k = ids.indexOf(eid); if (k >= 0) ids.splice(k, 1); }
  gs.asteroidIndexById.delete(eid);
  gs.asteroidTypeById.delete(eid);
  gs.respawnedAsteroids.delete(eid);
  gs.asteroidOrbits.remove(eid);
  gs.asteroidPlacedAt.delete(eid);
  gs.asteroidStageById.delete(eid);
}

/**
 * Put an asteroid where its orbit has it this tick. Nothing moves asteroids
 * every tick: anything about to read one's Position calls this first.
 */
export function placeAsteroid(gs: GameServer, eid: number): void {
  if (gs.asteroidPlacedAt.get(eid) === gs.currentTick) return;
  gs.asteroidPlacedAt.set(eid, gs.currentTick);
  const state = calcOrbitStateRaw(
    Asteroid.orbitType[eid],
    Asteroid.semiMajorAxis[eid],
    Asteroid.eccentricity[eid],
    Asteroid.argPeriapsis[eid],
    Asteroid.meanAnomaly0[eid],
    Asteroid.epochTick[eid],
    gs.currentTick,
  );
  Position.x[eid] = state.x;
  Position.y[eid] = state.y;
}

/** Asteroids whose HP ran out without being handled where they were hit (HP first: a plain read) */
export function asteroidDeathSystem(gs: GameServer): void {
  const asteroids = asteroidQuery(gs.world);

  for (const eid of asteroids) {
    if (Asteroid.hp[eid] > 0 || hasComponent(gs.world, Dead, eid)) continue;
    {
      addComponent(gs.world, Dead, eid);
      gs.pendingRemovedEntities.add(eid);
      gs.placeAsteroid(eid);

      const systemId = InSystem.systemId[eid];
      const x = Position.x[eid];
      const y = Position.y[eid];
      const size = Asteroid.size[eid];
      
      // Notify clients
      gs.broadcastToSystem(systemId, {
        type: 'death',
        entityId: eid,
        entityType: EntityType.Asteroid,
      });
      
      // Spawn loot based on size (larger asteroids = better chance)
      gs.mining.onBroken(eid, x, y);
      forgetAsteroid(gs, eid);
      void size;
    }
  }
}
