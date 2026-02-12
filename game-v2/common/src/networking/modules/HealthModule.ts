import { BitBuffer } from '../BitBuffer';
import { createModule, NetworkModule } from './NetworkModule';

/**
 * Health data for damageable entities
 */
export interface HealthData {
  current: number;
  max: number;
  shield?: number;
  maxShield?: number;
}

// Health precision
// Using 16 bits allows for hp values up to 65535
const HEALTH_BITS = 16;
const HEALTH_MAX = 65535;

/**
 * Health module - State category
 * Sent on spawn and when damage is taken (correction on desync)
 */
export const HealthModule: NetworkModule<HealthData> = createModule<HealthData>(
  'health',
  'state',
  (buffer: BitBuffer, data: HealthData) => {
    // Current and max HP
    buffer.writeBits(Math.min(data.current, HEALTH_MAX), HEALTH_BITS);
    buffer.writeBits(Math.min(data.max, HEALTH_MAX), HEALTH_BITS);
    
    // Shield flag + values
    const hasShield = data.shield !== undefined && data.maxShield !== undefined;
    buffer.writeBool(hasShield);
    
    if (hasShield) {
      buffer.writeBits(Math.min(data.shield!, HEALTH_MAX), HEALTH_BITS);
      buffer.writeBits(Math.min(data.maxShield!, HEALTH_MAX), HEALTH_BITS);
    }
  },
  (buffer: BitBuffer): HealthData => {
    const current = buffer.readBits(HEALTH_BITS);
    const max = buffer.readBits(HEALTH_BITS);
    
    const hasShield = buffer.readBool();
    
    if (hasShield) {
      return {
        current,
        max,
        shield: buffer.readBits(HEALTH_BITS),
        maxShield: buffer.readBits(HEALTH_BITS),
      };
    }
    
    return { current, max };
  },
  {
    // Size: 33 bits without shield, 65 bits with shield
    needsCorrection: (server: HealthData, client: HealthData) => {
      // Health should match exactly since damage events are deterministic
      // But we add a small tolerance for rounding
      if (Math.abs(server.current - client.current) > 1) return true;
      if (Math.abs(server.max - client.max) > 1) return true;
      
      if (server.shield !== undefined || client.shield !== undefined) {
        const serverShield = server.shield ?? 0;
        const clientShield = client.shield ?? 0;
        if (Math.abs(serverShield - clientShield) > 1) return true;
      }
      
      return false;
    },
    
    // Don't interpolate health - snap to correct value
    // (visual smoothing can happen in the HP bar UI)
    interpolate: (_from: HealthData, to: HealthData, _t: number) => to,
  }
);

/**
 * Create health data from values
 */
export function createHealth(current: number, max: number, shield?: number, maxShield?: number): HealthData {
  return { current, max, shield, maxShield };
}

/**
 * Check if entity is alive
 */
export function isAlive(health: HealthData): boolean {
  return health.current > 0;
}

/**
 * Calculate health percentage
 */
export function healthPercent(health: HealthData): number {
  return health.max > 0 ? health.current / health.max : 0;
}
