import { BitBuffer } from '../BitBuffer';
import { createModule, NetworkModule } from './NetworkModule';
import {
  VELOCITY_BITS, VELOCITY_MIN, VELOCITY_MAX,
  ANGULAR_VEL_BITS, ANGULAR_VEL_MIN, ANGULAR_VEL_MAX,
  VELOCITY_CORRECTION_THRESHOLD,
} from '../Precision';

/**
 * Velocity data for physics entities
 */
export interface VelocityData {
  vx: number;
  vy: number;
  angularVelocity?: number;
}

/**
 * Velocity module - State category
 * Only sent on spawn and corrections
 */
export const VelocityModule: NetworkModule<VelocityData> = createModule<VelocityData>(
  'velocity',
  'state',
  (buffer: BitBuffer, data: VelocityData) => {
    buffer.writeQuantized(data.vx, VELOCITY_MIN, VELOCITY_MAX, VELOCITY_BITS);
    buffer.writeQuantized(data.vy, VELOCITY_MIN, VELOCITY_MAX, VELOCITY_BITS);
    
    // Has angular velocity flag
    const hasAngular = data.angularVelocity !== undefined && data.angularVelocity !== 0;
    buffer.writeBool(hasAngular);
    
    if (hasAngular) {
      buffer.writeQuantized(data.angularVelocity!, ANGULAR_VEL_MIN, ANGULAR_VEL_MAX, ANGULAR_VEL_BITS);
    }
  },
  (buffer: BitBuffer): VelocityData => {
    const vx = buffer.readQuantized(VELOCITY_MIN, VELOCITY_MAX, VELOCITY_BITS);
    const vy = buffer.readQuantized(VELOCITY_MIN, VELOCITY_MAX, VELOCITY_BITS);
    
    const hasAngular = buffer.readBool();
    const angularVelocity = hasAngular
      ? buffer.readQuantized(ANGULAR_VEL_MIN, ANGULAR_VEL_MAX, ANGULAR_VEL_BITS)
      : undefined;
    
    return { vx, vy, angularVelocity };
  },
  {
    // Variable size: VELOCITY_BITS*2 + 1 without angular, + ANGULAR_VEL_BITS with
    needsCorrection: (server: VelocityData, client: VelocityData) => {
      const dvx = server.vx - client.vx;
      const dvy = server.vy - client.vy;
      const velDiffSq = dvx * dvx + dvy * dvy;
      
      // Velocity tolerance from shared constants
      if (velDiffSq > VELOCITY_CORRECTION_THRESHOLD * VELOCITY_CORRECTION_THRESHOLD) return true;
      
      // Angular velocity tolerance: 0.5 rad/sec
      const angDiff = Math.abs((server.angularVelocity || 0) - (client.angularVelocity || 0));
      if (angDiff > 0.5) return true;
      
      return false;
    },
    
    interpolate: (from: VelocityData, to: VelocityData, t: number) => {
      return {
        vx: from.vx + (to.vx - from.vx) * t,
        vy: from.vy + (to.vy - from.vy) * t,
        angularVelocity: from.angularVelocity !== undefined || to.angularVelocity !== undefined
          ? (from.angularVelocity || 0) + ((to.angularVelocity || 0) - (from.angularVelocity || 0)) * t
          : undefined,
      };
    },
  }
);

/**
 * Create zero velocity
 */
export function createZeroVelocity(): VelocityData {
  return { vx: 0, vy: 0 };
}
