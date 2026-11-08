/**
 * @contract server.gameserver.world
 * owns:       building the starting world: stations, rifts, portals
 * needs:      GameServer (type), data/GameData
 * invariants: entities are created in a fixed order (ids are part of the frame hash) — server/src/golden/frameHash.test.ts
 * extend:      a new static world entity kind is a create* function called from initializeWorld
 */

import { addEntity, addComponent } from 'bitecs';
import { Position, Radius, Station, Portal, NetworkSync, InSystem, calcAsteroidPosition, stationOrbitTimeScale, scaledOrbitTick } from '@space-game/common';
import { RiftData } from '@space-game/common';
import { RIFT_TRIGGER_RADIUS } from './shared.js';
import { createAsteroids } from './asteroids.js';
import type { GameServer } from '../GameServer.js';

export function initializeWorld(gs: GameServer): void {
  // Create entities for each star system
  for (const system of gs.gameData.getAllSystems()) {
    const systemNum = gs.gameData.getSystemNum(system.id);
    
    // Create stations
    for (const stationId of system.stations) {
      const stationData = gs.gameData.getStation(stationId);
      if (stationData) {
        createStation(gs, stationData, systemNum);
      }
    }
    
    // Create jump gates and rifts
    for (const portalData of system.portals) {
      createPortal(gs, portalData, systemNum);
    }
    for (const rift of system.rifts ?? []) {
      createRift(gs, rift, systemNum);
    }

    // Derelict hulks (pre-made ships, battered) to break up for salvage
    for (const d of system.derelicts ?? []) {
      const slot = { data: d, systemNum, eid: -1, respawnTick: 0, spawns: 0 };
      gs.derelicts.push(slot);
      // (A system remembered has its own back as they were: SystemMemory)
      if (!gs.memory.remembers(system.id)) gs.derelictsMod.spawnDerelict(slot);
    }
    for (const t of system.traffic ?? []) {
      const slot = { data: t, systemNum, eid: -1, leg: 0, dwell: 0, respawnTick: 0 };
      gs.traffic.push(slot);
    }
    
    // Create asteroids
    createAsteroids(gs, system, systemNum);
  }
  
  // Every belt filed: the orbit timetable trimmed to what's in it
  gs.asteroidOrbits.settle();
  gs.derelictsMod.spawnPersonCraft();
  console.log('World initialized');
}

export function createStation(gs: GameServer, data: any, systemNum: number): number {
  const eid = addEntity(gs.world);
  addComponent(gs.world, Position, eid);
  addComponent(gs.world, Radius, eid);
  addComponent(gs.world, Station, eid);
  addComponent(gs.world, InSystem, eid);
  addComponent(gs.world, NetworkSync, eid);
  
  if (data.orbit) {
    const orbitType = data.orbit.orbitType ?? 0;
    const semiMajorAxis = data.orbit.semiMajorAxis ?? 0;
    const eccentricity = data.orbit.eccentricity ?? 0;
    const argPeriapsis = data.orbit.argPeriapsis ?? 0;
    const meanAnomaly0 = data.orbit.meanAnomaly0 ?? 0;
    const epochTick = data.orbit.epochTick ?? 0;
    const timeScale = data.orbit.timeScale ?? stationOrbitTimeScale(semiMajorAxis);
    const { x, y } = calcAsteroidPosition({
      orbitType,
      semiMajorAxis,
      eccentricity,
      argPeriapsis,
      meanAnomaly0,
      epochTick,
    }, scaledOrbitTick(gs.currentTick, epochTick, timeScale));
    Station.orbitTimeScale[eid] = timeScale;
    Position.x[eid] = x;
    Position.y[eid] = y;
    Station.orbitType[eid] = orbitType;
    Station.semiMajorAxis[eid] = semiMajorAxis;
    Station.eccentricity[eid] = eccentricity;
    Station.argPeriapsis[eid] = argPeriapsis;
    Station.meanAnomaly0[eid] = meanAnomaly0;
    Station.epochTick[eid] = epochTick;
  } else {
    Position.x[eid] = data.position.x;
    Position.y[eid] = data.position.y;
    Station.orbitType[eid] = 255;
    Station.semiMajorAxis[eid] = 0;
    Station.eccentricity[eid] = 0;
    Station.argPeriapsis[eid] = 0;
    Station.meanAnomaly0[eid] = 0;
    Station.epochTick[eid] = 0;
    Station.orbitTimeScale[eid] = 1;
  }
  Radius.value[eid] = data.radius;
  Station.stationId[eid] = gs.gameData.getStationNum(data.id) || 0;
  Station.dockingRadius[eid] = data.dockingRadius;
  InSystem.systemId[eid] = systemNum;
  
  return eid;
}

export function createRift(gs: GameServer, data: RiftData, systemNum: number): number {
  const eid = addEntity(gs.world);
  addComponent(gs.world, Position, eid);
  addComponent(gs.world, Radius, eid);
  addComponent(gs.world, Portal, eid);
  addComponent(gs.world, InSystem, eid);
  addComponent(gs.world, NetworkSync, eid);
  Position.x[eid] = data.position.x;
  Position.y[eid] = data.position.y;
  Radius.value[eid] = RIFT_TRIGGER_RADIUS;
  Portal.kind[eid] = 1;
  Portal.hue[eid] = data.hue ?? 275;
  Portal.targetSystem[eid] = gs.gameData.getSystemNum(data.destination.system);
  Portal.targetX[eid] = data.destination.x;
  Portal.targetY[eid] = data.destination.y;
  InSystem.systemId[eid] = systemNum;
  return eid;
}

export function createPortal(gs: GameServer, data: any, systemNum: number): number {
  const eid = addEntity(gs.world);
  addComponent(gs.world, Position, eid);
  addComponent(gs.world, Radius, eid);
  addComponent(gs.world, Portal, eid);
  addComponent(gs.world, InSystem, eid);
  addComponent(gs.world, NetworkSync, eid);
  
  Position.x[eid] = data.position.x;
  Position.y[eid] = data.position.y;
  Radius.value[eid] = 200;
  Portal.targetSystem[eid] = gs.gameData.getSystemNum(data.targetSystem);
  Portal.kind[eid] = 0;
  InSystem.systemId[eid] = systemNum;
  
  return eid;
}
