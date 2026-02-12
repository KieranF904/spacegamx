import { BitBuffer } from '../BitBuffer';
import { createModule, NetworkModule } from './NetworkModule';

/**
 * AI state identifiers for network modules
 * Named differently from ECS AIState to avoid conflicts
 */
export const NetAIState = {
  IDLE: 0,
  PATROL: 1,
  CHASE: 2,
  ATTACK: 3,
  FLEE: 4,
  RETURN: 5,
  ORBIT: 6,
  MINE: 7,
} as const;

export type NetAIStateValue = typeof NetAIState[keyof typeof NetAIState];

/**
 * AI decision data - broadcast for NPC entities
 * Clients can't predict AI decisions, so this is always sent
 */
export interface AIData {
  state: NetAIStateValue;
  targetId?: number; // Entity being targeted
  waypointX?: number; // Current waypoint position
  waypointY?: number;
}

const AI_STATE_BITS = 4;
const TARGET_ID_BITS = 16;
const WAYPOINT_BITS = 20;
const WAYPOINT_MIN = -1_000_000;
const WAYPOINT_MAX = 1_000_000;

/**
 * AI module - Control category
 * Must be broadcast since clients can't predict AI decisions
 */
export const AIModule: NetworkModule<AIData> = createModule<AIData>(
  'ai',
  'control',
  (buffer: BitBuffer, data: AIData) => {
    buffer.writeBits(data.state, AI_STATE_BITS);
    
    // Target ID (optional)
    const hasTarget = data.targetId !== undefined;
    buffer.writeBool(hasTarget);
    if (hasTarget) {
      buffer.writeBits(data.targetId!, TARGET_ID_BITS);
    }
    
    // Waypoint (optional)
    const hasWaypoint = data.waypointX !== undefined && data.waypointY !== undefined;
    buffer.writeBool(hasWaypoint);
    if (hasWaypoint) {
      buffer.writeQuantized(data.waypointX!, WAYPOINT_MIN, WAYPOINT_MAX, WAYPOINT_BITS);
      buffer.writeQuantized(data.waypointY!, WAYPOINT_MIN, WAYPOINT_MAX, WAYPOINT_BITS);
    }
  },
  (buffer: BitBuffer): AIData => {
    const state = buffer.readBits(AI_STATE_BITS) as NetAIStateValue;
    
    const hasTarget = buffer.readBool();
    const targetId = hasTarget ? buffer.readBits(TARGET_ID_BITS) : undefined;
    
    const hasWaypoint = buffer.readBool();
    let waypointX: number | undefined;
    let waypointY: number | undefined;
    if (hasWaypoint) {
      waypointX = buffer.readQuantized(WAYPOINT_MIN, WAYPOINT_MAX, WAYPOINT_BITS);
      waypointY = buffer.readQuantized(WAYPOINT_MIN, WAYPOINT_MAX, WAYPOINT_BITS);
    }
    
    return { state, targetId, waypointX, waypointY };
  },
  {
    // Variable size: 6 bits minimum (state + 2 flags), up to 63 bits max
  }
);

/**
 * Create default idle AI state
 */
export function createIdleAI(): AIData {
  return { state: NetAIState.IDLE };
}

/**
 * Get human-readable AI state name
 */
export function getAIStateName(state: NetAIStateValue): string {
  const names: Record<NetAIStateValue, string> = {
    [NetAIState.IDLE]: 'Idle',
    [NetAIState.PATROL]: 'Patrol',
    [NetAIState.CHASE]: 'Chase',
    [NetAIState.ATTACK]: 'Attack',
    [NetAIState.FLEE]: 'Flee',
    [NetAIState.RETURN]: 'Return',
    [NetAIState.ORBIT]: 'Orbit',
    [NetAIState.MINE]: 'Mine',
  };
  return names[state] ?? 'Unknown';
}
