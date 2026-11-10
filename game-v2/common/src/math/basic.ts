/**
 * @contract math.basic
 * owns:       plain maths helpers: clamp, lerp, smoothstep, cloneJson (non-sim code), and wrapPi, the one angle wrap
 *             shared by the sim and everything else
 * needs:      nothing
 * invariants: wrapPi is bit-identical to the old sim loop for |a| <= 64 and to orbit.ts's old modulo form — common/src/math/basic.test.ts
 *             wrapPi always returns (Infinity and NaN give NaN, no hang) — common/src/math/basic.test.ts
 * extend:     add a helper only if non-sim code needs it; sim code uses detTrig / simMaths instead (wrapPi is the exception)
 */

// Plain maths helpers for NON-SIM code (UI, rendering, input, econ, scripts), plus wrapPi, which the sim uses too
// (ships/flight.ts re-exports it as wrapAngle; turret, minebay and asteroid orbits import it).

/** `v` held within [min, max] (min <= max). */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Linear blend from `a` (t = 0) to `b` (t = 1); `t` is not clamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** GLSL-style smoothstep: 0 at/below `edge0`, 1 at/above `edge1` (either order), eased 3t^2 - 2t^3 between. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const TAU = 2 * Math.PI;

/**
 * An angle wrapped into [-PI, PI] (PI and -PI stay as they are; whole turns give +0). Closed form: `%` is exact and the
 * one fix-up is exact (Sterbenz), so it never loops and Infinity/NaN come back NaN. Bit-identical to the old
 * `while (a > PI) a -= 2 * PI` loop for |a| <= 64 (every angle the sim feeds it) and to orbit.ts's old modulo form.
 */
export function wrapPi(a: number): number {
  if (a >= -Math.PI && a <= Math.PI) return a;
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r < -Math.PI) r += TAU;
  return r === 0 ? 0 : r;
}

/** Deep copy of plain JSON data (no Maps, Dates, undefined or functions survive). */
export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
