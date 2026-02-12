/**
 * Trail Registry - Manages trail definitions (primarily for client)
 */

import { BaseRegistry } from '../registries.js';
import { TrailDefinition, DEFAULT_TRAILS } from '../definitions/TrailDefinition.js';

export class TrailRegistry extends BaseRegistry<string, TrailDefinition> {
  private static instance: TrailRegistry;

  private constructor() {
    super();
  }

  static getInstance(): TrailRegistry {
    if (!TrailRegistry.instance) {
      TrailRegistry.instance = new TrailRegistry();
      TrailRegistry.instance.loadDefaults();
    }
    return TrailRegistry.instance;
  }

  private loadDefaults(): void {
    this.loadAll(DEFAULT_TRAILS, (def) => def.id);
  }

  protected validate(id: string, definition: TrailDefinition): void {
    if (!id || !definition.name) {
      throw new Error(`Invalid trail definition: ${id}`);
    }
    if (definition.shape.maxLength <= 0) {
      throw new Error(`Trail ${id} has invalid maxLength`);
    }
  }

  // === Helper methods ===

  getByShapeType(type: 'line' | 'ribbon' | 'dotted' | 'tapered'): TrailDefinition[] {
    return Array.from(this.items.values()).filter((t) => t.shape.type === type);
  }

  /**
   * Get trail for weapon type
   */
  getForWeaponType(weaponType: string): TrailDefinition | undefined {
    // Map weapon types to trail IDs
    const mapping: Record<string, string> = {
      'cannon': 'bullet',
      'laser': 'laser',
      'scatter': 'scatter',
      'missile': 'missile',
      'pulse': 'pulse',
      'mine': 'bullet',
      'mining': 'mining',
      'warp': 'warp',
    };
    
    const trailId = mapping[weaponType];
    return trailId ? this.get(trailId) : undefined;
  }
}

// Export singleton
export const trailRegistry = TrailRegistry.getInstance();
