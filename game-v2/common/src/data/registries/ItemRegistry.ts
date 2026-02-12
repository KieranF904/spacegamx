/**
 * Item Registry - Manages item definitions
 */

import { BaseRegistry } from '../registries.js';
import { ItemDefinition, ItemCategory, ItemRarity, DEFAULT_ITEMS } from '../definitions/ItemDefinition.js';

export class ItemRegistry extends BaseRegistry<string, ItemDefinition> {
  private static instance: ItemRegistry;

  private constructor() {
    super();
  }

  static getInstance(): ItemRegistry {
    if (!ItemRegistry.instance) {
      ItemRegistry.instance = new ItemRegistry();
      ItemRegistry.instance.loadDefaults();
    }
    return ItemRegistry.instance;
  }

  private loadDefaults(): void {
    this.loadAll(DEFAULT_ITEMS, (def) => def.id);
  }

  protected validate(id: string, definition: ItemDefinition): void {
    if (!id || !definition.name) {
      throw new Error(`Invalid item definition: ${id}`);
    }
    if (definition.maxStack <= 0) {
      throw new Error(`Item ${id} has invalid max stack`);
    }
  }

  // === Helper methods ===

  getByCategory(category: ItemCategory): ItemDefinition[] {
    return Array.from(this.items.values()).filter((i) => i.category === category);
  }

  getByRarity(rarity: ItemRarity): ItemDefinition[] {
    return Array.from(this.items.values()).filter((i) => i.rarity === rarity);
  }

  getByTier(tier: number): ItemDefinition[] {
    return Array.from(this.items.values()).filter((i) => i.tier === tier);
  }

  getWeapons(): ItemDefinition[] {
    return this.getByCategory('weapon');
  }

  getModules(): ItemDefinition[] {
    return this.getByCategory('module');
  }

  getConsumables(): ItemDefinition[] {
    return this.getByCategory('consumable');
  }

  getResources(): ItemDefinition[] {
    return this.getByCategory('resource');
  }

  getEquippable(): ItemDefinition[] {
    return Array.from(this.items.values()).filter((i) => i.equipment !== undefined);
  }

  getUsable(): ItemDefinition[] {
    return Array.from(this.items.values()).filter((i) => i.consumable !== undefined);
  }

  /**
   * Get all items that can be equipped in a specific slot
   */
  getForSlot(slot: string): ItemDefinition[] {
    return Array.from(this.items.values())
      .filter((i) => i.equipment?.slot === slot);
  }

  /**
   * Get items available in shop for a given tier
   */
  getShopItems(tier: number): ItemDefinition[] {
    return Array.from(this.items.values())
      .filter((i) => i.buyPrice > 0 && i.tier <= tier);
  }

  /**
   * Calculate sell value (potentially with modifiers)
   */
  getSellValue(itemId: string, quantity: number = 1): number {
    const item = this.get(itemId);
    if (!item) return 0;
    return item.sellPrice * quantity;
  }

  /**
   * Calculate buy cost (potentially with modifiers)
   */
  getBuyCost(itemId: string, quantity: number = 1): number {
    const item = this.get(itemId);
    if (!item) return Infinity;
    return item.buyPrice * quantity;
  }

  /**
   * Get rarity color for UI
   */
  getRarityColor(rarity: ItemRarity): string {
    switch (rarity) {
      case 'common': return '#ffffff';
      case 'uncommon': return '#00ff00';
      case 'rare': return '#0088ff';
      case 'epic': return '#aa00ff';
      case 'legendary': return '#ff8800';
      default: return '#ffffff';
    }
  }
}

// Export singleton
export const itemRegistry = ItemRegistry.getInstance();
