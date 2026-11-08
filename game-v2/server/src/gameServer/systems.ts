/**
 * @contract server.gameserver.systems
 * owns:       small per-tick systems: player movement, station orbits, the broadphase build, lifetimes and cleanup
 * needs:      GameServer (type), gameServer/shared queries
 * invariants: run in the order of the tick table — server/src/tickOrder.test.ts
 * extend:      a new small system is a function here and an entry in loop.ts buildTickSystems
 */

import { removeEntity, addComponent, hasComponent } from 'bitecs';
import { Position, Radius, Lifetime, Projectile, Station, InSystem, Dead, scaledOrbitTick, calcOrbitStateRaw } from '@space-game/common';
import { stationQuery } from '../game/Docking.js';
import { SimPass } from '../sim/SystemClocks.js';
import { playerQuery, droppedItemQuery } from '../net/SnapshotBuilder.js';
import { lifetimeQuery, deadQuery } from './shared.js';
import { blowStuck } from './combat.js';
import type { GameServer } from '../GameServer.js';

export function playerMovementSystem(gs: GameServer): void {
  // (Pull fields not declared last tick act no more: before any pilot's step reads them, ships/bridge/pullFields.ts)
  gs.ships.pulls.settle(gs.currentTick, (sys) => SimPass.on(sys));
  for (const eid of playerQuery(gs.world)) if (SimPass.on(InSystem.systemId[eid])) { gs.gunNet.beforePilot(eid); gs.ships.stepMovement(eid); }
}

export function stationOrbitSystem(gs: GameServer): void {
  const stations = stationQuery(gs.world);

  for (const eid of stations) {
    if (Station.orbitType[eid] === 255 || Station.semiMajorAxis[eid] <= 0 || !SimPass.on(InSystem.systemId[eid])) continue;
    const state = calcOrbitStateRaw(
      Station.orbitType[eid],
      Station.semiMajorAxis[eid],
      Station.eccentricity[eid],
      Station.argPeriapsis[eid],
      Station.meanAnomaly0[eid],
      Station.epochTick[eid],
      scaledOrbitTick(gs.currentTick, Station.epochTick[eid], Station.orbitTimeScale[eid]),
    );
    Position.x[eid] = state.x;
    Position.y[eid] = state.y;
  }
}

export function buildSpatialGrid(gs: GameServer): void {
  // (Asteroids aren't in it: they're filed once, by orbit, in asteroidOrbits)
  // Add players
  for (const eid of playerQuery(gs.world)) {
    if (hasComponent(gs.world, Dead, eid)) continue;
    gs.spatialGrid.addEntity(
      eid, Position.x[eid], Position.y[eid], Radius.value[eid], 'player', InSystem.systemId[eid]
    );
  }
  
  // Add ship bodies that aren't players (dummies, debris)
  gs.ships.addToSpatialGrid((eid, x, y, r) => gs.spatialGrid.addEntity(eid, x, y, r, 'player', InSystem.systemId[eid]));

  // Add dropped items
  for (const eid of droppedItemQuery(gs.world)) {
    if (hasComponent(gs.world, Dead, eid)) continue;
    gs.spatialGrid.addEntity(
      eid, Position.x[eid], Position.y[eid], 15, 'item', InSystem.systemId[eid]
    );
  }
}

export function lifetimeSystem(gs: GameServer): void {
  const entities = lifetimeQuery(gs.world);
  
  for (const eid of entities) {
    if (!SimPass.on(InSystem.systemId[eid])) continue;
    Lifetime.remaining[eid]--;
    
    if (Lifetime.remaining[eid] <= 0) {
      if (hasComponent(gs.world, Projectile, eid)) { blowStuck(gs, eid); gs.weapons.onExpire(eid); }
      addComponent(gs.world, Dead, eid);
      // Track for removal notification to clients
      gs.pendingRemovedEntities.add(eid);
    }
  }
  
}

export function cleanupSystem(gs: GameServer): void {
  const dead = deadQuery(gs.world);
  
  for (const eid of dead) {
    // Ensure all dead entities are in the removed set (safety net)
    gs.pendingRemovedEntities.add(eid);
    // (What was kept by this entity's id goes with it: a left player's last snapshot states, its rift cooldown)
    gs.lastEntityStates.delete(eid);
    gs.riftCooldown.delete(eid);
    removeEntity(gs.world, eid);
  }
}
