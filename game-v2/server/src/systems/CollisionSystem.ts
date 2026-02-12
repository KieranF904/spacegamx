/**
 * Collision System - Handles collision detection and response
 * Uses SpatialGrid for efficient broad-phase detection
 */

import { IWorld, defineQuery, hasComponent, addComponent, removeEntity } from 'bitecs';
import { BaseSystem, SystemPriority } from './System.js';
import { SpatialGrid, CollisionPair } from '../world/SpatialGrid.js';
import {
  Position,
  Velocity,
  Radius,
  Health,
  Shield,
  Player,
  Enemy,
  Asteroid,
  Projectile,
  Bullet,
  Missile,
  Pulse,
  Mine,
  Station,
  DroppedItem,
  Dead,
  OwnedBy,
  WeaponType,
} from '@space-game/common';

export type CollisionCategory = 'player' | 'enemy' | 'asteroid' | 'projectile' | 'station' | 'item';

export interface CollisionEvent {
  entityA: number;
  entityB: number;
  categoryA: CollisionCategory;
  categoryB: CollisionCategory;
  x: number;
  y: number;
  overlapX: number;
  overlapY: number;
}

type CollisionHandler = (world: IWorld, event: CollisionEvent) => void;

// Define queries at module level (bitecs pattern)
const playerQuery = defineQuery([Position, Radius, Player]);
const enemyQuery = defineQuery([Position, Radius, Enemy]);
const asteroidQuery = defineQuery([Position, Radius, Asteroid]);
const bulletQuery = defineQuery([Position, Radius, Bullet]);
const missileQuery = defineQuery([Position, Radius, Missile]);
const pulseQuery = defineQuery([Position, Radius, Pulse]);
const mineQuery = defineQuery([Position, Mine]);
const itemQuery = defineQuery([Position, DroppedItem]);
const stationQuery = defineQuery([Position, Station]);

/**
 * Collision System
 * Manages collision detection, categorization, and event dispatch
 */
export class CollisionSystem extends BaseSystem {
  name = 'CollisionSystem';
  priority = SystemPriority.COLLISION;

  private grid: SpatialGrid;
  private handlers = new Map<string, CollisionHandler>();
  private currentTick = 0;

  // Collision matrix - which categories collide with which
  private collisionMatrix = new Map<string, boolean>();

  constructor(cellSize: number = 500) {
    super();
    this.grid = new SpatialGrid(cellSize);
    this.setupDefaultCollisionMatrix();
    this.setupDefaultHandlers();
  }

  private setupDefaultCollisionMatrix(): void {
    // Define which categories collide
    this.setCollision('player', 'enemy', true);
    this.setCollision('player', 'asteroid', true);
    this.setCollision('player', 'projectile', true);
    this.setCollision('player', 'station', true);
    this.setCollision('player', 'item', true);
    
    this.setCollision('enemy', 'asteroid', true);
    this.setCollision('enemy', 'projectile', true);
    
    this.setCollision('asteroid', 'projectile', true);
    
    this.setCollision('projectile', 'station', false); // Stations are safe zones
    
    // Enemies don't collide with each other for now
    this.setCollision('enemy', 'enemy', false);
    
    // Projectiles don't collide with each other
    this.setCollision('projectile', 'projectile', false);
  }

  private setupDefaultHandlers(): void {
    // Projectile hitting enemy
    this.registerHandler('projectile', 'enemy', this.handleProjectileHitEnemy.bind(this));
    
    // Projectile hitting player
    this.registerHandler('projectile', 'player', this.handleProjectileHitPlayer.bind(this));
    
    // Projectile hitting asteroid
    this.registerHandler('projectile', 'asteroid', this.handleProjectileHitAsteroid.bind(this));
    
    // Player touching item
    this.registerHandler('player', 'item', this.handlePlayerPickupItem.bind(this));
    
    // Player/enemy touching asteroid (pushback)
    this.registerHandler('player', 'asteroid', this.handleEntityAsteroidCollision.bind(this));
    this.registerHandler('enemy', 'asteroid', this.handleEntityAsteroidCollision.bind(this));
    
    // Player touching enemy (contact damage)
    this.registerHandler('player', 'enemy', this.handlePlayerEnemyCollision.bind(this));
  }

  setCollision(catA: CollisionCategory, catB: CollisionCategory, collides: boolean): void {
    const key = this.getMatrixKey(catA, catB);
    this.collisionMatrix.set(key, collides);
  }

  private getMatrixKey(catA: CollisionCategory, catB: CollisionCategory): string {
    return catA < catB ? `${catA}:${catB}` : `${catB}:${catA}`;
  }

  shouldCollide(catA: CollisionCategory, catB: CollisionCategory): boolean {
    const key = this.getMatrixKey(catA, catB);
    return this.collisionMatrix.get(key) ?? false;
  }

  registerHandler(catA: CollisionCategory, catB: CollisionCategory, handler: CollisionHandler): void {
    const key = this.getMatrixKey(catA, catB);
    this.handlers.set(key, handler);
  }

  private getCategory(world: IWorld, entity: number): CollisionCategory | null {
    if (hasComponent(world, Player, entity)) return 'player';
    if (hasComponent(world, Enemy, entity)) return 'enemy';
    if (hasComponent(world, Asteroid, entity)) return 'asteroid';
    if (hasComponent(world, Projectile, entity)) return 'projectile';
    if (hasComponent(world, Mine, entity)) return 'projectile'; // Mines are like projectiles
    if (hasComponent(world, Station, entity)) return 'station';
    if (hasComponent(world, DroppedItem, entity)) return 'item';
    return null;
  }

  init(world: IWorld): void {
    console.log('[CollisionSystem] Initialized');
  }

  update(world: IWorld, tick: number, deltaMs: number): void {
    this.currentTick = tick;
    
    // 1. Update spatial grid with all collidable entities
    this.updateGrid(world);

    // 2. Get collision pairs
    const pairs = this.grid.getCollisionPairs();

    // 3. Process collisions
    for (const pair of pairs) {
      this.processCollision(world, pair);
    }
  }

  private updateGrid(world: IWorld): void {
    this.grid.clear();

    // Players
    const players = playerQuery(world);
    for (const eid of players) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
      });
    }

    // Enemies
    const enemies = enemyQuery(world);
    for (const eid of enemies) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
      });
    }

    // Asteroids
    const asteroids = asteroidQuery(world);
    for (const eid of asteroids) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
      });
    }

    // Projectiles (bullets, missiles, pulse)
    const bullets = bulletQuery(world);
    for (const eid of bullets) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
      });
    }

    const missiles = missileQuery(world);
    for (const eid of missiles) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
      });
    }

    const pulses = pulseQuery(world);
    for (const eid of pulses) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Radius.value[eid],
      });
    }

    // Mines
    const mines = mineQuery(world);
    for (const eid of mines) {
      // Use detection radius for armed mines
      const radius = Mine.armed[eid] ? 200 : 20;
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius,
      });
    }

    // Dropped items
    const items = itemQuery(world);
    for (const eid of items) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: 30, // Pickup radius
      });
    }

    // Stations
    const stations = stationQuery(world);
    for (const eid of stations) {
      this.grid.insert({
        id: eid,
        x: Position.x[eid],
        y: Position.y[eid],
        radius: Station.dockingRadius[eid],
      });
    }
  }

  private processCollision(world: IWorld, pair: CollisionPair): void {
    const catA = this.getCategory(world, pair.entityA);
    const catB = this.getCategory(world, pair.entityB);
    if (!catA || !catB) return;

    // Check collision matrix
    if (!this.shouldCollide(catA, catB)) return;

    // Skip if either entity is already dead
    if (hasComponent(world, Dead, pair.entityA) || hasComponent(world, Dead, pair.entityB)) {
      return;
    }

    // Check projectile ownership - don't hit your own projectiles
    if (catA === 'projectile' || catB === 'projectile') {
      const projEid = catA === 'projectile' ? pair.entityA : pair.entityB;
      const otherEid = catA === 'projectile' ? pair.entityB : pair.entityA;
      
      if (hasComponent(world, OwnedBy, projEid)) {
        const ownerId = OwnedBy.ownerId[projEid];
        if (ownerId === otherEid) return; // Don't hit self
        
        // If it's a player projectile and hitting an enemy, or vice versa - allow
        // If it's a player projectile hitting another player - check friendly fire settings
        // For now, allow player projectiles to hit enemies and vice versa
      }
    }

    const event: CollisionEvent = {
      entityA: pair.entityA,
      entityB: pair.entityB,
      categoryA: catA,
      categoryB: catB,
      x: (Position.x[pair.entityA] + Position.x[pair.entityB]) / 2,
      y: (Position.y[pair.entityA] + Position.y[pair.entityB]) / 2,
      overlapX: pair.overlapX,
      overlapY: pair.overlapY,
    };

    // Find and call handler
    const key = this.getMatrixKey(catA, catB);
    const handler = this.handlers.get(key);
    if (handler) {
      handler(world, event);
    }
  }

  // === Collision Handlers ===

  private handleProjectileHitEnemy(world: IWorld, event: CollisionEvent): void {
    const projEid = event.categoryA === 'projectile' ? event.entityA : event.entityB;
    const enemyEid = event.categoryA === 'enemy' ? event.entityA : event.entityB;

    // Apply damage
    if (hasComponent(world, Projectile, projEid) && hasComponent(world, Health, enemyEid)) {
      const damage = Projectile.damage[projEid];
      const weaponType = Projectile.weaponType[projEid];
      
      // Check for splash damage (pulse weapons)
      if (weaponType === WeaponType.Pulse && hasComponent(world, Pulse, projEid)) {
        this.applySplashDamage(world, Position.x[projEid], Position.y[projEid], damage, Pulse.splashRadius[projEid], Projectile.ownerId[projEid]);
      } else {
        // Direct damage only
        Health.current[enemyEid] -= damage;
        if (Health.current[enemyEid] <= 0) {
          addComponent(world, Dead, enemyEid);
        }
      }

      // Destroy projectile (unless it's a piercing type)
      addComponent(world, Dead, projEid);
    }
  }

  private handleProjectileHitPlayer(world: IWorld, event: CollisionEvent): void {
    const projEid = event.categoryA === 'projectile' ? event.entityA : event.entityB;
    const playerEid = event.categoryA === 'player' ? event.entityA : event.entityB;

    // Check ownership - players can't hit themselves
    if (hasComponent(world, OwnedBy, projEid)) {
      if (OwnedBy.ownerId[projEid] === playerEid) return;
    }

    // Check if projectile is from a player (friendly fire check)
    if (hasComponent(world, Projectile, projEid)) {
      const ownerId = Projectile.ownerId[projEid];
      // If owner is a player, skip (no friendly fire for now)
      if (hasComponent(world, Player, ownerId)) return;
    }

    // Apply damage with shield absorption
    if (hasComponent(world, Projectile, projEid) && hasComponent(world, Health, playerEid)) {
      let damage = Projectile.damage[projEid];
      
      // Shield absorbs damage first
      if (hasComponent(world, Shield, playerEid) && Shield.current[playerEid] > 0) {
        const shieldDamage = Math.min(Shield.current[playerEid], damage);
        Shield.current[playerEid] -= shieldDamage;
        damage -= shieldDamage;
        // Mark shield as recently damaged for regen delay
        Shield.lastDamageTick[playerEid] = this.currentTick;
      }
      
      // Remaining damage goes to health
      if (damage > 0) {
        Health.current[playerEid] -= damage;
        Health.lastDamageTick[playerEid] = this.currentTick;
      }

      // Check for death
      if (Health.current[playerEid] <= 0) {
        // Don't mark dead immediately - handle respawn logic elsewhere
        Health.current[playerEid] = 0;
      }

      // Destroy projectile
      addComponent(world, Dead, projEid);
    }
  }

  private handleProjectileHitAsteroid(world: IWorld, event: CollisionEvent): void {
    const projEid = event.categoryA === 'projectile' ? event.entityA : event.entityB;
    const asteroidEid = event.categoryA === 'asteroid' ? event.entityA : event.entityB;

    // Apply damage to asteroid
    if (hasComponent(world, Projectile, projEid) && hasComponent(world, Asteroid, asteroidEid)) {
      const damage = Projectile.damage[projEid];
      const weaponType = Projectile.weaponType[projEid];
      
      // Check for splash damage (pulse weapons)
      if (weaponType === WeaponType.Pulse && hasComponent(world, Pulse, projEid)) {
        this.applySplashDamage(world, Position.x[projEid], Position.y[projEid], damage, Pulse.splashRadius[projEid], Projectile.ownerId[projEid]);
      } else {
        // Direct damage only
        Asteroid.hp[asteroidEid] -= damage;
        if (Asteroid.hp[asteroidEid] <= 0) {
          addComponent(world, Dead, asteroidEid);
        }
      }

      // Destroy projectile
      addComponent(world, Dead, projEid);
    }
  }

  private handlePlayerPickupItem(world: IWorld, event: CollisionEvent): void {
    // Items are picked up via tractor beam (pickup message), not collision
    // This prevents accidental pickups when inventory is full
    // The collision just indicates an item is near enough for potential pickup
  }

  private handleEntityAsteroidCollision(world: IWorld, event: CollisionEvent): void {
    const asteroidEid = event.categoryA === 'asteroid' ? event.entityA : event.entityB;
    const entityEid = event.categoryA === 'asteroid' ? event.entityB : event.entityA;

    // Apply pushback
    if (hasComponent(world, Velocity, entityEid)) {
      const pushStrength = 0.5;
      Velocity.x[entityEid] -= event.overlapX * pushStrength;
      Velocity.y[entityEid] -= event.overlapY * pushStrength;
      
      // Slight separation
      Position.x[entityEid] -= event.overlapX * 0.5;
      Position.y[entityEid] -= event.overlapY * 0.5;
    }
  }

  private handlePlayerEnemyCollision(world: IWorld, event: CollisionEvent): void {
    const playerEid = event.categoryA === 'player' ? event.entityA : event.entityB;
    const enemyEid = event.categoryA === 'enemy' ? event.entityA : event.entityB;

    // Apply contact damage to player (with shield absorption)
    if (hasComponent(world, Health, playerEid)) {
      let contactDamage = 5;
      
      // Shield absorbs damage first
      if (hasComponent(world, Shield, playerEid) && Shield.current[playerEid] > 0) {
        const shieldDamage = Math.min(Shield.current[playerEid], contactDamage);
        Shield.current[playerEid] -= shieldDamage;
        contactDamage -= shieldDamage;
        Shield.lastDamageTick[playerEid] = this.currentTick;
      }
      
      // Remaining damage goes to health
      if (contactDamage > 0) {
        Health.current[playerEid] -= contactDamage;
        Health.lastDamageTick[playerEid] = this.currentTick;
      }
    }

    // Push both apart
    if (hasComponent(world, Velocity, playerEid)) {
      Velocity.x[playerEid] -= event.overlapX;
      Velocity.y[playerEid] -= event.overlapY;
    }
    if (hasComponent(world, Velocity, enemyEid)) {
      Velocity.x[enemyEid] += event.overlapX;
      Velocity.y[enemyEid] += event.overlapY;
    }
  }

  /**
   * Apply splash damage to all entities in radius
   * Uses distance-based falloff
   */
  private applySplashDamage(
    world: IWorld,
    x: number,
    y: number,
    baseDamage: number,
    radius: number,
    ownerId: number
  ): void {
    // Query all enemies and asteroids in splash radius
    const nearbyEntities = this.grid.queryRange(x, y, radius);
    
    for (const eid of nearbyEntities) {
      // Skip the owner
      if (eid === ownerId) continue;
      
      // Calculate distance for falloff
      const dx = Position.x[eid] - x;
      const dy = Position.y[eid] - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      // Distance-based falloff (full damage at center, 0 at edge)
      const falloff = Math.max(0, 1 - dist / radius);
      const damage = baseDamage * falloff;
      
      if (damage <= 0) continue;
      
      // Apply damage to enemies
      if (hasComponent(world, Enemy, eid) && hasComponent(world, Health, eid)) {
        Health.current[eid] -= damage;
        if (Health.current[eid] <= 0) {
          addComponent(world, Dead, eid);
        }
      }
      
      // Apply damage to asteroids  
      if (hasComponent(world, Asteroid, eid)) {
        Asteroid.hp[eid] -= damage;
        if (Asteroid.hp[eid] <= 0) {
          addComponent(world, Dead, eid);
        }
      }
      
      // Apply damage to players (if not owner, for future PvP)
      // Currently skipped - no friendly fire
    }
  }

  // === Query helpers ===

  queryNearby(x: number, y: number, radius: number): number[] {
    return this.grid.queryRange(x, y, radius);
  }

  queryAtPoint(x: number, y: number): number[] {
    return this.grid.queryPoint(x, y);
  }

  getStats(): { entities: number; cells: number; maxCellSize: number } {
    return this.grid.getStats();
  }
}
