/**
 * Weapon Registry - Manages weapon definitions
 */

import { BaseRegistry } from '../registries.js';
import { WeaponDefinition, DEFAULT_WEAPONS } from '../definitions/WeaponDefinition.js';

export class WeaponRegistry extends BaseRegistry<string, WeaponDefinition> {
  private static instance: WeaponRegistry;

  private constructor() {
    super();
  }

  static getInstance(): WeaponRegistry {
    if (!WeaponRegistry.instance) {
      WeaponRegistry.instance = new WeaponRegistry();
      WeaponRegistry.instance.loadDefaults();
    }
    return WeaponRegistry.instance;
  }

  private loadDefaults(): void {
    this.loadAll(DEFAULT_WEAPONS, (def) => def.id);
  }

  protected validate(id: string, definition: WeaponDefinition): void {
    if (!id || !definition.name) {
      throw new Error(`Invalid weapon definition: ${id}`);
    }
    if (definition.damage < 0) {
      throw new Error(`Weapon ${id} has negative damage`);
    }
    if (definition.cooldown <= 0) {
      throw new Error(`Weapon ${id} has invalid cooldown`);
    }
  }

  // === Helper methods ===

  getByType(type: string): WeaponDefinition[] {
    return Array.from(this.items.values()).filter((w) => w.type === type);
  }

  getByTier(tier: number): WeaponDefinition[] {
    return Array.from(this.items.values()).filter((w) => w.tier === tier);
  }

  getByRarity(rarity: string): WeaponDefinition[] {
    return Array.from(this.items.values()).filter((w) => w.rarity === rarity);
  }

  getUpgradePath(weaponId: string): WeaponDefinition[] {
    const weapon = this.get(weaponId);
    if (!weapon) return [];
    
    return Array.from(this.items.values())
      .filter((w) => w.type === weapon.type && w.tier > weapon.tier)
      .sort((a, b) => a.tier - b.tier);
  }
}

// Export singleton
export const weaponRegistry = WeaponRegistry.getInstance();
