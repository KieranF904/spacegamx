import { BitBuffer } from './BitBuffer';
import { getEntitySchemaRequired, EntitySchema } from './EntitySchema';
import { NetworkModule } from './modules/NetworkModule';
import { 
  PacketType, 
  StateCorrectionPacket, 
  writeStateCorrection 
} from './packets/Packets';

/**
 * Tracks entity state for correction detection
 */
interface EntitySyncState {
  entityId: number;
  entityType: number;
  lastAckedTick: number;
  clientState: Map<string, unknown>; // Last known client state per module
}

/**
 * Input with associated tick for replay
 */
export interface TimestampedInput {
  tick: number;
  input: Map<string, unknown>; // moduleId -> data
}

/**
 * Pending correction to be sent
 */
export interface PendingCorrection {
  entityId: number;
  entityType: number;
  tick: number;
  corrections: Map<string, unknown>; // moduleId -> corrected data
}

/**
 * Server-side sync manager
 * Detects when client state has diverged and queues corrections
 */
export class ServerSyncManager {
  // Entity states we're tracking
  private entityStates: Map<number, EntitySyncState> = new Map();
  
  // Pending corrections to send
  private pendingCorrections: PendingCorrection[] = [];
  
  // Input buffer per entity for late input detection
  private inputBuffers: Map<number, TimestampedInput[]> = new Map();
  
  // Max ticks to buffer inputs
  private readonly inputBufferSize = 30;
  
  /**
   * Register an entity for sync tracking
   */
  registerEntity(entityId: number, entityType: number): void {
    this.entityStates.set(entityId, {
      entityId,
      entityType,
      lastAckedTick: 0,
      clientState: new Map(),
    });
    this.inputBuffers.set(entityId, []);
  }
  
  /**
   * Unregister an entity
   */
  unregisterEntity(entityId: number): void {
    this.entityStates.delete(entityId);
    this.inputBuffers.delete(entityId);
  }
  
  /**
   * Record an input received from client
   */
  recordInput(entityId: number, tick: number, input: Map<string, unknown>): void {
    const buffer = this.inputBuffers.get(entityId);
    if (!buffer) return;
    
    // Insert in tick order
    const insertIdx = buffer.findIndex(i => i.tick > tick);
    if (insertIdx === -1) {
      buffer.push({ tick, input });
    } else {
      buffer.splice(insertIdx, 0, { tick, input });
    }
    
    // Trim old inputs
    while (buffer.length > this.inputBufferSize) {
      buffer.shift();
    }
  }
  
  /**
   * Get inputs for a tick range (for replaying)
   */
  getInputsForRange(entityId: number, startTick: number, endTick: number): TimestampedInput[] {
    const buffer = this.inputBuffers.get(entityId);
    if (!buffer) return [];
    
    return buffer.filter(i => i.tick >= startTick && i.tick <= endTick);
  }
  
  /**
   * Compare server state to expected client state and queue corrections if needed
   * @param entityId Entity to check
   * @param currentTick Current server tick
   * @param serverState Server's authoritative state (moduleId -> data)
   * @param clientPredictedState What we think the client has (from last ack + inputs)
   */
  checkForCorrection(
    entityId: number,
    currentTick: number,
    serverState: Map<string, unknown>,
    clientPredictedState?: Map<string, unknown>
  ): void {
    const entityState = this.entityStates.get(entityId);
    if (!entityState) return;
    
    const schema = getEntitySchemaRequired(entityState.entityType);
    const corrections = new Map<string, unknown>();
    
    // Compare each state module
    for (const module of schema.stateModules) {
      const serverData = serverState.get(module.id);
      const clientData = clientPredictedState?.get(module.id) ?? entityState.clientState.get(module.id);
      
      if (serverData === undefined) continue;
      
      // Check if correction needed
      const needsCorrection = module.needsCorrection
        ? module.needsCorrection(serverData, clientData)
        : !deepEqual(serverData, clientData);
      
      if (needsCorrection) {
        corrections.set(module.id, serverData);
      }
    }
    
    // Queue correction if any modules diverged
    if (corrections.size > 0) {
      this.pendingCorrections.push({
        entityId,
        entityType: entityState.entityType,
        tick: currentTick,
        corrections,
      });
    }
  }
  
  /**
   * Get and clear pending corrections
   */
  flushCorrections(): PendingCorrection[] {
    const corrections = this.pendingCorrections;
    this.pendingCorrections = [];
    return corrections;
  }
  
  /**
   * Serialize corrections to a buffer
   */
  serializeCorrections(corrections: PendingCorrection[], currentTick: number): BitBuffer[] {
    return corrections.map(correction => {
      const buffer = new BitBuffer(256);
      
      const packet: StateCorrectionPacket = {
        header: {
          type: PacketType.STATE_CORRECTION,
          tick: currentTick,
        },
        entityId: correction.entityId,
        entityType: correction.entityType as any,
        rewindTick: correction.tick,
        moduleMask: 0, // Will be calculated in write
        moduleData: correction.corrections,
      };
      
      writeStateCorrection(buffer, packet);
      return buffer;
    });
  }
  
  /**
   * Update client state after acknowledgment
   */
  acknowledgeState(entityId: number, tick: number, state: Map<string, unknown>): void {
    const entityState = this.entityStates.get(entityId);
    if (!entityState) return;
    
    if (tick > entityState.lastAckedTick) {
      entityState.lastAckedTick = tick;
      entityState.clientState = new Map(state);
    }
  }
}

/**
 * Client-side sync manager
 * Handles receiving corrections and replaying inputs
 */
export class ClientSyncManager {
  // Input history for replay after corrections
  private inputHistory: Map<number, TimestampedInput[]> = new Map();
  
  // Max ticks to keep in history
  private readonly historySize = 60;
  
  // Callback for applying corrections
  private correctionCallback?: (
    entityId: number,
    corrections: Map<string, unknown>,
    rewindTick: number
  ) => void;
  
  /**
   * Set callback for when corrections are received
   */
  onCorrection(callback: typeof this.correctionCallback): void {
    this.correctionCallback = callback;
  }
  
  /**
   * Record local input for potential replay
   */
  recordInput(entityId: number, tick: number, input: Map<string, unknown>): void {
    if (!this.inputHistory.has(entityId)) {
      this.inputHistory.set(entityId, []);
    }
    
    const history = this.inputHistory.get(entityId)!;
    history.push({ tick, input });
    
    // Trim old history
    while (history.length > this.historySize) {
      history.shift();
    }
  }
  
  /**
   * Get inputs after a certain tick (for replay after correction)
   */
  getInputsAfterTick(entityId: number, tick: number): TimestampedInput[] {
    const history = this.inputHistory.get(entityId);
    if (!history) return [];
    
    return history.filter(i => i.tick > tick);
  }
  
  /**
   * Handle a correction packet from server
   */
  handleCorrection(packet: StateCorrectionPacket): void {
    if (this.correctionCallback) {
      this.correctionCallback(
        packet.entityId,
        packet.moduleData,
        packet.rewindTick
      );
    }
  }
  
  /**
   * Clear history for an entity (on despawn)
   */
  clearEntity(entityId: number): void {
    this.inputHistory.delete(entityId);
  }
}

/**
 * Simple deep equality check for state comparison
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    
    if (aKeys.length !== bKeys.length) return false;
    
    for (const key of aKeys) {
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    
    return true;
  }
  
  return false;
}
