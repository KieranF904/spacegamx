/**
 * Enemy Definition - Complete data-driven enemy configuration
 */

export interface EnemyDefinition {
  id: string;
  name: string;
  tier: number;
  type: 'basic' | 'turret' | 'boss' | 'swarm' | 'station';

  // === Core Stats ===
  health: number;
  maxHealth: number;
  radius: number;
  mass: number;

  // === Movement ===
  movement: EnemyMovementConfig;

  // === Combat ===
  weapon?: EnemyWeaponConfig;
  aggro: AggroConfig;
  
  // === Loot ===
  drops: DropConfig;

  // === Special Behaviors ===
  spawner?: SpawnerConfig;
  shield?: ShieldConfig;
  phases?: PhaseConfig[];

  // === Visuals (resolved client-side) ===
  visualType: string;
  hue?: number;
  scale?: number;
}

export interface EnemyMovementConfig {
  type: 'chase' | 'orbit' | 'patrol' | 'stationary' | 'flee' | 'swarm';
  speed: number;
  turnRate: number;
  accel: number;
  friction: number;
  
  // For orbit behavior
  orbitDistance?: number;
  orbitSpeed?: number;
  
  // For patrol behavior
  patrolRadius?: number;
  patrolSpeed?: number;
  
  // For swarm behavior
  separationDistance?: number;
  cohesionStrength?: number;
}

export interface EnemyWeaponConfig {
  type: string;               // Weapon definition ID
  cooldown: number;
  damage: number;
  projectileSpeed: number;
  projectileLifetime: number;
  burstCount?: number;
  burstDelay?: number;
  aimLead?: boolean;          // Lead target prediction
}

export interface AggroConfig {
  range: number;
  deAggroRange: number;       // Distance to lose aggro
  aggroOnDamage: boolean;     // Aggro on any damage
  shareAggro: boolean;        // Share aggro with nearby enemies
  shareRange?: number;
}

export interface DropConfig {
  xp: number;
  credits: { min: number; max: number };
  items: ItemDropConfig[];
  guaranteedResources?: ResourceDropConfig[];
}

export interface ItemDropConfig {
  itemId: string;
  chance: number;             // 0-1
  quantityMin?: number;
  quantityMax?: number;
}

export interface ResourceDropConfig {
  type: 'ice' | 'metal' | 'crystal' | 'fuel';
  min: number;
  max: number;
}

export interface SpawnerConfig {
  spawnId: string;            // What to spawn
  maxSpawns: number;
  spawnInterval: number;      // Ticks
  spawnOnDeath?: number;      // Spawn X on death
  spawnRadius: number;
}

export interface ShieldConfig {
  health: number;
  regenRate: number;          // Per tick
  regenDelay: number;         // Ticks after damage
  absorbPercent: number;      // 0-1
}

export interface PhaseConfig {
  healthThreshold: number;    // 0-1, trigger when below
  newBehavior?: string;       // Switch movement type
  newWeapon?: string;         // Switch weapon
  speedMultiplier?: number;
  damageMultiplier?: number;
  spawnOnTrigger?: string;
}

// === Default enemy definitions ===
export const DEFAULT_ENEMIES: EnemyDefinition[] = [
  // ICE SPRITES (basic swarm enemies)
  {
    id: 'ice_sprite',
    name: 'Ice Sprite',
    tier: 1,
    type: 'basic',
    health: 50,
    maxHealth: 50,
    radius: 16,
    mass: 0.5,
    movement: {
      type: 'chase',
      speed: 4,
      turnRate: 0.08,
      accel: 0.15,
      friction: 0.98,
    },
    aggro: {
      range: 600,
      deAggroRange: 900,
      aggroOnDamage: true,
      shareAggro: true,
      shareRange: 400,
    },
    drops: {
      xp: 10,
      credits: { min: 5, max: 15 },
      items: [],
      guaranteedResources: [{ type: 'ice', min: 1, max: 3 }],
    },
    visualType: 'ice_sprite',
    hue: 180,
  },

  // ICE SPRITE SPAWNER (spawns ice sprites)
  {
    id: 'ice_sprite_spawner',
    name: 'Ice Crystal',
    tier: 1,
    type: 'turret',
    health: 400,
    maxHealth: 400,
    radius: 40,
    mass: 100,
    movement: {
      type: 'stationary',
      speed: 0,
      turnRate: 0,
      accel: 0,
      friction: 1,
    },
    aggro: {
      range: 800,
      deAggroRange: 1200,
      aggroOnDamage: true,
      shareAggro: false,
    },
    spawner: {
      spawnId: 'ice_sprite',
      maxSpawns: 6,
      spawnInterval: 180,
      spawnOnDeath: 3,
      spawnRadius: 100,
    },
    drops: {
      xp: 50,
      credits: { min: 30, max: 60 },
      items: [{ itemId: 'ice_crystal', chance: 0.3 }],
      guaranteedResources: [{ type: 'ice', min: 10, max: 20 }],
    },
    visualType: 'ice_spawner',
    hue: 200,
    scale: 1.5,
  },

  // PIRATE FIGHTER
  {
    id: 'pirate_fighter',
    name: 'Pirate Fighter',
    tier: 2,
    type: 'basic',
    health: 120,
    maxHealth: 120,
    radius: 24,
    mass: 1.2,
    movement: {
      type: 'orbit',
      speed: 6,
      turnRate: 0.1,
      accel: 0.2,
      friction: 0.97,
      orbitDistance: 400,
      orbitSpeed: 0.02,
    },
    weapon: {
      type: 'enemy_blaster',
      cooldown: 30,
      damage: 12,
      projectileSpeed: 50,
      projectileLifetime: 120,
      aimLead: true,
    },
    aggro: {
      range: 700,
      deAggroRange: 1000,
      aggroOnDamage: true,
      shareAggro: true,
      shareRange: 500,
    },
    drops: {
      xp: 30,
      credits: { min: 20, max: 50 },
      items: [
        { itemId: 'blaster_mk1', chance: 0.05 },
        { itemId: 'shield_cell', chance: 0.1 },
      ],
    },
    visualType: 'pirate_fighter',
    hue: 0,
  },

  // PIRATE HEAVY
  {
    id: 'pirate_heavy',
    name: 'Pirate Heavy',
    tier: 2,
    type: 'basic',
    health: 250,
    maxHealth: 250,
    radius: 32,
    mass: 2.0,
    movement: {
      type: 'chase',
      speed: 3.5,
      turnRate: 0.06,
      accel: 0.12,
      friction: 0.98,
    },
    weapon: {
      type: 'enemy_scatter',
      cooldown: 45,
      damage: 8,
      projectileSpeed: 40,
      projectileLifetime: 80,
      burstCount: 5,
    },
    aggro: {
      range: 500,
      deAggroRange: 800,
      aggroOnDamage: true,
      shareAggro: true,
      shareRange: 600,
    },
    drops: {
      xp: 60,
      credits: { min: 40, max: 80 },
      items: [
        { itemId: 'scatter_mk1', chance: 0.05 },
        { itemId: 'armor_plate', chance: 0.15 },
      ],
    },
    visualType: 'pirate_heavy',
    hue: 30,
  },

  // TURRET (stationary defense)
  {
    id: 'defense_turret',
    name: 'Defense Turret',
    tier: 2,
    type: 'turret',
    health: 200,
    maxHealth: 200,
    radius: 28,
    mass: 1000,
    movement: {
      type: 'stationary',
      speed: 0,
      turnRate: 0.15,
      accel: 0,
      friction: 1,
    },
    weapon: {
      type: 'turret_laser',
      cooldown: 20,
      damage: 15,
      projectileSpeed: 60,
      projectileLifetime: 100,
      aimLead: true,
    },
    aggro: {
      range: 600,
      deAggroRange: 800,
      aggroOnDamage: true,
      shareAggro: false,
    },
    drops: {
      xp: 40,
      credits: { min: 30, max: 60 },
      items: [{ itemId: 'turret_parts', chance: 0.2 }],
    },
    visualType: 'turret',
    hue: 60,
  },

  // DRONE SWARM
  {
    id: 'attack_drone',
    name: 'Attack Drone',
    tier: 1,
    type: 'swarm',
    health: 30,
    maxHealth: 30,
    radius: 12,
    mass: 0.3,
    movement: {
      type: 'swarm',
      speed: 7,
      turnRate: 0.12,
      accel: 0.3,
      friction: 0.95,
      separationDistance: 50,
      cohesionStrength: 0.02,
    },
    weapon: {
      type: 'drone_laser',
      cooldown: 60,
      damage: 5,
      projectileSpeed: 70,
      projectileLifetime: 60,
    },
    aggro: {
      range: 500,
      deAggroRange: 700,
      aggroOnDamage: true,
      shareAggro: true,
      shareRange: 300,
    },
    drops: {
      xp: 5,
      credits: { min: 2, max: 8 },
      items: [],
    },
    visualType: 'drone',
    hue: 270,
    scale: 0.6,
  },

  // MINI BOSS - ELITE PIRATE
  {
    id: 'elite_pirate',
    name: 'Elite Pirate Captain',
    tier: 3,
    type: 'boss',
    health: 800,
    maxHealth: 800,
    radius: 48,
    mass: 4.0,
    movement: {
      type: 'orbit',
      speed: 5,
      turnRate: 0.08,
      accel: 0.18,
      friction: 0.97,
      orbitDistance: 350,
      orbitSpeed: 0.03,
    },
    weapon: {
      type: 'elite_blaster',
      cooldown: 15,
      damage: 20,
      projectileSpeed: 55,
      projectileLifetime: 150,
      burstCount: 3,
      burstDelay: 5,
      aimLead: true,
    },
    shield: {
      health: 200,
      regenRate: 1,
      regenDelay: 180,
      absorbPercent: 0.8,
    },
    aggro: {
      range: 800,
      deAggroRange: 1200,
      aggroOnDamage: true,
      shareAggro: true,
      shareRange: 800,
    },
    phases: [
      {
        healthThreshold: 0.5,
        speedMultiplier: 1.3,
        damageMultiplier: 1.2,
        spawnOnTrigger: 'pirate_fighter',
      },
      {
        healthThreshold: 0.25,
        newBehavior: 'chase',
        speedMultiplier: 1.5,
        damageMultiplier: 1.5,
      },
    ],
    drops: {
      xp: 200,
      credits: { min: 150, max: 300 },
      items: [
        { itemId: 'blaster_mk2', chance: 0.2 },
        { itemId: 'missile_mk1', chance: 0.15 },
        { itemId: 'rare_module', chance: 0.1 },
      ],
    },
    visualType: 'elite_pirate',
    hue: 0,
    scale: 1.5,
  },
];
