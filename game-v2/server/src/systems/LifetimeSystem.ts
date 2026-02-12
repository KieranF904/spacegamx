/**
 * Lifetime System - Handles entity lifetime and cleanup
 */

import { IWorld, defineQuery, addComponent, removeEntity, hasComponent } from 'bitecs';
import { BaseSystem, SystemPriority } from './System.js';
import {
  Lifetime,
  Dead,
  Position,
  Velocity,
  DroppedItem,
  Enemy,
  Asteroid,
  Health,
  enemyRegistry,
} from '@space-game/common';

// Define queries
const lifetimeQuery = defineQuery([Lifetime]);
const deadQuery = defineQuery([Dead]);
const droppedItemQuery = defineQuery([DroppedItem, Position, Velocity, Lifetime]);

export interface DeathEvent {
  entityId: number;
  entityType: 'enemy' | 'asteroid' | 'projectile' | 'item' | 'other';
  x: number;
  y: number;
  killedBy?: number;
}

export class LifetimeSystem extends BaseSystem {
  name = 'LifetimeSystem';
  priority = SystemPriority.LIFETIME;

  private pendingDeaths: DeathEvent[] = [];

  update(world: IWorld, tick: number, deltaMs: number): void {
    this.pendingDeaths = [];

    // Process lifetime countdown
    this.processLifetimes(world);

    // Process dead entities
    this.processDead(world);

    // Apply friction to dropped items
    this.processDroppedItems(world);
  }

  private processLifetimes(world: IWorld): void {
    const entities = lifetimeQuery(world);

    for (const eid of entities) {
      Lifetime.remaining[eid]--;

      if (Lifetime.remaining[eid] <= 0) {
        // Mark for death
        if (!hasComponent(world, Dead, eid)) {
          addComponent(world, Dead, eid);
        }
      }
    }
  }

  private processDead(world: IWorld): void {
    const dead = deadQuery(world);

    for (const eid of dead) {
      // Determine entity type
      let entityType: DeathEvent['entityType'] = 'other';
      
      if (hasComponent(world, Enemy, eid)) {
        entityType = 'enemy';
        this.handleEnemyDeath(world, eid);
      } else if (hasComponent(world, Asteroid, eid)) {
        entityType = 'asteroid';
        this.handleAsteroidDeath(world, eid);
      } else if (hasComponent(world, DroppedItem, eid)) {
        entityType = 'item';
      } else {
        entityType = 'projectile';
      }

      // Record death event
      this.pendingDeaths.push({
        entityId: eid,
        entityType,
        x: Position.x[eid] ?? 0,
        y: Position.y[eid] ?? 0,
      });

      // Remove entity
      removeEntity(world, eid);
    }
  }

  private handleEnemyDeath(world: IWorld, eid: number): void {
    const typeId = Enemy.typeId[eid];
    const defId = enemyRegistry.getStringId(typeId);
    if (!defId) return;

    const def = enemyRegistry.get(defId);
    if (!def) return;

    // Spawn drops would go here
    // This would create DroppedItem entities based on def.drops
  }

  private handleAsteroidDeath(world: IWorld, eid: number): void {
    // Spawn resources based on asteroid type and size
    // Get asteroid info
    const x = Position.x[eid];
    const y = Position.y[eid];
    const size = Asteroid.size[eid] ?? 1;
    
    // Emit asteroid death event for GameServer to handle loot spawning
    // GameServer has access to GameData for item lookups
    if (this.onAsteroidDeath) {
      this.onAsteroidDeath(eid, x, y, size);
    }
  }

  // Callback for asteroid death - set by GameServer
  public onAsteroidDeath: ((eid: number, x: number, y: number, size: number) => void) | null = null;

  private processDroppedItems(world: IWorld): void {
    const items = droppedItemQuery(world);

    for (const eid of items) {
      // Apply friction to slow down items
      Velocity.x[eid] *= 0.98;
      Velocity.y[eid] *= 0.98;

      // Apply velocity to position
      Position.x[eid] += Velocity.x[eid];
      Position.y[eid] += Velocity.y[eid];
    }
  }

  // === Public API ===

  getPendingDeaths(): DeathEvent[] {
    return this.pendingDeaths;
  }

  clearDeaths(): void {
    this.pendingDeaths = [];
  }
}
