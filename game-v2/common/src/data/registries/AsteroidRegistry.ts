/**
 * Asteroid Registry - Manages asteroid definitions and field configurations
 */

import { BaseRegistry } from '../registries.js';
import { 
  AsteroidDefinition, 
  AsteroidFieldConfig,
  DEFAULT_ASTEROIDS, 
  DEFAULT_ASTEROID_FIELDS 
} from '../definitions/AsteroidDefinition.js';

export class AsteroidRegistry extends BaseRegistry<string, AsteroidDefinition> {
  private static instance: AsteroidRegistry;
  private fields = new Map<string, AsteroidFieldConfig>();

  private constructor() {
    super();
  }

  static getInstance(): AsteroidRegistry {
    if (!AsteroidRegistry.instance) {
      AsteroidRegistry.instance = new AsteroidRegistry();
      AsteroidRegistry.instance.loadDefaults();
    }
    return AsteroidRegistry.instance;
  }

  private loadDefaults(): void {
    this.loadAll(DEFAULT_ASTEROIDS, (def) => def.id);
    
    // Load asteroid fields
    for (const field of DEFAULT_ASTEROID_FIELDS) {
      this.fields.set(field.id, field);
    }
  }

  protected validate(id: string, definition: AsteroidDefinition): void {
    if (!id || !definition.name) {
      throw new Error(`Invalid asteroid definition: ${id}`);
    }
    if (definition.size.min <= 0 || definition.size.max < definition.size.min) {
      throw new Error(`Asteroid ${id} has invalid size range`);
    }
  }

  // === Field methods ===

  registerField(field: AsteroidFieldConfig): void {
    this.fields.set(field.id, field);
  }

  getField(id: string): AsteroidFieldConfig | undefined {
    return this.fields.get(id);
  }

  getAllFields(): AsteroidFieldConfig[] {
    return Array.from(this.fields.values());
  }

  // === Helper methods ===

  getByTier(tier: number): AsteroidDefinition[] {
    return Array.from(this.items.values()).filter((a) => a.tier === tier);
  }

  getByResource(resourceType: string): AsteroidDefinition[] {
    return Array.from(this.items.values()).filter((a) => 
      a.resources.primary.type === resourceType ||
      a.resources.secondary?.type === resourceType
    );
  }

  /**
   * Calculate health for a specific asteroid instance
   */
  calculateHealth(definitionId: string, size: number): number {
    const def = this.get(definitionId);
    if (!def) return 100;

    const baseHealth = def.healthPerUnit * size;
    
    switch (def.size.healthScale) {
      case 'linear':
        return baseHealth;
      case 'quadratic':
        return baseHealth * (size / def.size.min);
      case 'cubic':
        return baseHealth * Math.pow(size / def.size.min, 2);
      default:
        return baseHealth;
    }
  }

  /**
   * Calculate resource yield for a specific asteroid instance
   */
  calculateResources(definitionId: string, size: number): Map<string, number> {
    const def = this.get(definitionId);
    const resources = new Map<string, number>();
    if (!def) return resources;

    // Primary resource
    const primary = def.resources.primary;
    const primaryAmount = Math.floor(
      size * (primary.minPerSize + Math.random() * (primary.maxPerSize - primary.minPerSize))
    );
    resources.set(primary.type, primaryAmount);

    // Secondary resource
    if (def.resources.secondary) {
      const secondary = def.resources.secondary;
      const secondaryAmount = Math.floor(
        size * (secondary.minPerSize + Math.random() * (secondary.maxPerSize - secondary.minPerSize))
      );
      resources.set(secondary.type, secondaryAmount);
    }

    // Bonus resource (chance-based)
    if (def.resources.bonus && Math.random() < def.resources.bonus.chance) {
      const bonus = def.resources.bonus;
      const bonusAmount = bonus.min + Math.floor(Math.random() * (bonus.max - bonus.min + 1));
      resources.set(bonus.type, bonusAmount);
    }

    return resources;
  }

  /**
   * Get spawn weights for asteroid field generation
   */
  getFieldSpawnWeights(fieldId: string): Map<string, number> {
    const field = this.getField(fieldId);
    const weights = new Map<string, number>();
    
    if (!field) return weights;

    for (const entry of field.asteroidTypes) {
      weights.set(entry.id, entry.weight);
    }

    return weights;
  }

  /**
   * Pick random asteroid type for a field based on weights
   */
  pickRandomForField(fieldId: string): string | null {
    const weights = this.getFieldSpawnWeights(fieldId);
    if (weights.size === 0) return null;

    const totalWeight = Array.from(weights.values()).reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;

    for (const [id, weight] of weights) {
      random -= weight;
      if (random <= 0) return id;
    }

    // Fallback to first
    return weights.keys().next().value ?? null;
  }

  /**
   * Generate random size for asteroid
   */
  generateSize(definitionId: string): number {
    const def = this.get(definitionId);
    if (!def) return 50;

    return def.size.min + Math.random() * (def.size.max - def.size.min);
  }
}

// Export singleton
export const asteroidRegistry = AsteroidRegistry.getInstance();
