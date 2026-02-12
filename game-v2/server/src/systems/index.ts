/**
 * Systems Index - Export all server systems
 */

// Base system infrastructure
export { ISystem, BaseSystem, SystemPriority, SystemManager } from './System.js';

// Individual systems
export { MovementSystem } from './MovementSystem.js';
export { CollisionSystem } from './CollisionSystem.js';
export { WeaponSystem } from './WeaponSystem.js';
export { AISystem } from './AISystem.js';
export { SpawnSystem } from './SpawnSystem.js';
export { LifetimeSystem } from './LifetimeSystem.js';

// Imports for factory function
import { MovementSystem } from './MovementSystem.js';
import { CollisionSystem } from './CollisionSystem.js';
import { WeaponSystem } from './WeaponSystem.js';
import { AISystem } from './AISystem.js';
import { SpawnSystem } from './SpawnSystem.js';
import { LifetimeSystem } from './LifetimeSystem.js';
import { SystemManager } from './System.js';

/**
 * Create and configure all default systems with proper ordering
 */
export function createSystemManager(): SystemManager {
  const manager = new SystemManager();
  
  // Add systems - they will be sorted by priority
  manager.register(new AISystem());           // AI decisions first
  manager.register(new MovementSystem());     // Then movement
  manager.register(new WeaponSystem());       // Then weapons
  manager.register(new CollisionSystem());    // Then collisions
  manager.register(new SpawnSystem());        // Then spawning
  manager.register(new LifetimeSystem());     // Then cleanup
  
  return manager;
}
