/**
 * ECS Components - Complete component definitions for the game
 * Using bitecs for cache-efficient data storage
 */

import { defineComponent, Types } from 'bitecs';

// ============================================
// CORE COMPONENTS
// ============================================

/** 2D position in world space */
export const Position = defineComponent({
  x: Types.f64,
  y: Types.f64,
});

/** 2D velocity */
export const Velocity = defineComponent({
  x: Types.f64,
  y: Types.f64,
});

/** Rotation angle in radians */
export const Rotation = defineComponent({
  angle: Types.f64,
});

/** Entity radius for collision */
export const Radius = defineComponent({
  value: Types.f32,
});

/** Health component */
export const Health = defineComponent({
  current: Types.f32,
  max: Types.f32,
  regenRate: Types.f32,
  regenDelay: Types.ui32,     // Ticks until regen starts
  lastDamageTick: Types.ui32, // Last tick damage was taken
});

/** Lifetime in ticks - entity destroyed when reaches 0 */
export const Lifetime = defineComponent({
  remaining: Types.ui32,
});

// ============================================
// PLAYER COMPONENTS
// ============================================

/** Player marker and state */
export const Player = defineComponent({
  clientId: Types.ui32,
  level: Types.ui16,
  xp: Types.ui32,
  credits: Types.ui32,
  systemId: Types.ui8,       // Current star system index
});

/** Player input state */
export const Input = defineComponent({
  // Movement
  forward: Types.ui8,
  backward: Types.ui8,
  left: Types.ui8,
  right: Types.ui8,
  boost: Types.ui8,
  // Combat
  fireLeft: Types.ui8,
  fireRight: Types.ui8,
  // Modular ships: ship-relative strafe and helm (turn-with-keys) mode
  strafeLeft: Types.ui8,
  strafeRight: Types.ui8,
  helm: Types.ui8,
  /** Jump drive control held (or latched by the client) */
  jump: Types.ui8,
  /** Burst Strafer: dodge held (its way comes from the movement keys: ships/features/strafer, whose held input reads this field by name) */
  dodge: Types.ui8,
  /** Ship-to-cursor distance (world units) */
  cursorDist: Types.f32,
  // Target angle for aiming
  targetAngle: Types.f64,
  // Sequence number for networking
  sequence: Types.ui32,
});

/** Boost fuel state */
export const Boost = defineComponent({
  fuel: Types.f32,
  maxFuel: Types.f32,
  drainRate: Types.f32,
  regenRate: Types.f32,
  regenDelay: Types.ui16,     // Ticks until regen after use
  lastUseTick: Types.ui32,
});

// ============================================
// INVENTORY & EQUIPMENT
// ============================================

/** Inventory storage - array of item IDs */
export const Inventory = defineComponent({
  // 10 slots, each stores an item definition ID (0 = empty)
  slot0: Types.ui16,
  slot1: Types.ui16,
  slot2: Types.ui16,
  slot3: Types.ui16,
  slot4: Types.ui16,
  slot5: Types.ui16,
  slot6: Types.ui16,
  slot7: Types.ui16,
  slot8: Types.ui16,
  slot9: Types.ui16,
  // Stack counts for each slot
  count0: Types.ui16,
  count1: Types.ui16,
  count2: Types.ui16,
  count3: Types.ui16,
  count4: Types.ui16,
  count5: Types.ui16,
  count6: Types.ui16,
  count7: Types.ui16,
  count8: Types.ui16,
  count9: Types.ui16,
});

// ============================================
// WEAPON COMPONENTS
// ============================================

/** Generic projectile marker */
export const Projectile = defineComponent({
  ownerId: Types.eid,         // Entity that fired this
  damage: Types.f32,
  weaponType: Types.ui8,      // WeaponType enum
  tier: Types.ui8,
  // Spawn tracking for client-side prediction
  spawnTick: Types.ui32,      // Tick when spawned
  spawnX: Types.f64,          // Initial spawn position
  spawnY: Types.f64,
  sizeScale: Types.f32,       // Shell size relative to the base shot (0 = 1)
  turret: Types.ui8,          // Fired by a turret (1) or a fixed gun / anything else (0)
  miningYield: Types.f32,     // Ore per damage on asteroids (relative to the mining table's damagePerUnit)
  miningHardness: Types.ui8,  // Hardest rock it can crack
  endTick: Types.ui32,        // A shell that ends at a chosen point (a mortar's, an aim burst's): the tick it ends, in spawn + velocity × (tick - spawnTick) terms (0: none). Projectile row data[9]
});

/** Bullet-specific data (cannon, scatter) */
export const Bullet = defineComponent({
  speed: Types.f32,
});

/** Laser beam data */
export const Laser = defineComponent({
  range: Types.f32,
  maxDamage: Types.f32,
  endX: Types.f64,
  endY: Types.f64,
  hitEntityId: Types.eid,
});

/** Pulse projectile data */
export const Pulse = defineComponent({
  chargeLevel: Types.f32,     // 0-1 charge multiplier
  splashRadius: Types.f32,
  growing: Types.ui8,         // Still growing
  growTimer: Types.f32,
});

/** Mining shot data - sticks to asteroids and deals DoT */
export const MiningShot = defineComponent({
  attachedToId: Types.eid,    // Asteroid this shot is stuck to
  dotDuration: Types.ui16,    // Total ticks of DoT remaining
  dotInterval: Types.ui16,    // Ticks between damage ticks
  dotTimer: Types.ui16,       // Current timer until next tick
  dotDamage: Types.f32,       // Damage per tick
});

// ============================================
// AI / ENEMY COMPONENTS
// ============================================

/** AI state machine */
export const AI = defineComponent({
  behaviorType: Types.ui8,    // AI behavior enum
  state: Types.ui8,           // Current state enum
  targetId: Types.eid,        // Current target entity
  stateTimer: Types.ui32,     // Ticks in current state
  attackCooldown: Types.ui16,
  homeX: Types.f64,           // Spawn/home position
  homeY: Types.f64,
  aggroRange: Types.f32,
  deaggroRange: Types.f32,
});

/** Enemy marker with type info */
export const Enemy = defineComponent({
  typeId: Types.ui16,         // Enemy type definition ID
  xpValue: Types.ui16,
});

/** NPC marker (friendly) */
export const NPC = defineComponent({
  npcId: Types.ui16,          // NPC definition ID
});

// ============================================
// WORLD OBJECTS
// ============================================

/** Asteroid data */
export const Asteroid = defineComponent({
  size: Types.f32,
  hp: Types.f32,
  maxHp: Types.f32,
  resourceType: Types.ui8,    // Type of ore it contains
  resourceAmount: Types.ui16,
  // Orbital mechanics
  orbitType: Types.ui8,
  semiMajorAxis: Types.f32,
  eccentricity: Types.f32,
  argPeriapsis: Types.f32,
  meanAnomaly0: Types.f32,
  epochTick: Types.ui32,
  // Rotation/spin
  wobblePhase: Types.f32,
});

/** Space station */
export const Station = defineComponent({
  stationId: Types.ui16,      // Station definition ID
  dockingRadius: Types.f32,
  // Optional orbital mechanics (for moving stations)
  orbitType: Types.ui8,
  semiMajorAxis: Types.f32,
  eccentricity: Types.f32,
  argPeriapsis: Types.f32,
  meanAnomaly0: Types.f32,
  epochTick: Types.ui32,
  /** Orbit clock rate (1 = Keplerian). Stations orbit slower so ships can match them. */
  orbitTimeScale: Types.f32,
});

/** Portal/warp gate */
export const Portal = defineComponent({
  targetSystem: Types.ui8,
  targetX: Types.f64,
  targetY: Types.f64,
  /** 0 = jump gate (interact to travel to its system), 1 = rift (fly in: fast travel to targetX/targetY) */
  kind: Types.ui8,
  /** Rift colour hue (0-360) */
  hue: Types.f32,
});

/** Dropped item in world */
export const DroppedItem = defineComponent({
  itemId: Types.ui16,         // Item definition ID
  stackCount: Types.ui16,
});

// ============================================
// VISUAL/RENDERING COMPONENTS
// ============================================

/** Sprite reference for rendering */
export const Sprite = defineComponent({
  textureId: Types.ui16,
  scaleX: Types.f32,
  scaleY: Types.f32,
  tint: Types.ui32,           // RGB color
  alpha: Types.f32,
});

/** Trail effect (engine exhaust, projectile trails) */
export const Trail = defineComponent({
  color: Types.ui32,
  width: Types.f32,
  length: Types.ui16,         // Max points
  fadeRate: Types.f32,
});

/** Glow effect */
export const Glow = defineComponent({
  color: Types.ui32,
  intensity: Types.f32,
  radius: Types.f32,
});

// ============================================
// NETWORKING COMPONENTS
// ============================================

/** Network sync marker - entity should be replicated */
export const NetworkSync = defineComponent({
  priority: Types.ui8,        // Sync priority
  lastSyncTick: Types.ui32,
});

// ============================================
// QUEST/PROGRESSION COMPONENTS
// ============================================

// ============================================
// UTILITY TAGS
// ============================================

/** Tag for entities that should be destroyed this tick */
export const Dead = defineComponent({});

/** Tag for entities owned by a player */
export const OwnedBy = defineComponent({
  ownerId: Types.eid,
});

/** Tag for entities in a specific system */
export const InSystem = defineComponent({
  systemId: Types.ui8,
});

// ============================================
// ENUMS
// ============================================

export enum WeaponType {
  None = 0,
  Cannon = 1,
  Laser = 2,
  Scatter = 3,
  Missile = 4,
  Pulse = 5,
  Mine = 6,
  Mining = 7,
  Warp = 8,
  Railgun = 9,
  Flak = 10,
  Emp = 11,
  Hive = 12,
  CinderBloom = 13,
  Prism = 14,
  PrismShard = 15,
  Phase = 16,
  Singularity = 17,
  Autocannon = 18,
  Arc = 19,
  Torpedo = 20,
  Mortar = 21,
  Charge = 22,
  Magma = 23,
  HeartSpark = 24,
  HeartSeeker = 25,
  Rivet = 26,
  ScrapChunk = 27,
  SeamSeeker = 28,
}

/** Projectile weapon kinds (tuning.weapons keys) to their snapshot WeaponType */
export const WEAPON_KIND_TYPE: Record<string, number> = {
  cannon: 1, missile: 4, railgun: 9, flak: 10, emp: 11,
  hive: 12, cinder_bloom: 13, prism: 14, prism_shard: 15, phase: 16, singularity: 17,
  pulse: 5, autocannon: 18, arc: 19, torpedo: 20, mortar: 21, charge: 22, magma: 23,
  heart_spark: 24, heart_seeker: 25, rivet: 26, scrap_chunk: 27, seam_seeker: 28,
};

export enum AIBehavior {
  Idle = 0,
  Aggressive = 1,
  Flanker = 2,
  Sniper = 3,
  Swarm = 4,
  Territorial = 5,
}

export enum AIState {
  Idle = 0,
  Patrol = 1,
  Chase = 2,
  Attack = 3,
  Flee = 4,
  Return = 5,
}

export enum ParticleType {
  Engine = 0,
  Explosion = 1,
  Debris = 2,
  Spark = 3,
  Ice = 4,
}

export enum ResourceType {
  Iron = 0,
  Crystal = 1,
  Plasma = 2,
}
