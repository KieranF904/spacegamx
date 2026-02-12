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

/** Shield component - absorbs damage before health */
export const Shield = defineComponent({
  current: Types.f32,
  max: Types.f32,
  regenRate: Types.f32,
  regenDelay: Types.ui16,     // Ticks until regen starts after damage
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

/** Equipment slots - stores item data IDs */
export const Equipment = defineComponent({
  leftWeapon: Types.ui16,     // Item ID for left weapon
  rightWeapon: Types.ui16,    // Item ID for right weapon
  booster: Types.ui16,        // Item ID for booster
  cockpit: Types.ui16,        // Item ID for cockpit
});

/** Cached equipment stat bonuses for efficient access */
export const EquipmentStats = defineComponent({
  // Booster bonuses (multipliers, 1.0 = 100% = no bonus)
  thrustMultiplier: Types.f32,   // 1.0 = normal
  fuelCapacity: Types.f32,       // 1.0 = normal
  fuelRegenRate: Types.f32,      // 1.0 = normal
  // Cockpit bonuses (additive)
  accelBonus: Types.f32,         // Added to base accel
  turnBonus: Types.f32,          // Added to base turn speed
  hpBonus: Types.f32,            // Added to max HP
});

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

/** Weapon state (attached to player) */
export const WeaponState = defineComponent({
  // Left weapon
  leftCooldown: Types.ui16,
  leftCharge: Types.ui16,      // For charge weapons (missile, pulse)
  leftCharging: Types.ui8,
  // Right weapon
  rightCooldown: Types.ui16,
  rightCharge: Types.ui16,
  rightCharging: Types.ui8,
  // Mine count for mine weapons
  leftMineCount: Types.ui8,
  rightMineCount: Types.ui8,
  // Laser state (continuous fire)
  leftLaserActive: Types.ui8,
  leftLaserEndX: Types.f64,
  leftLaserEndY: Types.f64,
  leftLaserHitId: Types.eid,
  rightLaserActive: Types.ui8,
  rightLaserEndX: Types.f64,
  rightLaserEndY: Types.f64,
  rightLaserHitId: Types.eid,
});

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

/** Missile homing data */
export const Missile = defineComponent({
  targetId: Types.eid,
  turnRate: Types.f32,
  fuel: Types.ui16,
  armed: Types.ui8,
});

/** Pulse projectile data */
export const Pulse = defineComponent({
  chargeLevel: Types.f32,     // 0-1 charge multiplier
  splashRadius: Types.f32,
  growing: Types.ui8,         // Still growing
  growTimer: Types.f32,
});

/** Mine data */
export const Mine = defineComponent({
  ownerId: Types.eid,
  armTimer: Types.ui16,       // Ticks until armed
  armed: Types.ui8,
  splashRadius: Types.f32,
  damage: Types.f32,
});

/** Mining shot data - sticks to asteroids and deals DoT */
export const MiningShot = defineComponent({
  attachedToId: Types.eid,    // Asteroid this shot is stuck to
  dotDuration: Types.ui16,    // Total ticks of DoT remaining
  dotInterval: Types.ui16,    // Ticks between damage ticks
  dotTimer: Types.ui16,       // Current timer until next tick
  dotDamage: Types.f32,       // Damage per tick
});

/** Warp beacon data */
export const WarpBeacon = defineComponent({
  ownerId: Types.eid,
  activationTimer: Types.ui16, // Ticks until can teleport
  active: Types.ui8,
});

/** Warp projectile - teleports owner to destination on hit */
export const WarpProjectile = defineComponent({
  ownerId: Types.eid,
  activationTimer: Types.ui16, // Ticks until warp activates
  warpSpeed: Types.f32,       // Speed to launch caught entities
});

/** Mining beam state */
export const MiningBeam = defineComponent({
  targetId: Types.eid,        // Asteroid being mined
  progress: Types.f32,        // Mining progress 0-1
  dotTimer: Types.ui16,       // DoT tick timer
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
});

/** Portal/warp gate */
export const Portal = defineComponent({
  targetSystem: Types.ui8,
  targetX: Types.f64,
  targetY: Types.f64,
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

/** Particle emitter */
export const ParticleEmitter = defineComponent({
  type: Types.ui8,            // Emitter type enum
  rate: Types.f32,            // Particles per tick
  color: Types.ui32,
  lifetime: Types.f32,
  spread: Types.f32,
  speed: Types.f32,
  active: Types.ui8,
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

/** Interpolation data for smooth rendering */
export const Interpolated = defineComponent({
  prevX: Types.f64,
  prevY: Types.f64,
  prevAngle: Types.f64,
  targetX: Types.f64,
  targetY: Types.f64,
  targetAngle: Types.f64,
  t: Types.f32,               // Interpolation factor 0-1
});

// ============================================
// QUEST/PROGRESSION COMPONENTS
// ============================================

/** Quest progress (attached to player) */
export const QuestProgress = defineComponent({
  // Active quest IDs (up to 5 active quests)
  quest0: Types.ui16,
  quest1: Types.ui16,
  quest2: Types.ui16,
  quest3: Types.ui16,
  quest4: Types.ui16,
  // Current stage for each quest
  stage0: Types.ui8,
  stage1: Types.ui8,
  stage2: Types.ui8,
  stage3: Types.ui8,
  stage4: Types.ui8,
  // Progress counter for current objective
  progress0: Types.ui16,
  progress1: Types.ui16,
  progress2: Types.ui16,
  progress3: Types.ui16,
  progress4: Types.ui16,
});

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
}

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
