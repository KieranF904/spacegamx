// BitBuffer - Core serialization
export { BitBuffer } from './BitBuffer';

// Precision - Shared quantization for deterministic simulation
export {
  // Position
  POSITION_BITS, POSITION_MIN, POSITION_MAX,
  quantizePosition,
  // Velocity
  VELOCITY_BITS, VELOCITY_MIN, VELOCITY_MAX,
  quantizeVelocity,
  // Angle
  ANGLE_BITS,
  quantizeAngle,
  normalizeAngle,
  // Angular velocity
  ANGULAR_VEL_BITS, ANGULAR_VEL_MIN, ANGULAR_VEL_MAX,
  quantizeAngularVelocity,
  // Health
  HEALTH_BITS, HEALTH_MAX,
  quantizeHealth,
  // Boost
  BOOST_BITS, BOOST_MAX,
  quantizeBoost,
  // Input angle
  INPUT_ANGLE_BITS,
  quantizeInputAngle,
  // Full state
  quantizeState,
  // Correction thresholds
  POSITION_CORRECTION_THRESHOLD,
  VELOCITY_CORRECTION_THRESHOLD,
  ANGLE_CORRECTION_THRESHOLD,
  needsPositionCorrection,
  needsVelocityCorrection,
  needsAngleCorrection,
} from './Precision';
export type { QuantizedState } from './Precision';

// Network Modules
export type { 
  NetworkModule, 
  ModuleCategory
} from './modules/NetworkModule';
export { 
  NetworkModuleRegistry, 
  moduleRegistry,
  createModule 
} from './modules/NetworkModule';

export { InputModule, createEmptyInput, inputsEqual } from './modules/InputModule';
export type { InputData } from './modules/InputModule';
export { TransformModule, createDefaultTransform } from './modules/TransformModule';
export type { TransformData } from './modules/TransformModule';
export { VelocityModule, createZeroVelocity } from './modules/VelocityModule';
export type { VelocityData } from './modules/VelocityModule';
export { OrbitModule, createNoOrbit } from './modules/OrbitModule';
export { HealthModule, createHealth, isAlive, healthPercent } from './modules/HealthModule';
export type { HealthData } from './modules/HealthModule';
export { AIModule, createIdleAI, getAIStateName, NetAIState } from './modules/AIModule';
export type { AIData, NetAIStateValue } from './modules/AIModule';

// Entity Schema
export {
  getEntitySchema,
  getEntitySchemaRequired,
  getAllModules,
  hasModule,
} from './EntitySchema';
export type { EntitySchema, EntityTypeId, EntityTypeIdValue } from './EntitySchema';

// Packets
export {
  writePacketHeader,
  readPacketHeader,
  writeInputBroadcast,
  readInputBroadcast,
  writeEntitySpawn,
  readEntitySpawn,
  writeEntityDespawn,
  readEntityDespawn,
  writeStateCorrection,
  readStateCorrection,
  writeTickSync,
  readTickSync,
} from './packets/Packets';
export type {
  PacketType,
  PacketTypeValue,
  PacketHeader,
  InputBroadcastPacket,
  EntitySpawnPacket,
  EntityDespawnPacket,
  StateCorrectionPacket,
  TickSyncPacket,
} from './packets/Packets';

// Sync Manager
export {
  ServerSyncManager,
  ClientSyncManager,
} from './SyncManager';
export type {
  TimestampedInput,
  PendingCorrection,
} from './SyncManager';
