import { BitBuffer } from '../BitBuffer';
import { createModule, NetworkModule } from './NetworkModule';
import { OrbitType, KeplerOrbitParams } from '../../asteroid/orbit.js';

/**
 * Orbit parameters for deterministic orbital mechanics
 * Static module - only sent on spawn since orbits don't change
 */

// Semi-major axis precision (typically 1000-100000 units)
const SMA_BITS = 20;
const SMA_MIN = 100;
const SMA_MAX = 500_000;

// Eccentricity (0-1 for elliptic, can be >1 for hyperbolic)
const ECC_BITS = 12;
const ECC_MIN = 0;
const ECC_MAX = 2; // Support hyperbolic

// Angles (full precision for orbital elements)
const ANGLE_BITS = 16;

// Epoch tick can be any tick number
const EPOCH_BITS = 24; // ~16 million ticks

/**
 * Orbit module - Static category
 * Only sent on entity spawn since orbit parameters are immutable
 */
export const OrbitModule: NetworkModule<KeplerOrbitParams> = createModule<KeplerOrbitParams>(
  'orbit',
  'static',
  (buffer: BitBuffer, data: KeplerOrbitParams) => {
    // Orbit type (2 bits - 4 possible types)
    buffer.writeBits(data.orbitType, 2);
    
    // Only write orbital elements if there's an actual orbit
    if (data.orbitType === OrbitType.None) {
      return;
    }
    
    // Semi-major axis (or periapsis for parabolic)
    buffer.writeQuantized(data.semiMajorAxis, SMA_MIN, SMA_MAX, SMA_BITS);
    
    // Eccentricity
    buffer.writeQuantized(data.eccentricity, ECC_MIN, ECC_MAX, ECC_BITS);
    
    // Argument of periapsis
    buffer.writeAngle(data.argPeriapsis, ANGLE_BITS);
    
    // Mean anomaly at epoch
    buffer.writeAngle(data.meanAnomaly0, ANGLE_BITS);
    
    // Epoch tick
    buffer.writeBits(data.epochTick, EPOCH_BITS);
  },
  (buffer: BitBuffer): KeplerOrbitParams => {
    const orbitType = buffer.readBits(2) as OrbitType;
    
    if (orbitType === OrbitType.None) {
      return {
        orbitType: OrbitType.None,
        semiMajorAxis: 0,
        eccentricity: 0,
        argPeriapsis: 0,
        meanAnomaly0: 0,
        epochTick: 0,
      };
    }
    
    return {
      orbitType,
      semiMajorAxis: buffer.readQuantized(SMA_MIN, SMA_MAX, SMA_BITS),
      eccentricity: buffer.readQuantized(ECC_MIN, ECC_MAX, ECC_BITS),
      argPeriapsis: buffer.readAngle(ANGLE_BITS),
      meanAnomaly0: buffer.readAngle(ANGLE_BITS),
      epochTick: buffer.readBits(EPOCH_BITS),
    };
  },
  {
    // Size: 2 bits (type only) for None, or 2 + 20 + 12 + 16 + 16 + 24 = 90 bits for actual orbit
  }
);

/**
 * Create a no-orbit (stationary) params
 */
export function createNoOrbit(): KeplerOrbitParams {
  return {
    orbitType: OrbitType.None,
    semiMajorAxis: 0,
    eccentricity: 0,
    argPeriapsis: 0,
    meanAnomaly0: 0,
    epochTick: 0,
  };
}
