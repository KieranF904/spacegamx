/**
 * Item Definition - Data-driven item configuration
 */

export type ItemCategory = 'weapon' | 'module' | 'consumable' | 'resource' | 'quest' | 'ship';
export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface ItemDefinition {
  id: string;
  name: string;
  category: ItemCategory;
  rarity: ItemRarity;
  tier: number;
  description: string;
  
  // === Stack / Quantity ===
  stackable: boolean;
  maxStack: number;
  
  // === Value ===
  buyPrice: number;
  sellPrice: number;
  
  // === Equipment (if equippable) ===
  equipment?: EquipmentConfig;
  
  // === Consumable (if usable) ===
  consumable?: ConsumableConfig;
  
  // === Resource (if resource) ===
  resource?: ResourceConfig;
  
  // === Visual ===
  iconId: string;
  hue?: number;
}

export interface EquipmentConfig {
  slot: 'weapon' | 'shield' | 'engine' | 'hull' | 'special';
  weaponId?: string;          // Reference to weapon definition
  stats?: StatModifiers;
}

export interface StatModifiers {
  maxHealth?: number;
  healthRegen?: number;
  maxShield?: number;
  shieldRegen?: number;
  speed?: number;
  acceleration?: number;
  turnRate?: number;
  damage?: number;
  cooldownReduction?: number;
  miningSpeed?: number;
  cargoCapacity?: number;
}

export interface ConsumableConfig {
  effect: ConsumableEffect;
  duration?: number;          // Ticks, if temporary
  cooldown: number;           // Ticks between uses
  charges?: number;           // If limited use
}

export interface ConsumableEffect {
  type: 'heal' | 'shield' | 'boost' | 'repair' | 'warp' | 'stealth' | 'buff';
  value: number;
  isPercent?: boolean;
  buffId?: string;            // For buff effects
}

export interface ResourceConfig {
  resourceType: 'ice' | 'metal' | 'crystal' | 'fuel' | 'rare' | 'artifact';
  refinedFrom?: string[];     // If can be refined from other resources
  refineRatio?: number;
}

// === Default item definitions ===
export const DEFAULT_ITEMS: ItemDefinition[] = [
  // === RESOURCES ===
  {
    id: 'ice',
    name: 'Ice',
    category: 'resource',
    rarity: 'common',
    tier: 1,
    description: 'Frozen water from asteroids. Used for fuel and life support.',
    stackable: true,
    maxStack: 9999,
    buyPrice: 5,
    sellPrice: 3,
    resource: { resourceType: 'ice' },
    iconId: 'resource_ice',
    hue: 190,
  },
  {
    id: 'metal',
    name: 'Metal Ore',
    category: 'resource',
    rarity: 'common',
    tier: 1,
    description: 'Raw metal ore. Essential for repairs and crafting.',
    stackable: true,
    maxStack: 9999,
    buyPrice: 10,
    sellPrice: 6,
    resource: { resourceType: 'metal' },
    iconId: 'resource_metal',
    hue: 30,
  },
  {
    id: 'crystal',
    name: 'Energy Crystal',
    category: 'resource',
    rarity: 'uncommon',
    tier: 2,
    description: 'Crystallized energy. Powers advanced systems.',
    stackable: true,
    maxStack: 9999,
    buyPrice: 25,
    sellPrice: 15,
    resource: { resourceType: 'crystal' },
    iconId: 'resource_crystal',
    hue: 280,
  },
  {
    id: 'fuel',
    name: 'Fuel Cell',
    category: 'resource',
    rarity: 'common',
    tier: 1,
    description: 'Refined fuel for ship engines.',
    stackable: true,
    maxStack: 9999,
    buyPrice: 8,
    sellPrice: 5,
    resource: { resourceType: 'fuel' },
    iconId: 'resource_fuel',
    hue: 60,
  },
  {
    id: 'rare_metal',
    name: 'Rare Metal',
    category: 'resource',
    rarity: 'rare',
    tier: 3,
    description: 'Precious metals used in high-tech equipment.',
    stackable: true,
    maxStack: 999,
    buyPrice: 100,
    sellPrice: 60,
    resource: { resourceType: 'rare' },
    iconId: 'resource_rare',
    hue: 45,
  },

  // === CONSUMABLES ===
  {
    id: 'repair_kit',
    name: 'Repair Kit',
    category: 'consumable',
    rarity: 'common',
    tier: 1,
    description: 'Emergency hull repair. Restores 30% HP.',
    stackable: true,
    maxStack: 20,
    buyPrice: 50,
    sellPrice: 25,
    consumable: {
      effect: { type: 'heal', value: 30, isPercent: true },
      cooldown: 300,
    },
    iconId: 'consumable_repair',
    hue: 120,
  },
  {
    id: 'shield_cell',
    name: 'Shield Cell',
    category: 'consumable',
    rarity: 'common',
    tier: 1,
    description: 'Instantly restores 50% shield.',
    stackable: true,
    maxStack: 20,
    buyPrice: 40,
    sellPrice: 20,
    consumable: {
      effect: { type: 'shield', value: 50, isPercent: true },
      cooldown: 240,
    },
    iconId: 'consumable_shield',
    hue: 200,
  },
  {
    id: 'boost_pack',
    name: 'Boost Pack',
    category: 'consumable',
    rarity: 'uncommon',
    tier: 2,
    description: 'Temporary speed boost for 10 seconds.',
    stackable: true,
    maxStack: 10,
    buyPrice: 80,
    sellPrice: 40,
    consumable: {
      effect: { type: 'boost', value: 1.5 },
      duration: 600,
      cooldown: 900,
    },
    iconId: 'consumable_boost',
    hue: 60,
  },
  {
    id: 'warp_charge',
    name: 'Warp Charge',
    category: 'consumable',
    rarity: 'rare',
    tier: 3,
    description: 'Emergency warp to station.',
    stackable: true,
    maxStack: 5,
    buyPrice: 200,
    sellPrice: 100,
    consumable: {
      effect: { type: 'warp', value: 0 },
      cooldown: 1800,
    },
    iconId: 'consumable_warp',
    hue: 270,
  },

  // === MODULES ===
  {
    id: 'shield_booster_1',
    name: 'Shield Booster Mk1',
    category: 'module',
    rarity: 'common',
    tier: 1,
    description: 'Increases maximum shield by 50.',
    stackable: false,
    maxStack: 1,
    buyPrice: 200,
    sellPrice: 100,
    equipment: {
      slot: 'shield',
      stats: { maxShield: 50 },
    },
    iconId: 'module_shield',
    hue: 200,
  },
  {
    id: 'shield_booster_2',
    name: 'Shield Booster Mk2',
    category: 'module',
    rarity: 'uncommon',
    tier: 2,
    description: 'Increases maximum shield by 100.',
    stackable: false,
    maxStack: 1,
    buyPrice: 500,
    sellPrice: 250,
    equipment: {
      slot: 'shield',
      stats: { maxShield: 100, shieldRegen: 0.5 },
    },
    iconId: 'module_shield',
    hue: 210,
  },
  {
    id: 'armor_plate',
    name: 'Armor Plate',
    category: 'module',
    rarity: 'common',
    tier: 1,
    description: 'Increases maximum health by 50.',
    stackable: false,
    maxStack: 1,
    buyPrice: 180,
    sellPrice: 90,
    equipment: {
      slot: 'hull',
      stats: { maxHealth: 50 },
    },
    iconId: 'module_armor',
    hue: 30,
  },
  {
    id: 'engine_booster_1',
    name: 'Engine Booster Mk1',
    category: 'module',
    rarity: 'common',
    tier: 1,
    description: 'Increases speed by 10%.',
    stackable: false,
    maxStack: 1,
    buyPrice: 250,
    sellPrice: 125,
    equipment: {
      slot: 'engine',
      stats: { speed: 0.1, acceleration: 0.1 },
    },
    iconId: 'module_engine',
    hue: 60,
  },
  {
    id: 'mining_laser_boost',
    name: 'Mining Laser Amplifier',
    category: 'module',
    rarity: 'uncommon',
    tier: 2,
    description: 'Increases mining speed by 25%.',
    stackable: false,
    maxStack: 1,
    buyPrice: 400,
    sellPrice: 200,
    equipment: {
      slot: 'special',
      stats: { miningSpeed: 0.25 },
    },
    iconId: 'module_mining',
    hue: 45,
  },
  {
    id: 'cargo_expander',
    name: 'Cargo Expander',
    category: 'module',
    rarity: 'common',
    tier: 1,
    description: 'Increases cargo capacity by 20.',
    stackable: false,
    maxStack: 1,
    buyPrice: 300,
    sellPrice: 150,
    equipment: {
      slot: 'special',
      stats: { cargoCapacity: 20 },
    },
    iconId: 'module_cargo',
    hue: 90,
  },

  // === WEAPON ITEMS (references weapon definitions) ===
  {
    id: 'item_blaster_mk1',
    name: 'Blaster Mk1',
    category: 'weapon',
    rarity: 'common',
    tier: 1,
    description: 'Standard issue plasma blaster.',
    stackable: false,
    maxStack: 1,
    buyPrice: 100,
    sellPrice: 50,
    equipment: {
      slot: 'weapon',
      weaponId: 'blaster_mk1',
    },
    iconId: 'weapon_blaster',
    hue: 120,
  },
  {
    id: 'item_blaster_mk2',
    name: 'Blaster Mk2',
    category: 'weapon',
    rarity: 'uncommon',
    tier: 2,
    description: 'Enhanced plasma blaster.',
    stackable: false,
    maxStack: 1,
    buyPrice: 300,
    sellPrice: 150,
    equipment: {
      slot: 'weapon',
      weaponId: 'blaster_mk2',
    },
    iconId: 'weapon_blaster',
    hue: 210,
  },
  {
    id: 'item_laser_mk1',
    name: 'Laser Mk1',
    category: 'weapon',
    rarity: 'common',
    tier: 1,
    description: 'Continuous laser beam.',
    stackable: false,
    maxStack: 1,
    buyPrice: 150,
    sellPrice: 75,
    equipment: {
      slot: 'weapon',
      weaponId: 'laser_mk1',
    },
    iconId: 'weapon_laser',
    hue: 120,
  },
  {
    id: 'item_scatter_mk1',
    name: 'Scatter Gun Mk1',
    category: 'weapon',
    rarity: 'common',
    tier: 1,
    description: 'Fires a spread of projectiles.',
    stackable: false,
    maxStack: 1,
    buyPrice: 200,
    sellPrice: 100,
    equipment: {
      slot: 'weapon',
      weaponId: 'scatter_mk1',
    },
    iconId: 'weapon_scatter',
    hue: 120,
  },
  {
    id: 'item_missile_mk1',
    name: 'Missile Launcher Mk1',
    category: 'weapon',
    rarity: 'uncommon',
    tier: 1,
    description: 'Homing missiles.',
    stackable: false,
    maxStack: 1,
    buyPrice: 400,
    sellPrice: 200,
    equipment: {
      slot: 'weapon',
      weaponId: 'missile_mk1',
    },
    iconId: 'weapon_missile',
    hue: 0,
  },
  {
    id: 'item_pulse_mk1',
    name: 'Pulse Cannon Mk1',
    category: 'weapon',
    rarity: 'uncommon',
    tier: 1,
    description: 'Charged energy ball with splash.',
    stackable: false,
    maxStack: 1,
    buyPrice: 350,
    sellPrice: 175,
    equipment: {
      slot: 'weapon',
      weaponId: 'pulse_mk1',
    },
    iconId: 'weapon_pulse',
    hue: 180,
  },
  {
    id: 'item_mine_mk1',
    name: 'Mine Layer Mk1',
    category: 'weapon',
    rarity: 'uncommon',
    tier: 1,
    description: 'Proximity mines. Max 3.',
    stackable: false,
    maxStack: 1,
    buyPrice: 500,
    sellPrice: 250,
    equipment: {
      slot: 'weapon',
      weaponId: 'mine_mk1',
    },
    iconId: 'weapon_mine',
    hue: 60,
  },
  {
    id: 'item_mining_mk1',
    name: 'Mining Shot Mk1',
    category: 'weapon',
    rarity: 'common',
    tier: 1,
    description: 'Slow projectile for asteroid mining.',
    stackable: false,
    maxStack: 1,
    buyPrice: 120,
    sellPrice: 60,
    equipment: {
      slot: 'weapon',
      weaponId: 'mining_mk1',
    },
    iconId: 'weapon_mining',
    hue: 45,
  },
];
