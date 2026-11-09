/**
 * @contract server.gameserver.combat
 * owns:       the weapon, projectile and collision passes of a tick, shot walls and rock damage
 * needs:      GameServer (type), gameServer/spatialGrid, game/Weapons; npm: @space-game/common, bitecs
 * invariants: collision order and spatial queries keep the frame hash — server/src/golden/frameHash.test.ts
 * extend:      a new kind of hit goes into collisionSystem beside the existing cases
 */

import { addComponent, hasComponent } from 'bitecs';
import { Position, Velocity, Radius, Health, Lifetime, Player, Projectile, Asteroid, InSystem, Dead, dhypot } from '@space-game/common';
import { EntityType, EffectType, getAsteroidPolygon, asteroidSpin, segmentNearCircle, segmentIntersectT, pointInPolygon } from '@space-game/common';
import { rayTerrain } from '@space-game/common';
import { activity } from '../activity/index.js';
import { SimPass } from '../sim/SystemClocks.js';
import { playerQuery, projectileQuery } from '../net/SnapshotBuilder.js';
import { KIND_OF_TYPE, NO_ROCKS } from './shared.js';
import { perfMetrics } from './perf.js';
import { forgetAsteroid } from './asteroids.js';
import type { GameServer } from '../GameServer.js';

export function weaponSystem(gs: GameServer): void {
  // (Each pilot's gun lane after its guns: what other clients step of them, net/guns/GunNet.ts)
  for (const eid of playerQuery(gs.world)) if (SimPass.on(InSystem.systemId[eid])) { const from = gs.ships.fired.length; gs.ships.stepWeapons(eid); gs.gunNet.pilot(eid, from); }
}

export function projectileSystem(gs: GameServer): void {
  gs.weapons.tick();
  const projectiles = projectileQuery(gs.world);

  for (const eid of projectiles) {
    if (!SimPass.on(InSystem.systemId[eid])) continue;
// Update position
    Position.x[eid] += Velocity.x[eid];
    Position.y[eid] += Velocity.y[eid];
  }
}

/** How far along this tick's step (0..1) a shot meets rock (1: it doesn't) */
export function shotWall(gs: GameServer, proj: number, systemId: number, px: number, py: number, vx: number, vy: number): number {
  const terrain = gs.terrainOf(systemId);
  if (!terrain) return 1;
  if (!gs.gameData.getSystemByNum(systemId)?.surface?.fixedWalls) return rayTerrain(terrain, px, py, px + vx, py + vy);
  const born = Projectile.spawnTick[proj];
  let c = gs.shotWalls.get(proj);
  // (a new shot in an old one's entity)
  if (c && c.born !== born) c = undefined;
  if (c && c.steady && Math.abs(c.vx - vx) + Math.abs(c.vy - vy) > 1e-3) c.steady = false;
  if (c && !c.steady) return rayTerrain(terrain, px, py, px + vx, py + vy);
  if (!c) {
    const life = Math.max(1, Lifetime.remaining[proj]);
    const t = rayTerrain(terrain, px, py, px + vx * life, py + vy * life);
    c = { born, steady: true, vx, vy, wx: t < 1 ? px + vx * life * t : NaN, wy: t < 1 ? py + vy * life * t : NaN };
    gs.shotWalls.set(proj, c);
  }
  if (Number.isNaN(c.wx)) return 1;
  const along = ((c.wx - px) * vx + (c.wy - py) * vy) / (vx * vx + vy * vy || 1);
  return along <= 1 ? Math.max(0, along) : 1;
}

/**
 * A shot's damage lands on an asteroid: it mines, the shot is spent, the rock may break. `stuck`: a mining charge
 * that stuck to the rock blowing (no shell is seen striking it then, so its sparks are sent)
 */
export function hurtAsteroid(gs: GameServer, proj: number, hitAsteroid: number, ownerId: number, damage: number, hitX: number, hitY: number, stuck = false): void {
  const systemId = InSystem.systemId[proj];
  const ax = Position.x[hitAsteroid];
  const ay = Position.y[hitAsteroid];
  // A training drone (game/tutorial): the hit is counted for this pilot alone; the body takes nothing and yields nothing
  const training = !!gs.tutorial?.hit(hitAsteroid, ownerId, damage);
  if (!training) Asteroid.hp[hitAsteroid] -= damage;
  // Any weapon mines soft rock, keeping little of it (mining tools crack harder rock and keep all they work: Mining.extract)
  if (!training && Projectile.miningYield[proj] > 0) {
    const nl = dhypot(hitX - ax, hitY - ay) || 1;
    // (A mining tool's shot, a mining charge, keeps all it works; any other is a gun's: Mining.extract)
    const tools = gs.gameData.miningTable.tools as unknown as Record<string, { mining?: boolean }>;
    const mining = !!tools[KIND_OF_TYPE.get(Projectile.weaponType[proj]) ?? '']?.mining;
    gs.mining.extract(hitAsteroid, ownerId, damage, { yield: Projectile.miningYield[proj], hardness: Projectile.miningHardness[proj], mining },
      hitX, hitY, (hitX - ax) / nl, (hitY - ay) / nl);
  }
  addComponent(gs.world, Dead, proj);
  gs.pendingRemovedEntities.add(proj);
  // The shell's end: every client finds its hits itself, so it has the shell end where its drawn shell meets the
  // drawn rock (WeaponFx.touch), and on its tick layer the snapshot's removed list ends it (a removed shell sits its
  // last window out, SelfHits; the server tells any hit in it, HitLedger 'removed'). A stuck charge blowing has no
  // shell seen striking: everyone hears of it
  if (stuck) gs.net.broadcastProjectileHit(proj, hitX, hitY);

  // The sparks where a shell strikes rock are every client's own too: it draws them where its drawn shell meets the
  // drawn rock (client ShipClient.struckFx, from WeaponFx.onStruck). They were a ~28 B effect to everyone in the system
  // on every hit (docs/audits/rock-bytes-2026-11-05.md). A stuck charge's still go
  if (stuck) {
    gs.broadcastToSystem(systemId, {
      type: 'effect',
      effectType: EffectType.LaserHit,
      x: hitX,
      y: hitY,
      entityId: hitAsteroid,
      data: [damage, 30], // damage, hue (default orange)
    });
  }

  // Check if asteroid destroyed
  if (Asteroid.hp[hitAsteroid] <= 0) {
    addComponent(gs.world, Dead, hitAsteroid);
    gs.pendingRemovedEntities.add(hitAsteroid);

    // Broadcast asteroid break
    gs.broadcastToSystem(systemId, {
      type: 'effect',
      effectType: EffectType.AsteroidBreak,
      x: ax,
      y: ay,
      data: [Asteroid.size[hitAsteroid], 30], // size, hue
    });

    gs.mining.onBroken(hitAsteroid, ax, ay);
    forgetAsteroid(gs, hitAsteroid);
  }
}

/** A stuck charge's time is up: it blows, and the rock takes its damage */
export function blowStuck(gs: GameServer, proj: number): void {
  const st = gs.stuckShots.get(proj);
  if (!st) return;
  gs.stuckShots.delete(proj);
  if (hasComponent(gs.world, Dead, st.asteroid)) return;
  gs.placeAsteroid(st.asteroid);
  gs.hurtAsteroid(proj, st.asteroid, Projectile.ownerId[proj], Projectile.damage[proj], Position.x[st.asteroid] + st.ox, Position.y[st.asteroid] + st.oy, true);
}

export function collisionSystem(gs: GameServer): void {
  const projectiles = projectileQuery(gs.world);
  // (now and then, forget the shots that are gone)
  if (gs.currentTick % 300 === 0 && gs.shotWalls.size) {
    const live = new Set(projectiles);
    for (const id of gs.shotWalls.keys()) if (!live.has(id)) gs.shotWalls.delete(id);
  }
  const players = playerQuery(gs.world);
  
  // Projectiles vs ships and asteroids
  for (const proj of projectiles) {
    if (hasComponent(gs.world, Dead, proj) || !SimPass.on(InSystem.systemId[proj])) continue;
    // A lobbed shell passes over everything until it comes down
    if (gs.weapons.lobbed(proj) || gs.weapons.unarmed(proj)) continue;
    // A charge stuck in rock rides it (and hurts nothing else)
    const stuck = gs.stuckShots.get(proj);
    if (stuck) {
      if (hasComponent(gs.world, Dead, stuck.asteroid)) { gs.stuckShots.delete(proj); addComponent(gs.world, Dead, proj); gs.pendingRemovedEntities.add(proj); continue; }
      gs.placeAsteroid(stuck.asteroid);
      Position.x[proj] = Position.x[stuck.asteroid] + stuck.ox;
      Position.y[proj] = Position.y[stuck.asteroid] + stuck.oy;
      continue;
    }
    
    const px = Position.x[proj];
    const py = Position.y[proj];
    const pr = Radius.value[proj];
    const systemId = InSystem.systemId[proj];
    const ownerId = Projectile.ownerId[proj];
    
    // Calculate the ray from current position to next (projectile moves fast)
    const vx = Velocity.x[proj];
    const vy = Velocity.y[proj];
    // A surface's rock: the shot's path this tick ends where it meets it
    // (A ghost round, the Phase Cannon's, flies through rock and asteroids: only ships stop it)
    const ghost = gs.weapons.ghost(proj);
    const wall = ghost ? 1 : gs.shotWall(proj, systemId, px, py, vx, vy);
    const endX = px + vx * wall;
    const endY = py + vy * wall;
    const speed = Math.sqrt(vx * vx + vy * vy);
    
    // Use spatial grid to find nearby entities
    const nearby = gs.spatialGrid.queryRay(systemId, px, py, endX, endY, speed + 100);
    perfMetrics.spatialQueries++;

    // Modular ships take hits on individual parts (railgun slugs pass through some)
    // (a great slow orb, a boss's, hits as wide as it's drawn: a shell's own width is next to nothing)
    const shipHit = gs.ships.hitProjectile(proj, ownerId, px, py, endX, endY, nearby, gs.weapons.exclusions(proj), pr >= 20 ? pr : 0);
    if (shipHit) {
      if (gs.weapons.onShipHit(proj, shipHit)) {
        addComponent(gs.world, Dead, proj);
        gs.pendingRemovedEntities.add(proj);
        gs.hits.end(proj);
      }
      continue;
    }
    // Single-body enemies: only pilots' shots hit them (their own side's pass through)
    if (hasComponent(gs.world, Player, ownerId)) {
      const mob = gs.mobs.rayHit(systemId, px, py, endX, endY, pr);
      if (mob) {
        const hx = px + (endX - px) * mob.t, hy = py + (endY - py) * mob.t;
        gs.mobs.hurt(mob.eid, Projectile.damage[proj]);
        if (gs.weapons.onMobHit(proj, hx, hy)) {
          addComponent(gs.world, Dead, proj);
          gs.pendingRemovedEntities.add(proj);
        }
        continue;
      }
    }
    // Into the rock: it bursts there
    if (wall < 1) {
      gs.shotWalls.delete(proj);
      gs.weapons.onWallHit(proj, endX, endY);
      addComponent(gs.world, Dead, proj);
      gs.pendingRemovedEntities.add(proj);
      continue;
    }

    // Check against asteroids using ray-traced collision with spatial grid
    let hitAsteroid: number | null = null;
    let hitX = endX;
    let hitY = endY;
    let bestT = Infinity;
    
    for (const asteroid of ghost ? NO_ROCKS : gs.asteroidOrbits.query(systemId, px, py, endX, endY, speed + 100, gs.currentTick)) {
      if (hasComponent(gs.world, Dead, asteroid) || gs.isGas(asteroid)) continue;
      if (InSystem.systemId[asteroid] !== systemId) continue;

      perfMetrics.collisionChecks++;
      gs.placeAsteroid(asteroid);

      const ax = Position.x[asteroid];
      const ay = Position.y[asteroid];
      const ar = Asteroid.size[asteroid];
      // Nowhere near its outline (which lies within its size of the centre): no hit, and the shot didn't start inside
      if (!segmentNearCircle(px, py, endX, endY, ax, ay, ar)) continue;
      
      // Get asteroid polygon for precise collision
      const poly = getAsteroidPolygon(asteroid, ax, ay, ar, asteroidSpin(asteroid, gs.currentTick));
      
      // Test ray against each edge of polygon
      for (let i = 0; i < poly.length; i++) {
        const p1 = poly[i];
        const p2 = poly[(i + 1) % poly.length];
        const t = segmentIntersectT(px, py, endX, endY, p1.x, p1.y, p2.x, p2.y);
        if (t !== null && t < bestT) {
          bestT = t;
          hitAsteroid = asteroid;
        }
      }
      
      // Also check if bullet started inside asteroid
      if (hitAsteroid !== asteroid && pointInPolygon(px, py, poly)) {
        bestT = 0;
        hitAsteroid = asteroid;
      }
    }
    
    if (hitAsteroid !== null) {
      // Calculate hit position
      hitX = px + vx * bestT;
      hitY = py + vy * bestT;
      // A mining charge sticks to the rock and blows later (lifetimeSystem), where the rock then is
      const stick = gs.weapons.stickTicks(proj);
      if (stick > 0) {
        gs.placeAsteroid(hitAsteroid);
        gs.stuckShots.set(proj, { asteroid: hitAsteroid, ox: hitX - Position.x[hitAsteroid], oy: hitY - Position.y[hitAsteroid] });
        Position.x[proj] = hitX; Position.y[proj] = hitY;
        Velocity.x[proj] = 0; Velocity.y[proj] = 0;
        Lifetime.remaining[proj] = stick;
        continue;
      }
      gs.hurtAsteroid(proj, hitAsteroid, ownerId, Projectile.damage[proj], hitX, hitY);
    }
  }

  // Check player deaths
  for (const player of players) {
    if (Health.current[player] <= 0 && !hasComponent(gs.world, Dead, player)) {
      addComponent(gs.world, Dead, player);
      gs.features.onDied(player);

      const systemId = InSystem.systemId[player];
      const pc = gs.lingering.get(player)?.conn ?? gs.pilots.connOf(player);
      if (pc) gs.pilots.onDestroyed(pc, systemId, Position.x[player], Position.y[player], Velocity.x[player], Velocity.y[player], gs.deathCause(player));
      if (pc && activity.on && !gs.pilots.isFrozen(pc)) activity.death(pc, gs.deathCause(player), gs.pilots.connOf(gs.ships.lastHitter(player))?.username);

      gs.broadcastToSystem(systemId, {
        type: 'death',
        entityId: player,
        entityType: EntityType.Player,
      });
      
      // Find client and notify
      for (const conn of gs.clients.values()) {
        if (conn.playerId === player) {
          gs.send(conn.ws, {
            type: 'systemMessage',
            text: 'You have been destroyed! Press R to respawn.',
            color: '#ff4444',
          });
        }
      }
    }
  }
}
