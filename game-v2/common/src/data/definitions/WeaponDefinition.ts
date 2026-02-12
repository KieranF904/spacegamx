/**
 * Weapon Definition - Complete data-driven weapon configuration
 */

import { WeaponTypeString } from '../schemas';

export interface WeaponDefinition {
  id: string;
  name: string;
  type: WeaponTypeString;
  tier: number;
  rarity: string;
  description: string;

  // === Core Stats ===
  damage: number;
  cooldown: number;           // Base cooldown in ticks
  
  // === Projectile Config ===
  projectile?: ProjectileConfig;
  
  // === Special Behaviors ===
  homing?: HomingConfig;
  splash?: SplashConfig;
  charge?: ChargeConfig;
  scatter?: ScatterConfig;
  mine?: MineConfig;
  laser?: LaserConfig;
  mining?: MiningConfig;
  warp?: WarpConfig;

  // === Visual References (resolved client-side) ===
  visualType: string;
  trailType?: string;
  particleType?: string;
  hue?: number;
}

export interface ProjectileConfig {
  speed: number;
  lifetime: number;           // Ticks
  radius: number;
  inheritVelocity: number;    // 0-1
  friction?: number;
  gravity?: number;
}

export interface HomingConfig {
  turnRate: number;           // Radians per tick
  acquisitionRange: number;
  acquisitionCone: number;    // Radians
  fuel: number;               // Ticks of active homing
  accel: number;
  damping: number;
}

export interface SplashConfig {
  radius: number;
  falloff: number;            // Damage falloff exponent
  friendlyFire: boolean;
}

export interface ChargeConfig {
  maxTicks: number;
  damageMultiplier: number;
  sizeMultiplier: number;
  minChargeToFire?: number;
}

export interface ScatterConfig {
  projectileCount: number;
  spreadAngle: number;        // Radians
  speedVariance: number;      // 0-1
}

export interface MineConfig {
  armTime: number;            // Ticks until armed
  maxCount: number;           // Max active mines per player
  detectRadius: number;
  lifetime: number;
}

export interface LaserConfig {
  range: number;
  damageMax: number;
  damageMin: number;
  tickCooldown: number;       // Ticks between damage
  width: number;
}

export interface MiningConfig {
  dotDuration: number;        // Ticks
  dotInterval: number;        // Ticks between DoT
  dotFactor: number;          // Damage multiplier per tick
  stickToAsteroid: boolean;
}

export interface WarpConfig {
  activationDelay: number;    // Ticks until warp field activates
  launchSpeed: number;        // Speed to launch entities
  fieldRadius: number;        // Radius of the warp field
  lifetime: number;           // Ticks the field stays active
}

// === Default weapon definitions ===
export const DEFAULT_WEAPONS: WeaponDefinition[] = [
  // CANNON
  {
    id: 'blaster_mk1',
    name: 'Blaster Mk1',
    type: 'cannon',
    tier: 1,
    rarity: 'common',
    description: 'Standard issue plasma blaster.',
    damage: 14,
    cooldown: 10,
    projectile: { speed: 64, lifetime: 180, radius: 5, inheritVelocity: 0.3 },
    visualType: 'bullet',
    trailType: 'bullet',
    hue: 120,
  },
  {
    id: 'blaster_mk2',
    name: 'Blaster Mk2',
    type: 'cannon',
    tier: 2,
    rarity: 'uncommon',
    description: 'Enhanced plasma blaster.',
    damage: 18,
    cooldown: 8,
    projectile: { speed: 72, lifetime: 180, radius: 5, inheritVelocity: 0.3 },
    visualType: 'bullet',
    trailType: 'bullet',
    hue: 210,
  },
  {
    id: 'blaster_mk3',
    name: 'Blaster Mk3',
    type: 'cannon',
    tier: 3,
    rarity: 'rare',
    description: 'Military-grade blaster.',
    damage: 24,
    cooldown: 6,
    projectile: { speed: 80, lifetime: 180, radius: 6, inheritVelocity: 0.3 },
    visualType: 'bullet',
    trailType: 'bullet',
    hue: 280,
  },

  // LASER
  {
    id: 'laser_mk1',
    name: 'Laser Mk1',
    type: 'laser',
    tier: 1,
    rarity: 'common',
    description: 'Continuous laser beam.',
    damage: 600,
    cooldown: 6,
    laser: { range: 3000, damageMax: 600, damageMin: 100, tickCooldown: 6, width: 3 },
    visualType: 'laser',
    hue: 120,
  },
  {
    id: 'laser_mk2',
    name: 'Laser Mk2',
    type: 'laser',
    tier: 2,
    rarity: 'uncommon',
    description: 'High-powered laser.',
    damage: 800,
    cooldown: 5,
    laser: { range: 3600, damageMax: 800, damageMin: 150, tickCooldown: 5, width: 4 },
    visualType: 'laser',
    hue: 210,
  },
  {
    id: 'laser_mk3',
    name: 'Laser Mk3',
    type: 'laser',
    tier: 3,
    rarity: 'rare',
    description: 'Military laser system.',
    damage: 1000,
    cooldown: 4,
    laser: { range: 4200, damageMax: 1000, damageMin: 200, tickCooldown: 4, width: 5 },
    visualType: 'laser',
    hue: 280,
  },

  // SCATTER
  {
    id: 'scatter_mk1',
    name: 'Scatter Gun Mk1',
    type: 'scatter',
    tier: 1,
    rarity: 'common',
    description: 'Fires a spread of projectiles.',
    damage: 8,
    cooldown: 22,
    projectile: { speed: 55, lifetime: 60, radius: 4, inheritVelocity: 0.3, friction: 0.94 },
    scatter: { projectileCount: 5, spreadAngle: 0.5, speedVariance: 0.15 },
    visualType: 'scatter',
    trailType: 'scatter',
    hue: 120,
  },
  {
    id: 'scatter_mk2',
    name: 'Scatter Gun Mk2',
    type: 'scatter',
    tier: 2,
    rarity: 'uncommon',
    description: 'Improved scatter gun.',
    damage: 10,
    cooldown: 22,
    projectile: { speed: 60, lifetime: 60, radius: 4, inheritVelocity: 0.3, friction: 0.94 },
    scatter: { projectileCount: 7, spreadAngle: 0.45, speedVariance: 0.15 },
    visualType: 'scatter',
    trailType: 'scatter',
    hue: 210,
  },
  {
    id: 'scatter_mk3',
    name: 'Scatter Gun Mk3',
    type: 'scatter',
    tier: 3,
    rarity: 'rare',
    description: 'Elite scatter gun.',
    damage: 12,
    cooldown: 22,
    projectile: { speed: 65, lifetime: 60, radius: 4, inheritVelocity: 0.3, friction: 0.94 },
    scatter: { projectileCount: 9, spreadAngle: 0.4, speedVariance: 0.15 },
    visualType: 'scatter',
    trailType: 'scatter',
    hue: 280,
  },

  // MISSILE
  {
    id: 'missile_mk1',
    name: 'Missile Launcher Mk1',
    type: 'missile',
    tier: 1,
    rarity: 'common',
    description: 'Homing missiles.',
    damage: 35,
    cooldown: 45,
    projectile: { speed: 18, lifetime: 420, radius: 8, inheritVelocity: 0 },
    homing: { turnRate: 0.07, acquisitionRange: 1200, acquisitionCone: 0.52, fuel: 360, accel: 0.032, damping: 0.999 },
    charge: { maxTicks: 60, damageMultiplier: 1, sizeMultiplier: 1, minChargeToFire: 20 },
    visualType: 'missile',
    trailType: 'missile',
    hue: 120,
  },
  {
    id: 'missile_mk2',
    name: 'Missile Launcher Mk2',
    type: 'missile',
    tier: 2,
    rarity: 'uncommon',
    description: 'Advanced homing missiles.',
    damage: 45,
    cooldown: 40,
    projectile: { speed: 20, lifetime: 420, radius: 8, inheritVelocity: 0 },
    homing: { turnRate: 0.08, acquisitionRange: 1400, acquisitionCone: 0.6, fuel: 360, accel: 0.036, damping: 0.999 },
    charge: { maxTicks: 60, damageMultiplier: 1, sizeMultiplier: 1, minChargeToFire: 20 },
    visualType: 'missile',
    trailType: 'missile',
    hue: 210,
  },
  {
    id: 'missile_mk3',
    name: 'Missile Launcher Mk3',
    type: 'missile',
    tier: 3,
    rarity: 'rare',
    description: 'Military missile system. Can charge up to 8.',
    damage: 55,
    cooldown: 36,
    projectile: { speed: 22, lifetime: 420, radius: 8, inheritVelocity: 0 },
    homing: { turnRate: 0.09, acquisitionRange: 1600, acquisitionCone: 0.7, fuel: 360, accel: 0.04, damping: 0.999 },
    charge: { maxTicks: 160, damageMultiplier: 1, sizeMultiplier: 1, minChargeToFire: 20 },
    visualType: 'missile',
    trailType: 'missile',
    hue: 280,
  },

  // PULSE
  {
    id: 'pulse_mk1',
    name: 'Pulse Cannon Mk1',
    type: 'pulse',
    tier: 1,
    rarity: 'common',
    description: 'Charged energy ball with splash.',
    damage: 40,
    cooldown: 28,
    projectile: { speed: 42, lifetime: 180, radius: 15, inheritVelocity: 0.2 },
    charge: { maxTicks: 180, damageMultiplier: 3, sizeMultiplier: 2 },
    splash: { radius: 220, falloff: 1.5, friendlyFire: false },
    visualType: 'pulse',
    trailType: 'pulse',
    hue: 120,
  },
  {
    id: 'pulse_mk2',
    name: 'Pulse Cannon Mk2',
    type: 'pulse',
    tier: 2,
    rarity: 'uncommon',
    description: 'Enhanced pulse with larger blast.',
    damage: 50,
    cooldown: 24,
    projectile: { speed: 46, lifetime: 180, radius: 18, inheritVelocity: 0.2 },
    charge: { maxTicks: 180, damageMultiplier: 3, sizeMultiplier: 2.5 },
    splash: { radius: 260, falloff: 1.5, friendlyFire: false },
    visualType: 'pulse',
    trailType: 'pulse',
    hue: 210,
  },
  {
    id: 'pulse_mk3',
    name: 'Pulse Cannon Mk3',
    type: 'pulse',
    tier: 3,
    rarity: 'rare',
    description: 'Devastating pulse weapon.',
    damage: 65,
    cooldown: 20,
    projectile: { speed: 50, lifetime: 180, radius: 22, inheritVelocity: 0.2 },
    charge: { maxTicks: 180, damageMultiplier: 3.5, sizeMultiplier: 3 },
    splash: { radius: 300, falloff: 1.5, friendlyFire: false },
    visualType: 'pulse',
    trailType: 'pulse',
    hue: 280,
  },

  // MINE
  {
    id: 'mine_mk1',
    name: 'Mine Layer Mk1',
    type: 'mine',
    tier: 1,
    rarity: 'common',
    description: 'Proximity mines. Max 3.',
    damage: 150,
    cooldown: 120,
    mine: { armTime: 60, maxCount: 3, detectRadius: 200, lifetime: 1800 },
    splash: { radius: 400, falloff: 2.0, friendlyFire: true },
    visualType: 'mine',
    hue: 120,
  },
  {
    id: 'mine_mk2',
    name: 'Mine Layer Mk2',
    type: 'mine',
    tier: 2,
    rarity: 'uncommon',
    description: 'Advanced proximity mines.',
    damage: 200,
    cooldown: 100,
    mine: { armTime: 60, maxCount: 3, detectRadius: 240, lifetime: 1800 },
    splash: { radius: 450, falloff: 2.0, friendlyFire: true },
    visualType: 'mine',
    hue: 210,
  },
  {
    id: 'mine_mk3',
    name: 'Mine Layer Mk3',
    type: 'mine',
    tier: 3,
    rarity: 'rare',
    description: 'Military-grade mines.',
    damage: 300,
    cooldown: 80,
    mine: { armTime: 60, maxCount: 3, detectRadius: 280, lifetime: 1800 },
    splash: { radius: 500, falloff: 2.0, friendlyFire: true },
    visualType: 'mine',
    hue: 280,
  },

  // MINING
  {
    id: 'mining_mk1',
    name: 'Mining Shot Mk1',
    type: 'mining',
    tier: 1,
    rarity: 'common',
    description: 'Slow projectile for asteroid mining.',
    damage: 100,
    cooldown: 280,
    projectile: { speed: 22, lifetime: 300, radius: 10, inheritVelocity: 0.3 },
    mining: { dotDuration: 1200, dotInterval: 30, dotFactor: 0.5, stickToAsteroid: true },
    visualType: 'mining',
    trailType: 'mining',
    hue: 60,
  },
  {
    id: 'mining_mk2',
    name: 'Mining Shot Mk2',
    type: 'mining',
    tier: 2,
    rarity: 'uncommon',
    description: 'Improved mining projectile.',
    damage: 140,
    cooldown: 240,
    projectile: { speed: 24, lifetime: 300, radius: 10, inheritVelocity: 0.3 },
    mining: { dotDuration: 1200, dotInterval: 30, dotFactor: 0.5, stickToAsteroid: true },
    visualType: 'mining',
    trailType: 'mining',
    hue: 60,
  },
  {
    id: 'mining_mk3',
    name: 'Mining Shot Mk3',
    type: 'mining',
    tier: 3,
    rarity: 'rare',
    description: 'Industrial mining system.',
    damage: 180,
    cooldown: 200,
    projectile: { speed: 26, lifetime: 300, radius: 10, inheritVelocity: 0.3 },
    mining: { dotDuration: 1200, dotInterval: 30, dotFactor: 0.5, stickToAsteroid: true },
    visualType: 'mining',
    trailType: 'mining',
    hue: 60,
  },

  // WARP (Legendary)
  {
    id: 'warp_mk1',
    name: 'Warp Gun',
    type: 'warp',
    tier: 1,
    rarity: 'legendary',
    description: 'Fires a warp field that launches enemies at high speed.',
    damage: 0,
    cooldown: 180,
    projectile: { speed: 35, lifetime: 120, radius: 20, inheritVelocity: 0.3 },
    warp: { activationDelay: 60, launchSpeed: 800, fieldRadius: 150, lifetime: 1800 },
    visualType: 'warp',
    hue: 0,
  },
];
