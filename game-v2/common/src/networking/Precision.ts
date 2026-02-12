/**
 * Shared Precision Constants for Network Serialization
 * 
 * CRITICAL: These values define the precision used by both:
 * - BitBuffer serialization (network transmission)
 * - Physics simulation (client prediction + server authority)
 * 
 * All systems MUST use these functions to ensure perfect determinism.
 */

// ============================================
// POSITION PRECISION
// ============================================

/** Bits used for position quantization */
export const POSITION_BITS = 20;
/** Minimum world coordinate */
export const POSITION_MIN = -1_000_000;
/** Maximum world coordinate */
export const POSITION_MAX = 1_000_000;

const POSITION_RANGE = POSITION_MAX - POSITION_MIN;
const POSITION_MAX_INT = (1 << POSITION_BITS) - 1;

/**
 * Quantize a position value to network precision
 * ~1.9 unit precision over ±1,000,000 range
 */
export function quantizePosition(value: number): number {
  // Clamp to range
  const clamped = Math.max(POSITION_MIN, Math.min(POSITION_MAX, value));
  // Normalize to 0-1
  const normalized = (clamped - POSITION_MIN) / POSITION_RANGE;
  // Quantize to integer
  const quantized = Math.round(normalized * POSITION_MAX_INT);
  // Dequantize back
  return POSITION_MIN + (quantized / POSITION_MAX_INT) * POSITION_RANGE;
}

// ============================================
// VELOCITY PRECISION
// ============================================

/** Bits used for velocity quantization */
export const VELOCITY_BITS = 16;
/** Minimum velocity */
export const VELOCITY_MIN = -5000;
/** Maximum velocity */
export const VELOCITY_MAX = 5000;

const VELOCITY_RANGE = VELOCITY_MAX - VELOCITY_MIN;
const VELOCITY_MAX_INT = (1 << VELOCITY_BITS) - 1;

/**
 * Quantize a velocity value to network precision
 * ~0.15 units/sec precision over ±5000 range
 */
export function quantizeVelocity(value: number): number {
  const clamped = Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, value));
  const normalized = (clamped - VELOCITY_MIN) / VELOCITY_RANGE;
  const quantized = Math.round(normalized * VELOCITY_MAX_INT);
  return VELOCITY_MIN + (quantized / VELOCITY_MAX_INT) * VELOCITY_RANGE;
}

// ============================================
// ANGLE PRECISION
// ============================================

/** Bits used for angle quantization */
export const ANGLE_BITS = 12; // Increased from 10 for smoother rotation (~0.088 degrees)

const ANGLE_MAX_INT = (1 << ANGLE_BITS) - 1;
const TWO_PI = Math.PI * 2;

/**
 * Quantize an angle (radians) to network precision
 * With 12 bits: ~0.088 degree precision (0.00153 radians)
 */
export function quantizeAngle(value: number): number {
  // Normalize to 0-2π
  let normalized = ((value % TWO_PI) + TWO_PI) % TWO_PI;
  // Quantize
  const quantized = Math.round((normalized / TWO_PI) * ANGLE_MAX_INT);
  // Dequantize
  return (quantized / ANGLE_MAX_INT) * TWO_PI;
}

/**
 * Normalize angle to -π to π range (for angle differences)
 */
export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= TWO_PI;
  while (angle < -Math.PI) angle += TWO_PI;
  return angle;
}

// ============================================
// ANGULAR VELOCITY PRECISION
// ============================================

/** Bits for angular velocity */
export const ANGULAR_VEL_BITS = 10;
export const ANGULAR_VEL_MIN = -10;
export const ANGULAR_VEL_MAX = 10;

const ANGULAR_VEL_RANGE = ANGULAR_VEL_MAX - ANGULAR_VEL_MIN;
const ANGULAR_VEL_MAX_INT = (1 << ANGULAR_VEL_BITS) - 1;

/**
 * Quantize angular velocity to network precision
 */
export function quantizeAngularVelocity(value: number): number {
  const clamped = Math.max(ANGULAR_VEL_MIN, Math.min(ANGULAR_VEL_MAX, value));
  const normalized = (clamped - ANGULAR_VEL_MIN) / ANGULAR_VEL_RANGE;
  const quantized = Math.round(normalized * ANGULAR_VEL_MAX_INT);
  return ANGULAR_VEL_MIN + (quantized / ANGULAR_VEL_MAX_INT) * ANGULAR_VEL_RANGE;
}

// ============================================
// HEALTH PRECISION
// ============================================

/** Bits for health values */
export const HEALTH_BITS = 16;
export const HEALTH_MAX = 65535;

/**
 * Quantize health to integer precision
 */
export function quantizeHealth(value: number): number {
  return Math.round(Math.max(0, Math.min(HEALTH_MAX, value)));
}

// ============================================
// BOOST FUEL PRECISION
// ============================================

/** Bits for boost fuel */
export const BOOST_BITS = 10;
export const BOOST_MAX = 1000;

const BOOST_MAX_INT = (1 << BOOST_BITS) - 1;

/**
 * Quantize boost fuel to network precision
 */
export function quantizeBoost(value: number): number {
  const clamped = Math.max(0, Math.min(BOOST_MAX, value));
  const normalized = clamped / BOOST_MAX;
  const quantized = Math.round(normalized * BOOST_MAX_INT);
  return (quantized / BOOST_MAX_INT) * BOOST_MAX;
}

// ============================================
// INPUT ANGLE PRECISION (for aim)
// ============================================

/** Bits for input aim angle - slightly higher precision for responsive aiming */
export const INPUT_ANGLE_BITS = 12;

const INPUT_ANGLE_MAX_INT = (1 << INPUT_ANGLE_BITS) - 1;

/**
 * Quantize input aim angle
 */
export function quantizeInputAngle(value: number): number {
  let normalized = ((value % TWO_PI) + TWO_PI) % TWO_PI;
  const quantized = Math.round((normalized / TWO_PI) * INPUT_ANGLE_MAX_INT);
  return (quantized / INPUT_ANGLE_MAX_INT) * TWO_PI;
}

// ============================================
// FULL STATE QUANTIZATION
// ============================================

export interface QuantizedState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

/**
 * Quantize a full physics state to network precision
 * Use this for both server simulation output and client prediction
 */
export function quantizeState(state: QuantizedState): QuantizedState {
  return {
    x: quantizePosition(state.x),
    y: quantizePosition(state.y),
    vx: quantizeVelocity(state.vx),
    vy: quantizeVelocity(state.vy),
    angle: quantizeAngle(state.angle),
  };
}

// ============================================
// CORRECTION THRESHOLDS
// ============================================

/**
 * Position correction threshold in units
 * If client differs by more than this, send correction
 */
export const POSITION_CORRECTION_THRESHOLD = 5.0;

/**
 * Velocity correction threshold in units/sec
 */
export const VELOCITY_CORRECTION_THRESHOLD = 1.0;

/**
 * Angle correction threshold in radians (~5 degrees)
 */
export const ANGLE_CORRECTION_THRESHOLD = 0.087;

/**
 * Check if two positions need correction
 */
export function needsPositionCorrection(serverX: number, serverY: number, clientX: number, clientY: number): boolean {
  const dx = serverX - clientX;
  const dy = serverY - clientY;
  return (dx * dx + dy * dy) > (POSITION_CORRECTION_THRESHOLD * POSITION_CORRECTION_THRESHOLD);
}

/**
 * Check if two velocities need correction
 */
export function needsVelocityCorrection(serverVx: number, serverVy: number, clientVx: number, clientVy: number): boolean {
  const dvx = serverVx - clientVx;
  const dvy = serverVy - clientVy;
  return (dvx * dvx + dvy * dvy) > (VELOCITY_CORRECTION_THRESHOLD * VELOCITY_CORRECTION_THRESHOLD);
}

/**
 * Check if two angles need correction
 */
export function needsAngleCorrection(serverAngle: number, clientAngle: number): boolean {
  const diff = Math.abs(normalizeAngle(serverAngle - clientAngle));
  return diff > ANGLE_CORRECTION_THRESHOLD;
}
