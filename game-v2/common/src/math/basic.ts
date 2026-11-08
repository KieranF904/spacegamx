// Plain maths helpers for NON-SIM code (UI, rendering, input, econ, scripts).
// The deterministic sim keeps its own copies on purpose (ships/flight.ts wrapAngle is its canonical angle wrap,
// network/replication.ts, asteroid/orbit.ts, minebay, predict/*): do not swap those for these.

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

/** An angle wrapped into (-PI, PI]. Same loop as the sim's wrapAngle / turret wrapPi (bit-identical results). */
export function wrapPi(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Deep copy of plain JSON data (no Maps, Dates, undefined or functions survive). */
export function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
