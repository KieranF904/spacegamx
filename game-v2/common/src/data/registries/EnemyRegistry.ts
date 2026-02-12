/**
 * Enemy Registry - Manages enemy definitions
 */

import { BaseRegistry } from '../registries.js';
import { EnemyDefinition, DEFAULT_ENEMIES } from '../definitions/EnemyDefinition.js';

export class EnemyRegistry extends BaseRegistry<string, EnemyDefinition> {
  private static instance: EnemyRegistry;

  private constructor() {
    super();
  }

  static getInstance(): EnemyRegistry {
    if (!EnemyRegistry.instance) {
      EnemyRegistry.instance = new EnemyRegistry();
      EnemyRegistry.instance.loadDefaults();
    }
    return EnemyRegistry.instance;
  }

  private loadDefaults(): void {
    this.loadAll(DEFAULT_ENEMIES, (def) => def.id);
  }

  protected validate(id: string, definition: EnemyDefinition): void {
    if (!id || !definition.name) {
      throw new Error(`Invalid enemy definition: ${id}`);
    }
    if (definition.health <= 0) {
      throw new Error(`Enemy ${id} has invalid health`);
    }
    if (definition.radius <= 0) {
      throw new Error(`Enemy ${id} has invalid radius`);
    }
  }

  // === Helper methods ===

  getByType(type: string): EnemyDefinition[] {
    return Array.from(this.items.values()).filter((e) => e.type === type);
  }

  getByTier(tier: number): EnemyDefinition[] {
    return Array.from(this.items.values()).filter((e) => e.tier === tier);
  }

  getSpawners(): EnemyDefinition[] {
    return Array.from(this.items.values()).filter((e) => e.spawner !== undefined);
  }

  getBosses(): EnemyDefinition[] {
    return Array.from(this.items.values()).filter((e) => e.type === 'boss');
  }

  getForTierRange(minTier: number, maxTier: number): EnemyDefinition[] {
    return Array.from(this.items.values())
      .filter((e) => e.tier >= minTier && e.tier <= maxTier);
  }

  getSpawnWeights(tier: number): Map<string, number> {
    const weights = new Map<string, number>();
    const enemies = this.getByTier(tier);
    
    for (const enemy of enemies) {
      // Basic weight calculation - can be customized
      const baseWeight = enemy.type === 'basic' ? 10 : 
                         enemy.type === 'swarm' ? 15 :
                         enemy.type === 'turret' ? 5 :
                         enemy.type === 'boss' ? 1 : 3;
      weights.set(enemy.id, baseWeight);
    }
    
    return weights;
  }
}

// Export singleton
export const enemyRegistry = EnemyRegistry.getInstance();
