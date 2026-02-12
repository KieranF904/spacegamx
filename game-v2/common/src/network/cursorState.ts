/**
 * Cursor & Weapon State — Packed 32-bit format
 *
 * Encodes player aim direction, server-authoritative laser collision distance,
 * and weapon active flags into a single integer for efficient snapshot transmission.
 *
 * Bit layout: [31..19 aimAngle 13b] [18..11 hitDist 8b] [10 left 1b] [9 right 1b] [8..0 RESERVED 9b]
 *
 * hitDist: 0-255 representing 0.0–1.0 fraction of LASER_RANGE.
 * When laser is not active the field is 0 (meaning max range / no hit).
 *
 * See CURSOR_STATE.md for full documentation on the bit format,
 * reserved bits, and future modular weapon plans.
 */

const AIM_BITS = 13;
const AIM_STEPS = (1 << AIM_BITS) - 1; // 8191
const TWO_PI = Math.PI * 2;

/** Max cursor distance from player center (circle clamp radius) */
export const CURSOR_RADIUS = 500;

/**
 * Quantize a raw angle to 13-bit precision for cursor state packing.
 * Returns integer 0–8191.
 * NOTE: This is for cursor state packing only. For physics, use quantizeAngle from Precision.ts
 */
export function quantizeCursorAngle(angle: number): number {
  let a = angle % TWO_PI;
  if (a < 0) a += TWO_PI;
  return Math.round(a / TWO_PI * AIM_STEPS) % (AIM_STEPS + 1);
}

/**
 * Dequantize a 13-bit integer back to radians.
 * Returns angle in [0, 2π).
 */
export function dequantizeCursorAngle(q: number): number {
  return (q & AIM_STEPS) / AIM_STEPS * TWO_PI;
}

/**
 * Pack cursor aim + weapon state into a single 32-bit integer.
 *
 * @param aimAngle - Aim direction in radians (will be quantized to 13 bits)
 * @param hitFraction - Server laser collision distance as fraction of LASER_RANGE (0.0–1.0).
 *                      0 = no hit / full range, 1 = point-blank.
 * @param leftActive - Whether left weapon slot is firing a continuous weapon (laser)
 * @param rightActive - Whether right weapon slot is firing a continuous weapon (laser)
 * @returns Packed 32-bit integer (safe for JSON — uses >>> 0 to treat as unsigned)
 */
export function packCursorWeaponState(
  aimAngle: number,
  hitFraction: number,
  leftActive: boolean,
  rightActive: boolean,
): number {
  const qa = quantizeCursorAngle(aimAngle);
  const qd = Math.round(Math.max(0, Math.min(1, hitFraction)) * 255) & 0xFF;
  // Bits 8..0 are RESERVED — see CURSOR_STATE.md for future modular weapon plans
  const packed = (qa << 19)
    | (qd << 11)
    | ((leftActive ? 1 : 0) << 10)
    | ((rightActive ? 1 : 0) << 9);
  return packed >>> 0; // unsigned
}

/**
 * Unpack cursor aim + weapon state from a packed 32-bit integer.
 */
export function unpackCursorWeaponState(packed: number): {
  aimAngle: number;
  hitFraction: number;
  leftActive: boolean;
  rightActive: boolean;
} {
  const raw = packed >>> 0;
  const qa = (raw >>> 19) & AIM_STEPS;
  const qd = (raw >>> 11) & 0xFF;
  return {
    aimAngle: dequantizeCursorAngle(qa),
    hitFraction: qd / 255,
    leftActive: ((raw >>> 10) & 1) === 1,
    rightActive: ((raw >>> 9) & 1) === 1,
  };
}
