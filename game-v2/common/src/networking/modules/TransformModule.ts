import { BitBuffer } from '../BitBuffer';
import { createModule, NetworkModule } from './NetworkModule';
import {
  POSITION_BITS, POSITION_MIN, POSITION_MAX,
  ANGLE_BITS,
  POSITION_CORRECTION_THRESHOLD,
  ANGLE_CORRECTION_THRESHOLD,
  normalizeAngle,
} from '../Precision';

/**
 * Transform data - position and rotation
 * Used for spawn packets and corrections
 */
export interface TransformData {
  x: number;
  y: number;
  angle: number;
}

// Total: POSITION_BITS*2 + ANGLE_BITS = 20+20+12 = 52 bits (~6.5 bytes)

/**
 * Transform module - State category
 * Only sent on spawn and when correction is needed
 */
export const TransformModule: NetworkModule<TransformData> = createModule<TransformData>(
  'transform',
  'state',
  (buffer: BitBuffer, data: TransformData) => {
    buffer.writeQuantized(data.x, POSITION_MIN, POSITION_MAX, POSITION_BITS);
    buffer.writeQuantized(data.y, POSITION_MIN, POSITION_MAX, POSITION_BITS);
    buffer.writeAngle(data.angle, ANGLE_BITS);
  },
  (buffer: BitBuffer): TransformData => {
    return {
      x: buffer.readQuantized(POSITION_MIN, POSITION_MAX, POSITION_BITS),
      y: buffer.readQuantized(POSITION_MIN, POSITION_MAX, POSITION_BITS),
      angle: buffer.readAngle(ANGLE_BITS),
    };
  },
  {
    bitSize: POSITION_BITS * 2 + ANGLE_BITS,
    
    // Correction threshold uses shared constants
    needsCorrection: (server: TransformData, client: TransformData) => {
      const dx = server.x - client.x;
      const dy = server.y - client.y;
      const distSq = dx * dx + dy * dy;
      
      // Position tolerance from shared constants
      if (distSq > POSITION_CORRECTION_THRESHOLD * POSITION_CORRECTION_THRESHOLD) return true;
      
      // Angle tolerance from shared constants
      const angleDiff = Math.abs(normalizeAngle(server.angle - client.angle));
      if (angleDiff > ANGLE_CORRECTION_THRESHOLD) return true;
      
      return false;
    },
    
    // Linear interpolation for smooth corrections
    interpolate: (from: TransformData, to: TransformData, t: number) => {
      return {
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        angle: lerpAngle(from.angle, to.angle, t),
      };
    },
  }
);

/**
 * Interpolate angles taking the shortest path
 */
function lerpAngle(from: number, to: number, t: number): number {
  let diff = normalizeAngle(to - from);
  return from + diff * t;
}

/**
 * Create a default transform at origin
 */
export function createDefaultTransform(): TransformData {
  return { x: 0, y: 0, angle: 0 };
}
