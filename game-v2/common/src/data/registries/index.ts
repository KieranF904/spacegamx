/**
 * Registry Index - Export all registries
 */

// Base registry
export { BaseRegistry, type IRegistry } from '../registries.js';

// Specific registries
export { WeaponRegistry, weaponRegistry } from './WeaponRegistry.js';
export { EnemyRegistry, enemyRegistry } from './EnemyRegistry.js';
export { AsteroidRegistry, asteroidRegistry } from './AsteroidRegistry.js';
export { ItemRegistry, itemRegistry } from './ItemRegistry.js';
export { ParticleRegistry, particleRegistry } from './ParticleRegistry.js';
export { TrailRegistry, trailRegistry } from './TrailRegistry.js';

// Import for initialization
import { weaponRegistry } from './WeaponRegistry.js';
import { enemyRegistry } from './EnemyRegistry.js';
import { asteroidRegistry } from './AsteroidRegistry.js';
import { itemRegistry } from './ItemRegistry.js';
import { particleRegistry } from './ParticleRegistry.js';
import { trailRegistry } from './TrailRegistry.js';

/**
 * Initialize all registries (call on startup)
 * This ensures all singletons are created and defaults are loaded
 */
export function initializeRegistries(): {
  weapons: number;
  enemies: number;
  asteroids: number;
  items: number;
  particles: number;
  trails: number;
} {
  // Accessing the singletons triggers initialization via getInstance()
  return {
    weapons: weaponRegistry.getIds().length,
    enemies: enemyRegistry.getIds().length,
    asteroids: asteroidRegistry.getIds().length,
    items: itemRegistry.getIds().length,
    particles: particleRegistry.getIds().length,
    trails: trailRegistry.getIds().length,
  };
}
