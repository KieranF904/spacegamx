/**
 * Complete Game Constants - Migrated from v1
 */

// ============================================
// WORLD PARAMETERS
// ============================================

export const WORLD_SIZE = 260000;              // Half-width/height of world
export const STAR_MASS = 80000;                // Gravitational strength
export const STAR_RADIUS = 1000;               // Visual star radius
export const EVENT_HORIZON = 800;              // Objects consumed inside this
export const SYSTEM_RADIUS = 80000;            // Radius of each star system
export const CHUNK_SIZE = 500;                 // Spatial partitioning grid size
// Keplerian orbit parameter (distance^3 / tick^2)
export const ORBIT_MU = 625000;

// ============================================
// TIMING CONSTANTS
// ============================================

export const TICK_RATE = 60;                   // Server Hz
export const TICK_MS = 1000 / TICK_RATE;       // ~16.67ms
export const SNAPSHOT_RATE = 20;               // Network update Hz
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;
export const INPUT_DELAY_MS = 100;             // Input prediction delay
export const INPUT_DELAY_TICKS = Math.round(INPUT_DELAY_MS / TICK_MS);
export const MAX_FRAME_DELTA_MS = 250;         // Max frame time cap
export const PING_INTERVAL_MS = 2000;
export const PING_HISTORY_SIZE = 5;

// Server tick smoothing
export const SERVER_TICK_SMOOTHING = 0.5;
export const SERVER_TICK_MAX_STEP = 1;
export const INTERP_MAX_DELAY_MS = 520;
export const INTERP_MIN_DELAY_MS = 80;
export const INTERP_SLEW_MS_PER_SEC = 90;

// ============================================
// PLAYER CONSTANTS
// ============================================

export const PLAYER_MAX_HP = 100;
export const PLAYER_REGEN_RATE = 1;            // HP per regen tick
export const PLAYER_REGEN_DELAY_TICKS = 300;   // 5 seconds out of combat
export const PLAYER_RADIUS = 20;

// Shield (absorbs damage before health)
export const PLAYER_MAX_SHIELD = 50;
export const PLAYER_SHIELD_REGEN = 2;          // Per second
export const PLAYER_SHIELD_REGEN_DELAY = 180;  // 3 seconds out of combat

// Movement
export const ACCEL_BASE = 0.22;
export const TURN_SPEED = 0.08;
export const FRICTION = 0.985;
export const BOOST_DRAIN = 0.8;
export const BOOST_REGEN = 0.35;
export const BOOST_REGEN_DELAY = 60;           // Ticks
export const BOOST_FUEL_DEFAULT = 100;
export const BOOST_FACTOR = 2.2;               // Speed multiplier

// ============================================
// INVENTORY
// ============================================

export const INVENTORY_SIZE = 10;
export const BANK_SIZE = 50;
export const EQUIPMENT_SLOTS = ['leftWeapon', 'rightWeapon', 'booster', 'cockpit'] as const;

// ============================================
// ITEMS & DROPS
// ============================================

export const ITEM_LIFETIME_TICKS = 3600;       // 60 seconds
export const ITEM_FRICTION = 0.92;
export const TRACTOR_PICKUP_RANGE = 300;
export const TRACTOR_BEAM_DURATION = 300;      // ms

// ============================================
// WEAPONS - BLASTER/CANNON
// ============================================

export const BULLET_SPEED = 64;                // Base speed (multiplied by item speed)
export const BULLET_DAMAGE = 14;               // Base damage
export const FIRE_COOLDOWN_TICKS = 10;
export const BLASTER_LIFE_TICKS = 180;         // 3 seconds

// ============================================
// WEAPONS - LASER
// ============================================

export const LASER_RANGE = 3000;               // Base range
export const LASER_DAMAGE_MAX = 600;           // Max at point-blank
export const LASER_TICK_COOLDOWN = 6;

// ============================================
// WEAPONS - MISSILE
// ============================================

export const MISSILE_SPEED = 18;
export const MISSILE_FUEL_TICKS = 360;         // 6 seconds
export const MISSILE_CHARGE_TICKS = 20;        // Per missile
export const MISSILE_MAX_CHARGE = 3;           // mk1/2; mk3 = 8
export const MISSILE_TURN_RATE = 4.2;          // Rad/tick
export const MISSILE_ACCEL = 0.032;
export const MISSILE_DAMPING = 0.999;
export const MISSILE_TARGET_CONE_DEG = 30;
export const MISSILE_TARGET_RANGE = 1200;
export const MISSILE_SPEED_WOBBLE_AMPL = 0.06;
export const MISSILE_SPEED_WOBBLE_RATE = 0.12;

// ============================================
// WEAPONS - SCATTER
// ============================================

export const SCATTER_LIFE_TICKS = 60;          // 1 second
export const SCATTER_STOP_SPEED = 0.35;
export const SCATTER_STOP_FADE_SECONDS = 0.2;
export const SCATTER_FRICTION = 0.94;

// ============================================
// WEAPONS - PULSE
// ============================================

export const PULSE_CHARGE_TICKS = 180;         // 3 seconds max
export const PULSE_COOLDOWN_TICKS = 180;
export const PULSE_SPLASH_RADIUS = 220;
export const PULSE_SPLASH_FALLOFF = 1.5;
export const PULSE_GROW_TIME = 0.5;            // Seconds

// ============================================
// WEAPONS - MINE
// ============================================

export const MINE_CHARGE_TICKS = 180;
export const MINE_COOLDOWN_TICKS = 120;
export const MINE_LIFE_TICKS = 1800;           // 30 seconds
export const MINE_ARM_TICKS = 60;              // 1 second to arm
export const MINE_SPLASH_RADIUS = 400;
export const MINE_SPLASH_FALLOFF = 2.0;
export const MAX_MINES_PER_SLOT = 3;

// ============================================
// WEAPONS - WARP GUN
// ============================================

export const WARP_PROJECTILE_SPEED = 35;
export const WARP_ACTIVATION_TICKS = 60;
export const WARP_LAUNCH_SPEED = 800;
export const WARP_BOOST_END_SPEED = 25;

// ============================================
// WEAPONS - MINING
// ============================================

export const MINING_SPEED = 22;
export const MINING_DOT_TICKS = 1200;          // 20 seconds
export const MINING_DOT_INTERVAL = 30;
export const MINING_DOT_DAMAGE_FACTOR = 0.5;

// ============================================
// ENEMIES - ICE SPRITES
// ============================================

export const ICE_SPRITE_HP = 40;
export const ICE_SPRITE_DAMAGE = 5;
export const ICE_SPRITE_XP = 20;
export const ICE_SPRITE_SPEED = 2.5;
export const ICE_SPRITE_ATTACK_RANGE = 600;
export const ICE_SPRITE_ATTACK_COOLDOWN = 90;
export const ICE_SPRITE_PROJECTILE_SPEED = 8;
export const ICE_SPRITE_MAX_COUNT = 12;
export const ICE_SPRITE_SPAWN_INTERVAL = 180;
export const ICE_SPRITE_SPAWN_RADIUS_MIN = 40000;
export const ICE_SPRITE_SPAWN_RADIUS_MAX = 70000;

// ============================================
// ASTEROIDS
// ============================================

export const ASTEROID_FLOW_FIELD_AMPL = 14;
export const ASTEROID_FLOW_FIELD_RATE = 0.0014;
export const ASTEROID_FLOW_FIELD_SPATIAL = 1.6;

// Deterministic asteroid generation seed
export const ASTEROID_SEED = 'spacegame-v2-asteroids';
export const ASTEROID_MIN_SIZE = 30;
export const ASTEROID_MAX_SIZE = 80;
// Keplerian orbit eccentricity distribution (mostly near-circular)
export const ASTEROID_ECC_MAX = 0.25;
export const ASTEROID_ECC_CURVE = 4;

// ============================================
// SPATIAL & COLLISION
// ============================================

export const HIT_PADDING = 6;
export const SYSTEM_VISIBILITY_RADIUS = 100000;

// ============================================
// STATIONS
// ============================================

export const STATION_INTERACT_RADIUS = 800;

// ============================================
// NPC
// ============================================

export const NPC_INTERACT_RADIUS = 500;

// ============================================
// PROGRESSION
// ============================================

export const BASE_XP_TO_LEVEL = 100;
export const XP_SCALE_FACTOR = 1.5;
export const MAX_LEVEL = 100;

export function xpForLevel(level: number): number {
  return Math.floor(BASE_XP_TO_LEVEL * Math.pow(XP_SCALE_FACTOR, level - 1));
}

// ============================================
// AUDIO
// ============================================

export const AUDIO_MAX_DISTANCE = 8000;
export const AUDIO_REF_DISTANCE = 500;

// ============================================
// VISUAL
// ============================================

export const MAX_ENGINE_PARTICLES = 500;
export const DEBRIS_MIN_LIFE = 900;
export const DEBRIS_MAX_LIFE = 1500;

// ============================================
// TIER COLORS
// ============================================

export const TIER_COLORS = {
  mk1: { hue: 120, name: 'green' },
  mk2: { hue: 210, name: 'blue' },
  mk3: { hue: 280, name: 'purple' },
} as const;

export const RARITY_COLORS = {
  common: '#888888',
  uncommon: '#00cc00',
  rare: '#0088ff',
  epic: '#aa00ff',
  legendary: '#ff8800',
  quest: '#ffff00',
} as const;
