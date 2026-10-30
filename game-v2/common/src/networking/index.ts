// BitBuffer - Core serialization
export { BitBuffer } from './BitBuffer.js';

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
} from './Precision.js';
export type { QuantizedState } from './Precision.js';

// Network Modules
export type { 
  NetworkModule, 
  ModuleCategory
} from './modules/NetworkModule.js';
export { 
  NetworkModuleRegistry, 
  moduleRegistry,
  createModule 
} from './modules/NetworkModule.js';

export { InputModule, createEmptyInput, inputsEqual } from './modules/InputModule.js';
export type { InputData } from './modules/InputModule.js';
export { TransformModule, createDefaultTransform } from './modules/TransformModule.js';
export type { TransformData } from './modules/TransformModule.js';
export { VelocityModule, createZeroVelocity } from './modules/VelocityModule.js';
export type { VelocityData } from './modules/VelocityModule.js';
export { OrbitModule, createNoOrbit } from './modules/OrbitModule.js';
export { HealthModule, createHealth, isAlive, healthPercent } from './modules/HealthModule.js';
export type { HealthData } from './modules/HealthModule.js';
export { AIModule, createIdleAI, getAIStateName, NetAIState } from './modules/AIModule.js';
export type { AIData, NetAIStateValue } from './modules/AIModule.js';

// Entity Schema
export {
  getEntitySchema,
  getEntitySchemaRequired,
  getAllModules,
  hasModule,
} from './EntitySchema.js';
export type { EntitySchema, EntityTypeId, EntityTypeIdValue } from './EntitySchema.js';

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
} from './packets/Packets.js';
export type {
  PacketType,
  PacketTypeValue,
  PacketHeader,
  InputBroadcastPacket,
  EntitySpawnPacket,
  EntityDespawnPacket,
  StateCorrectionPacket,
  TickSyncPacket,
} from './packets/Packets.js';

// Sync Manager
export {
  ServerSyncManager,
  ClientSyncManager,
} from './SyncManager.js';
export type {
  TimestampedInput,
  PendingCorrection,
} from './SyncManager.js';
