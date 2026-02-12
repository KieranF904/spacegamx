import { NetworkModule, moduleRegistry } from './modules/NetworkModule';
import { InputModule } from './modules/InputModule';
import { TransformModule } from './modules/TransformModule';
import { VelocityModule } from './modules/VelocityModule';
import { OrbitModule } from './modules/OrbitModule';
import { HealthModule } from './modules/HealthModule';
import { AIModule } from './modules/AIModule';

// Register all modules
moduleRegistry.register(InputModule);
moduleRegistry.register(TransformModule);
moduleRegistry.register(VelocityModule);
moduleRegistry.register(OrbitModule);
moduleRegistry.register(HealthModule);
moduleRegistry.register(AIModule);

/**
 * Entity schema defines which modules an entity type uses
 */
export interface EntitySchema {
  /** Entity type identifier */
  typeId: number;
  
  /** Human-readable name */
  name: string;
  
  /** Control modules (broadcast every tick) */
  controlModules: NetworkModule[];
  
  /** State modules (spawn + corrections) */
  stateModules: NetworkModule[];
  
  /** Static modules (spawn only) */
  staticModules: NetworkModule[];
}

/**
 * Entity type IDs
 */
export const EntityTypeId = {
  PLAYER_SHIP: 1,
  ASTEROID: 2,
  PROJECTILE: 3,
  NPC_SHIP: 4,
  PICKUP: 5,
  STATION: 6,
} as const;

export type EntityTypeIdValue = typeof EntityTypeId[keyof typeof EntityTypeId];

/**
 * Schema definitions for each entity type
 */
const schemas: Map<number, EntitySchema> = new Map();

/**
 * Player Ship - has input for prediction, transform/velocity for corrections
 */
schemas.set(EntityTypeId.PLAYER_SHIP, {
  typeId: EntityTypeId.PLAYER_SHIP,
  name: 'PlayerShip',
  controlModules: [InputModule],
  stateModules: [TransformModule, VelocityModule, HealthModule],
  staticModules: [], // Ship type could be added here later
});

/**
 * Asteroid - orbits are deterministic, only need spawn data
 */
schemas.set(EntityTypeId.ASTEROID, {
  typeId: EntityTypeId.ASTEROID,
  name: 'Asteroid',
  controlModules: [],
  stateModules: [HealthModule], // Health changes on mining
  staticModules: [OrbitModule], // Position derived from orbit
});

/**
 * Projectile - deterministic physics after spawn
 */
schemas.set(EntityTypeId.PROJECTILE, {
  typeId: EntityTypeId.PROJECTILE,
  name: 'Projectile',
  controlModules: [],
  stateModules: [], // Should be fully deterministic
  staticModules: [TransformModule, VelocityModule], // Initial state
});

/**
 * NPC Ship - AI decisions need to be broadcast
 */
schemas.set(EntityTypeId.NPC_SHIP, {
  typeId: EntityTypeId.NPC_SHIP,
  name: 'NPCShip',
  controlModules: [AIModule], // AI decisions (can't be predicted)
  stateModules: [TransformModule, VelocityModule, HealthModule],
  staticModules: [], // NPC type could be added
});

/**
 * Pickup item - mostly static after spawn
 */
schemas.set(EntityTypeId.PICKUP, {
  typeId: EntityTypeId.PICKUP,
  name: 'Pickup',
  controlModules: [],
  stateModules: [],
  staticModules: [TransformModule], // Just needs position
});

/**
 * Station - completely static
 */
schemas.set(EntityTypeId.STATION, {
  typeId: EntityTypeId.STATION,
  name: 'Station',
  controlModules: [],
  stateModules: [HealthModule], // Can take damage
  staticModules: [TransformModule], // Fixed position
});

/**
 * Get schema for an entity type
 */
export function getEntitySchema(typeId: number): EntitySchema | undefined {
  return schemas.get(typeId);
}

/**
 * Get schema (throws if not found)
 */
export function getEntitySchemaRequired(typeId: number): EntitySchema {
  const schema = schemas.get(typeId);
  if (!schema) {
    throw new Error(`No schema found for entity type ${typeId}`);
  }
  return schema;
}

/**
 * Get all modules for an entity type
 */
export function getAllModules(schema: EntitySchema): NetworkModule[] {
  return [
    ...schema.controlModules,
    ...schema.stateModules,
    ...schema.staticModules,
  ];
}

/**
 * Check if entity type has a specific module
 */
export function hasModule(schema: EntitySchema, moduleId: string): boolean {
  return getAllModules(schema).some(m => m.id === moduleId);
}
