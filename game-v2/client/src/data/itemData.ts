/**
 * Item Data for client-side rendering and UI
 * This should match the server's items.json
 */

export interface ItemInfo {
  id: string;
  name: string;
  type: string;
  slot?: string;
  tier: number;
  rarity: string;
  description: string;
  weaponType?: string;
  damage?: number;
  fireRate?: number;
  speed?: number;
  range?: number;
  spread?: number;
  projectileCount?: number;
  homing?: number;
  maxCharge?: number;
  splashRadius?: number;
  maxMines?: number;
  miningSpeed?: number;
  thrustMultiplier?: number;
  fuelCapacity?: number;
  regenRate?: number;
  hpBonus?: number;
  shieldBonus?: number;
  radarRange?: number;
  accelBonus?: number;
  turnBonus?: number;
  stackSize?: number;
  value?: number;
}

// All items from items.json
export const ITEM_DATA: Map<string, ItemInfo> = new Map([
  // ========== WEAPONS - CANNON/BLASTER ==========
  ['blaster_mk1', {
    id: 'blaster_mk1', name: 'Blaster Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'cannon', damage: 1.0, speed: 1.0, fireRate: 1.0, spread: 0, projectileCount: 1,
    rarity: 'common', description: 'Standard issue plasma blaster. Reliable but basic.'
  }],
  ['blaster_mk2', {
    id: 'blaster_mk2', name: 'Blaster Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'cannon', damage: 1.3, speed: 1.1, fireRate: 1.2, spread: 0, projectileCount: 1,
    rarity: 'uncommon', description: 'Enhanced plasma blaster with improved damage output.'
  }],
  ['blaster_mk3', {
    id: 'blaster_mk3', name: 'Blaster Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'cannon', damage: 1.6, speed: 1.2, fireRate: 1.4, spread: 0, projectileCount: 1,
    rarity: 'rare', description: 'Military-grade plasma blaster. Devastating firepower.'
  }],

  // ========== WEAPONS - LASER ==========
  ['laser_mk1', {
    id: 'laser_mk1', name: 'Laser Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'laser', damage: 1.0, range: 1.0, fireRate: 1.0,
    rarity: 'common', description: 'Focused light beam. Instant hit, damage falls off with distance.'
  }],
  ['laser_mk2', {
    id: 'laser_mk2', name: 'Laser Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'laser', damage: 1.4, range: 1.2, fireRate: 1.2,
    rarity: 'uncommon', description: 'High-powered laser with extended range.'
  }],
  ['laser_mk3', {
    id: 'laser_mk3', name: 'Laser Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'laser', damage: 1.8, range: 1.5, fireRate: 1.4,
    rarity: 'rare', description: 'Cutting-edge laser technology. Melts through armor.'
  }],

  // ========== WEAPONS - SCATTER ==========
  ['scatter_mk1', {
    id: 'scatter_mk1', name: 'Scatter Gun Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'scatter', damage: 0.8, speed: 0.8, fireRate: 0.7, spread: 0.5, projectileCount: 5,
    rarity: 'common', description: 'Fires a spread of projectiles. Deadly at close range.'
  }],
  ['scatter_mk2', {
    id: 'scatter_mk2', name: 'Scatter Gun Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'scatter', damage: 1.0, speed: 0.9, fireRate: 0.8, spread: 0.45, projectileCount: 7,
    rarity: 'uncommon', description: 'Improved scatter gun with tighter spread.'
  }],
  ['scatter_mk3', {
    id: 'scatter_mk3', name: 'Scatter Gun Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'scatter', damage: 1.2, speed: 1.0, fireRate: 0.9, spread: 0.4, projectileCount: 9,
    rarity: 'rare', description: 'Elite scatter gun. Devastating burst damage.'
  }],

  // ========== WEAPONS - MISSILE ==========
  ['missile_mk1', {
    id: 'missile_mk1', name: 'Missile Launcher Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'missile', damage: 2.5, speed: 1.0, fireRate: 0.5, maxCharge: 3, homing: 1.0,
    rarity: 'common', description: 'Launches homing missiles. Hold to charge multiple missiles.'
  }],
  ['missile_mk2', {
    id: 'missile_mk2', name: 'Missile Launcher Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'missile', damage: 3.0, speed: 1.1, fireRate: 0.6, maxCharge: 3, homing: 1.2,
    rarity: 'uncommon', description: 'Advanced missiles with improved tracking.'
  }],
  ['missile_mk3', {
    id: 'missile_mk3', name: 'Missile Launcher Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'missile', damage: 3.5, speed: 1.2, fireRate: 0.7, maxCharge: 8, homing: 1.4,
    rarity: 'rare', description: 'Military-grade launcher. Can charge up to 8 missiles.'
  }],

  // ========== WEAPONS - PULSE ==========
  ['pulse_mk1', {
    id: 'pulse_mk1', name: 'Pulse Cannon Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'pulse', damage: 2.0, speed: 1.0, fireRate: 0.4, splashRadius: 1.0,
    rarity: 'common', description: 'Charged energy ball with splash damage. Hold to charge.'
  }],
  ['pulse_mk2', {
    id: 'pulse_mk2', name: 'Pulse Cannon Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'pulse', damage: 2.5, speed: 1.1, fireRate: 0.5, splashRadius: 1.2,
    rarity: 'uncommon', description: 'Enhanced pulse with larger blast radius.'
  }],
  ['pulse_mk3', {
    id: 'pulse_mk3', name: 'Pulse Cannon Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'pulse', damage: 3.0, speed: 1.2, fireRate: 0.6, splashRadius: 1.5,
    rarity: 'rare', description: 'Devastating pulse weapon. Maximum charge is catastrophic.'
  }],

  // ========== WEAPONS - MINE ==========
  ['mine_mk1', {
    id: 'mine_mk1', name: 'Mine Layer Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'mine', damage: 3.0, fireRate: 0.5, maxMines: 3, splashRadius: 1.0,
    rarity: 'common', description: 'Deploys proximity mines. Max 3 active at a time.'
  }],
  ['mine_mk2', {
    id: 'mine_mk2', name: 'Mine Layer Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'mine', damage: 3.5, fireRate: 0.6, maxMines: 3, splashRadius: 1.2,
    rarity: 'uncommon', description: 'Advanced mines with larger detection radius.'
  }],
  ['mine_mk3', {
    id: 'mine_mk3', name: 'Mine Layer Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'mine', damage: 4.0, fireRate: 0.7, maxMines: 3, splashRadius: 1.5,
    rarity: 'rare', description: 'Military mines. Massive explosion radius.'
  }],

  // ========== WEAPONS - MINING ==========
  ['mining_laser_mk1', {
    id: 'mining_laser_mk1', name: 'Mining Laser Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'mining', damage: 0.5, range: 1.0, miningSpeed: 1.0,
    rarity: 'common', description: 'Extracts ore from asteroids. Low combat effectiveness.'
  }],
  ['mining_laser_mk2', {
    id: 'mining_laser_mk2', name: 'Mining Laser Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'mining', damage: 0.7, range: 1.2, miningSpeed: 1.5,
    rarity: 'uncommon', description: 'Enhanced mining laser. Faster ore extraction.'
  }],
  ['mining_laser_mk3', {
    id: 'mining_laser_mk3', name: 'Mining Laser Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'mining', damage: 1.0, range: 1.5, miningSpeed: 2.0,
    rarity: 'rare', description: 'Industrial-grade mining laser. Also effective in combat.'
  }],

  // ========== WEAPONS - WARP ==========
  ['warp_mk1', {
    id: 'warp_mk1', name: 'Warp Gun Mk1', type: 'weapon', slot: 'leftWeapon', tier: 1,
    weaponType: 'warp', damage: 1.0, speed: 1.0,
    rarity: 'common', description: 'Fires a warp beacon. Teleport to it after a delay.'
  }],
  ['warp_mk2', {
    id: 'warp_mk2', name: 'Warp Gun Mk2', type: 'weapon', slot: 'leftWeapon', tier: 2,
    weaponType: 'warp', damage: 1.3, speed: 1.2,
    rarity: 'uncommon', description: 'Improved warp beacon with faster activation.'
  }],
  ['warp_mk3', {
    id: 'warp_mk3', name: 'Warp Gun Mk3', type: 'weapon', slot: 'leftWeapon', tier: 3,
    weaponType: 'warp', damage: 1.6, speed: 1.4,
    rarity: 'rare', description: 'Advanced warp technology. Nearly instant teleportation.'
  }],

  // ========== EQUIPMENT - BOOSTERS ==========
  ['booster_mk1', {
    id: 'booster_mk1', name: 'Booster Mk1', type: 'booster', slot: 'booster', tier: 1,
    thrustMultiplier: 1.0, fuelCapacity: 1.0, regenRate: 1.0,
    rarity: 'common', description: 'Standard booster module.'
  }],
  ['booster_mk2', {
    id: 'booster_mk2', name: 'Booster Mk2', type: 'booster', slot: 'booster', tier: 2,
    thrustMultiplier: 1.2, fuelCapacity: 1.3, regenRate: 1.2,
    rarity: 'uncommon', description: 'Enhanced booster with improved fuel efficiency.'
  }],
  ['booster_mk3', {
    id: 'booster_mk3', name: 'Booster Mk3', type: 'booster', slot: 'booster', tier: 3,
    thrustMultiplier: 1.5, fuelCapacity: 1.5, regenRate: 1.4,
    rarity: 'rare', description: 'Military-grade boosters. Maximum thrust.'
  }],

  // ========== EQUIPMENT - COCKPITS ==========
  ['cockpit_mk1', {
    id: 'cockpit_mk1', name: 'Cockpit Mk1', type: 'cockpit', slot: 'cockpit', tier: 1,
    hpBonus: 0, shieldBonus: 0, radarRange: 1.0, accelBonus: 0, turnBonus: 0,
    rarity: 'common', description: 'Standard cockpit module.'
  }],
  ['cockpit_mk2', {
    id: 'cockpit_mk2', name: 'Cockpit Mk2', type: 'cockpit', slot: 'cockpit', tier: 2,
    hpBonus: 20, shieldBonus: 10, radarRange: 1.2, accelBonus: 0.05, turnBonus: 0.02,
    rarity: 'uncommon', description: 'Reinforced cockpit with extended radar.'
  }],
  ['cockpit_mk3', {
    id: 'cockpit_mk3', name: 'Cockpit Mk3', type: 'cockpit', slot: 'cockpit', tier: 3,
    hpBonus: 50, shieldBonus: 25, radarRange: 1.5, accelBonus: 0.1, turnBonus: 0.04,
    rarity: 'rare', description: 'Elite cockpit. Maximum survivability.'
  }],

  // ========== RESOURCES ==========
  ['ore_iron', {
    id: 'ore_iron', name: 'Iron Ore', type: 'resource', tier: 1, stackSize: 100, value: 10,
    rarity: 'common', description: 'Basic iron ore. Used in basic crafting.'
  }],
  ['ore_crystal', {
    id: 'ore_crystal', name: 'Crystal Shard', type: 'resource', tier: 2, stackSize: 50, value: 25,
    rarity: 'uncommon', description: 'Crystalline ore. Used in advanced components.'
  }],
  ['ore_plasma', {
    id: 'ore_plasma', name: 'Plasma Core', type: 'resource', tier: 3, stackSize: 25, value: 100,
    rarity: 'rare', description: 'Volatile plasma container. Extremely valuable.'
  }],
  ['ice_sprite_drop', {
    id: 'ice_sprite_drop', name: 'Frozen Essence', type: 'resource', tier: 1, stackSize: 100, value: 15,
    rarity: 'common', description: 'Essence dropped by Ice Sprites. Used in cold-resistant gear.'
  }],
]);

export const RARITY_COLORS: Record<string, string> = {
  common: '#888888',
  uncommon: '#44cc44',
  rare: '#4488ff',
  epic: '#aa44ff',
  legendary: '#ff8844',
  quest: '#ffff44',
};

export const TIER_COLORS: Record<number, string> = {
  1: '#44ff44',
  2: '#4488ff',
  3: '#aa44ff',
};

export function getItemIcon(type: string, weaponType?: string): string {
  if (type === 'weapon') {
    switch (weaponType) {
      case 'cannon': return '💥';
      case 'laser': return '⚡';
      case 'scatter': return '🌀';
      case 'missile': return '🚀';
      case 'pulse': return '💠';
      case 'mine': return '💣';
      case 'mining': return '⛏️';
      case 'warp': return '🌀';
      default: return '🔫';
    }
  }
  if (type === 'booster') return '🔥';
  if (type === 'cockpit') return '🛸';
  if (type === 'resource') return '💎';
  return '📦';
}
