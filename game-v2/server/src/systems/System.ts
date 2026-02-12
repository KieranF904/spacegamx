/**
 * System Interface - Base interface for all server systems
 * Systems are modular, prioritized update handlers
 */

import { IWorld } from 'bitecs';

export interface ISystem {
  /** System name for debugging */
  name: string;
  
  /** Update priority (lower = earlier). Use SystemPriority constants. */
  priority: number;
  
  /** Whether this system is enabled */
  enabled: boolean;
  
  /** Initialize the system */
  init?(world: IWorld): void;
  
  /** Called every tick */
  update(world: IWorld, tick: number, deltaMs: number): void;
  
  /** Cleanup on shutdown */
  destroy?(): void;
}

/**
 * System priority constants
 * Systems are executed in priority order (lowest first)
 */
export const SystemPriority = {
  // Input processing (client sends, server receives)
  INPUT: 100,
  
  // AI decision making
  AI: 200,
  
  // Movement, physics
  MOVEMENT: 300,
  PHYSICS: 350,
  
  // Collision detection
  COLLISION: 400,
  
  // Combat systems
  WEAPON: 500,
  PROJECTILE: 510,
  DAMAGE: 520,
  
  // Spawning, despawning
  SPAWN: 600,
  LIFETIME: 610,
  DEATH: 620,
  
  // Item, loot, inventory
  LOOT: 700,
  INVENTORY: 710,
  
  // World updates (mining, stations, etc)
  WORLD: 800,
  
  // Network sync (last, after all state changes)
  NETWORK: 900,
  CLEANUP: 950,
} as const;

/**
 * Base system class with common functionality
 */
export abstract class BaseSystem implements ISystem {
  abstract name: string;
  abstract priority: number;
  enabled = true;

  init?(world: IWorld): void;
  abstract update(world: IWorld, tick: number, deltaMs: number): void;
  destroy?(): void;
}

/**
 * System manager - orchestrates system execution
 */
export class SystemManager {
  private systems: ISystem[] = [];
  private systemsByName = new Map<string, ISystem>();

  /**
   * Register a system
   */
  register(system: ISystem): void {
    if (this.systemsByName.has(system.name)) {
      console.warn(`[SystemManager] System ${system.name} already registered, replacing`);
      this.unregister(system.name);
    }

    this.systems.push(system);
    this.systemsByName.set(system.name, system);
    
    // Keep sorted by priority
    this.systems.sort((a, b) => a.priority - b.priority);
    
    console.log(`[SystemManager] Registered: ${system.name} (priority: ${system.priority})`);
  }

  /**
   * Unregister a system by name
   */
  unregister(name: string): boolean {
    const index = this.systems.findIndex((s) => s.name === name);
    if (index >= 0) {
      const system = this.systems[index];
      system.destroy?.();
      this.systems.splice(index, 1);
      this.systemsByName.delete(name);
      return true;
    }
    return false;
  }

  /**
   * Get system by name
   */
  get<T extends ISystem>(name: string): T | undefined {
    return this.systemsByName.get(name) as T | undefined;
  }

  /**
   * Initialize all systems
   */
  initAll(world: IWorld): void {
    for (const system of this.systems) {
      try {
        system.init?.(world);
      } catch (err) {
        console.error(`[SystemManager] Failed to init ${system.name}:`, err);
      }
    }
  }

  /**
   * Update all enabled systems
   */
  updateAll(world: IWorld, tick: number, deltaMs: number): void {
    for (const system of this.systems) {
      if (!system.enabled) continue;
      
      try {
        system.update(world, tick, deltaMs);
      } catch (err) {
        console.error(`[SystemManager] Error in ${system.name}:`, err);
      }
    }
  }

  /**
   * Destroy all systems
   */
  destroyAll(): void {
    for (const system of this.systems) {
      try {
        system.destroy?.();
      } catch (err) {
        console.error(`[SystemManager] Failed to destroy ${system.name}:`, err);
      }
    }
    this.systems = [];
    this.systemsByName.clear();
  }

  /**
   * Enable/disable a system
   */
  setEnabled(name: string, enabled: boolean): void {
    const system = this.systemsByName.get(name);
    if (system) {
      system.enabled = enabled;
    }
  }

  /**
   * Get all registered systems
   */
  getAll(): ISystem[] {
    return [...this.systems];
  }

  /**
   * Debug: print system order
   */
  printOrder(): void {
    console.log('[SystemManager] Execution order:');
    for (const system of this.systems) {
      console.log(`  ${system.priority}: ${system.name} (${system.enabled ? 'enabled' : 'disabled'})`);
    }
  }
}
