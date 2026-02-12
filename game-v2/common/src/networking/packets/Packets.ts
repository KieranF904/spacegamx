import { BitBuffer } from '../BitBuffer';
import { getEntitySchemaRequired, EntityTypeId, EntityTypeIdValue } from '../EntitySchema';
import { NetworkModule } from '../modules/NetworkModule';

/**
 * Packet types for the networking system
 */
export const PacketType = {
  // Control packets (every tick)
  INPUT_BROADCAST: 1,     // Player/AI inputs
  
  // Spawn/despawn
  ENTITY_SPAWN: 2,        // New entity with all modules
  ENTITY_DESPAWN: 3,      // Entity removed
  
  // Corrections
  STATE_CORRECTION: 4,    // State module corrections
  
  // Misc
  TICK_SYNC: 5,           // Server tick synchronization
  EVENT: 6,               // One-shot events (explosions, sounds)
} as const;

export type PacketTypeValue = typeof PacketType[keyof typeof PacketType];

/**
 * Header for all packets
 */
export interface PacketHeader {
  type: PacketTypeValue;
  tick: number;
}

const PACKET_TYPE_BITS = 4;
const TICK_BITS = 24;

export function writePacketHeader(buffer: BitBuffer, header: PacketHeader): void {
  buffer.writeBits(header.type, PACKET_TYPE_BITS);
  buffer.writeBits(header.tick, TICK_BITS);
}

export function readPacketHeader(buffer: BitBuffer): PacketHeader {
  return {
    type: buffer.readBits(PACKET_TYPE_BITS) as PacketTypeValue,
    tick: buffer.readBits(TICK_BITS),
  };
}

// ============================================
// INPUT BROADCAST PACKET
// ============================================

/**
 * Broadcast player/AI inputs for prediction
 * Sent every tick for entities with control modules
 */
export interface InputBroadcastPacket {
  header: PacketHeader;
  entityId: number;
  entityType: EntityTypeIdValue;
  moduleData: Map<string, unknown>; // moduleId -> data
}

const ENTITY_ID_BITS = 16;
const ENTITY_TYPE_BITS = 4;

export function writeInputBroadcast(buffer: BitBuffer, packet: InputBroadcastPacket): void {
  writePacketHeader(buffer, packet.header);
  buffer.writeBits(packet.entityId, ENTITY_ID_BITS);
  buffer.writeBits(packet.entityType, ENTITY_TYPE_BITS);
  
  const schema = getEntitySchemaRequired(packet.entityType);
  
  // Write all control module data in schema order
  for (const module of schema.controlModules) {
    const data = packet.moduleData.get(module.id);
    if (data === undefined) {
      throw new Error(`Missing data for control module '${module.id}'`);
    }
    module.write(buffer, data);
  }
}

export function readInputBroadcast(buffer: BitBuffer): InputBroadcastPacket {
  const header = readPacketHeader(buffer);
  const entityId = buffer.readBits(ENTITY_ID_BITS);
  const entityType = buffer.readBits(ENTITY_TYPE_BITS) as EntityTypeIdValue;
  
  const schema = getEntitySchemaRequired(entityType);
  const moduleData = new Map<string, unknown>();
  
  for (const module of schema.controlModules) {
    moduleData.set(module.id, module.read(buffer));
  }
  
  return { header, entityId, entityType, moduleData };
}

// ============================================
// ENTITY SPAWN PACKET
// ============================================

/**
 * Spawn a new entity with all module data
 */
export interface EntitySpawnPacket {
  header: PacketHeader;
  entityId: number;
  entityType: EntityTypeIdValue;
  ownerId?: number; // For player-owned entities
  moduleData: Map<string, unknown>;
}

const OWNER_ID_BITS = 8; // Max 255 players

export function writeEntitySpawn(buffer: BitBuffer, packet: EntitySpawnPacket): void {
  writePacketHeader(buffer, packet.header);
  buffer.writeBits(packet.entityId, ENTITY_ID_BITS);
  buffer.writeBits(packet.entityType, ENTITY_TYPE_BITS);
  
  // Owner ID (optional)
  buffer.writeBool(packet.ownerId !== undefined);
  if (packet.ownerId !== undefined) {
    buffer.writeBits(packet.ownerId, OWNER_ID_BITS);
  }
  
  const schema = getEntitySchemaRequired(packet.entityType);
  
  // Write ALL modules (control + state + static) on spawn
  const allModules = [
    ...schema.controlModules,
    ...schema.stateModules,
    ...schema.staticModules,
  ];
  
  for (const module of allModules) {
    const data = packet.moduleData.get(module.id);
    if (data === undefined) {
      throw new Error(`Missing data for module '${module.id}' in spawn packet`);
    }
    module.write(buffer, data);
  }
}

export function readEntitySpawn(buffer: BitBuffer): EntitySpawnPacket {
  const header = readPacketHeader(buffer);
  const entityId = buffer.readBits(ENTITY_ID_BITS);
  const entityType = buffer.readBits(ENTITY_TYPE_BITS) as EntityTypeIdValue;
  
  const hasOwner = buffer.readBool();
  const ownerId = hasOwner ? buffer.readBits(OWNER_ID_BITS) : undefined;
  
  const schema = getEntitySchemaRequired(entityType);
  const moduleData = new Map<string, unknown>();
  
  const allModules = [
    ...schema.controlModules,
    ...schema.stateModules,
    ...schema.staticModules,
  ];
  
  for (const module of allModules) {
    moduleData.set(module.id, module.read(buffer));
  }
  
  return { header, entityId, entityType, ownerId, moduleData };
}

// ============================================
// ENTITY DESPAWN PACKET
// ============================================

export interface EntityDespawnPacket {
  header: PacketHeader;
  entityId: number;
  reason?: number; // 0 = normal, 1 = destroyed, 2 = out of range, etc.
}

const DESPAWN_REASON_BITS = 4;

export function writeEntityDespawn(buffer: BitBuffer, packet: EntityDespawnPacket): void {
  writePacketHeader(buffer, packet.header);
  buffer.writeBits(packet.entityId, ENTITY_ID_BITS);
  buffer.writeBits(packet.reason ?? 0, DESPAWN_REASON_BITS);
}

export function readEntityDespawn(buffer: BitBuffer): EntityDespawnPacket {
  const header = readPacketHeader(buffer);
  return {
    header,
    entityId: buffer.readBits(ENTITY_ID_BITS),
    reason: buffer.readBits(DESPAWN_REASON_BITS),
  };
}

// ============================================
// STATE CORRECTION PACKET
// ============================================

/**
 * Correction for state modules when client prediction diverges
 * Includes the tick to rewind to for proper reconciliation
 */
export interface StateCorrectionPacket {
  header: PacketHeader;
  entityId: number;
  entityType: EntityTypeIdValue;
  rewindTick: number; // Client should rewind to this tick
  moduleMask: number; // Bitmask of which modules have corrections
  moduleData: Map<string, unknown>;
}

const MODULE_MASK_BITS = 8; // Up to 8 state modules

export function writeStateCorrection(buffer: BitBuffer, packet: StateCorrectionPacket): void {
  writePacketHeader(buffer, packet.header);
  buffer.writeBits(packet.entityId, ENTITY_ID_BITS);
  buffer.writeBits(packet.entityType, ENTITY_TYPE_BITS);
  buffer.writeBits(packet.rewindTick, TICK_BITS);
  
  const schema = getEntitySchemaRequired(packet.entityType);
  
  // Calculate and write module mask
  let mask = 0;
  for (let i = 0; i < schema.stateModules.length; i++) {
    if (packet.moduleData.has(schema.stateModules[i].id)) {
      mask |= (1 << i);
    }
  }
  buffer.writeBits(mask, MODULE_MASK_BITS);
  
  // Write only the modules that have corrections
  for (let i = 0; i < schema.stateModules.length; i++) {
    if (mask & (1 << i)) {
      const module = schema.stateModules[i];
      const data = packet.moduleData.get(module.id);
      module.write(buffer, data);
    }
  }
}

export function readStateCorrection(buffer: BitBuffer): StateCorrectionPacket {
  const header = readPacketHeader(buffer);
  const entityId = buffer.readBits(ENTITY_ID_BITS);
  const entityType = buffer.readBits(ENTITY_TYPE_BITS) as EntityTypeIdValue;
  const rewindTick = buffer.readBits(TICK_BITS);
  const moduleMask = buffer.readBits(MODULE_MASK_BITS);
  
  const schema = getEntitySchemaRequired(entityType);
  const moduleData = new Map<string, unknown>();
  
  for (let i = 0; i < schema.stateModules.length; i++) {
    if (moduleMask & (1 << i)) {
      const module = schema.stateModules[i];
      moduleData.set(module.id, module.read(buffer));
    }
  }
  
  return { header, entityId, entityType, rewindTick, moduleMask, moduleData };
}

// ============================================
// TICK SYNC PACKET
// ============================================

export interface TickSyncPacket {
  header: PacketHeader;
  serverTime: number; // For RTT calculation
}

export function writeTickSync(buffer: BitBuffer, packet: TickSyncPacket): void {
  writePacketHeader(buffer, packet.header);
  buffer.writeFloat32(packet.serverTime);
}

export function readTickSync(buffer: BitBuffer): TickSyncPacket {
  const header = readPacketHeader(buffer);
  return {
    header,
    serverTime: buffer.readFloat32(),
  };
}
