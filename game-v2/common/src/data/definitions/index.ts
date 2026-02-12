/**
 * Definitions Index - Export all data definitions
 */

// === Weapon System ===
export * from './WeaponDefinition.js';
export type {
  WeaponDefinition,
  ProjectileConfig,
  HomingConfig,
  SplashConfig,
  ChargeConfig,
  ScatterConfig,
  MineConfig,
  LaserConfig,
  MiningConfig,
} from './WeaponDefinition.js';

// === Enemy System ===
export * from './EnemyDefinition.js';
export type {
  EnemyDefinition,
  EnemyMovementConfig,
  EnemyWeaponConfig,
  AggroConfig,
  DropConfig,
  ItemDropConfig,
  ResourceDropConfig,
  SpawnerConfig,
  ShieldConfig,
  PhaseConfig,
} from './EnemyDefinition.js';

// === Asteroid System ===
export * from './AsteroidDefinition.js';
export type {
  AsteroidDefinition,
  AsteroidSizeConfig,
  AsteroidResourceConfig,
  ResourceYield,
  BonusResourceConfig,
  AsteroidPhysicsConfig,
  OrbitConfig,
  DriftConfig,
  AsteroidSpawnConfig,
  AsteroidFieldConfig,
  FieldHazard,
} from './AsteroidDefinition.js';

// === Item System ===
export * from './ItemDefinition.js';
export type {
  ItemDefinition,
  ItemCategory,
  ItemRarity,
  EquipmentConfig,
  StatModifiers,
  ConsumableConfig,
  ConsumableEffect,
  ResourceConfig,
} from './ItemDefinition.js';

// === Particle System ===
export * from './ParticleDefinition.js';
export type {
  ParticleDefinition,
  EmissionConfig,
  ParticleConfig,
  ParticlePhysicsConfig,
  ParticleVisualConfig,
  ColorConfig,
} from './ParticleDefinition.js';

// === Trail System ===
export * from './TrailDefinition.js';
export type {
  TrailDefinition,
  TrailShapeConfig,
  TrailVisualConfig,
  TrailColorConfig,
  TrailBehaviorConfig,
} from './TrailDefinition.js';

// === Sun Shader System ===
export * from './SunShaderDefs.js';
