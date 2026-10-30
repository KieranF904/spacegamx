/**
 * Planet and moon positions: slow circular orbits about the system centre,
 * driven by the server tick so every client sees them in the same place.
 */

import type { CometData, PlanetData } from '../data/schemas.js';
import { TICK_RATE } from '../constants.js';

const TICKS_PER_MINUTE = TICK_RATE * 60;

export function planetAngle(p: Pick<PlanetData, 'orbit'>, tick: number): number {
  if (!p.orbit.period) return p.orbit.phase;
  return p.orbit.phase + (tick / (p.orbit.period * TICKS_PER_MINUTE)) * Math.PI * 2;
}

/** (Lodestones orbit this way too: ships/jumpFields.ts) */
export function planetPosition(p: Pick<PlanetData, 'orbit'>, tick: number): { x: number; y: number } {
  const a = planetAngle(p, tick);
  return { x: Math.cos(a) * p.orbit.radius, y: Math.sin(a) * p.orbit.radius };
}

/** Moon `i` of planet `p`: its offset from the planet centre. */
export function moonOffset(p: PlanetData, i: number, tick: number): { x: number; y: number } {
  const m = p.moons![i];
  const a = m.phase + (m.period ? (tick / (m.period * TICKS_PER_MINUTE)) * Math.PI * 2 : 0);
  return { x: Math.cos(a) * m.distance, y: Math.sin(a) * m.distance };
}

/** A comet's position: Kepler's equation, so it races through perihelion and crawls far out. */
export function cometPosition(c: CometData, tick: number): { x: number; y: number } {
  const { a, e, argP, period, phase } = c.orbit;
  const M = phase + (period ? (tick / (period * TICKS_PER_MINUTE)) * Math.PI * 2 : 0);
  let E = M;
  for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const px = a * (Math.cos(E) - e), py = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const c0 = Math.cos(argP), s0 = Math.sin(argP);
  return { x: px * c0 - py * s0, y: px * s0 + py * c0 };
}
