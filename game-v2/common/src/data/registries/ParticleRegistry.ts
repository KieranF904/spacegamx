/**
 * Particle Registry - Manages particle definitions (primarily for client)
 */

import { BaseRegistry } from '../registries.js';
import { ParticleDefinition, DEFAULT_PARTICLES } from '../definitions/ParticleDefinition.js';

export class ParticleRegistry extends BaseRegistry<string, ParticleDefinition> {
  private static instance: ParticleRegistry;

  private constructor() {
    super();
  }

  static getInstance(): ParticleRegistry {
    if (!ParticleRegistry.instance) {
      ParticleRegistry.instance = new ParticleRegistry();
      ParticleRegistry.instance.loadDefaults();
    }
    return ParticleRegistry.instance;
  }

  private loadDefaults(): void {
    this.loadAll(DEFAULT_PARTICLES, (def) => def.id);
  }

  protected validate(id: string, definition: ParticleDefinition): void {
    if (!id || !definition.name) {
      throw new Error(`Invalid particle definition: ${id}`);
    }
    if (definition.emission.maxParticles <= 0) {
      throw new Error(`Particle ${id} has invalid maxParticles`);
    }
  }

  // === Helper methods ===

  getByEmissionType(type: 'burst' | 'continuous' | 'trail'): ParticleDefinition[] {
    return Array.from(this.items.values()).filter((p) => p.emission.type === type);
  }

  getBurstEffects(): ParticleDefinition[] {
    return this.getByEmissionType('burst');
  }

  getContinuousEffects(): ParticleDefinition[] {
    return this.getByEmissionType('continuous');
  }

  getTrailEffects(): ParticleDefinition[] {
    return this.getByEmissionType('trail');
  }
}

// Export singleton
export const particleRegistry = ParticleRegistry.getInstance();
