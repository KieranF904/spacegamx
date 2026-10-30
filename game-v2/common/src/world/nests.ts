/**
 * Hostile nests' positions (systems.json `nests`): each circles the system
 * centre, a planet, or a planet's moon, driven by the server tick like the
 * planets, so the server's packs and every client's drawing agree on where it is.
 */

import type { NestData, PlanetData } from '../data/schemas.js';
import { planetPosition, moonOffset } from './planets.js';

/** How far a nest's hull reaches from its centre (where its ships launch from) */
export const NEST_RADIUS = 420;

/** Where a nest is at a tick (`planets`: its system's, for one that circles a planet) */
export function nestPosition(n: NestData, planets: readonly PlanetData[] | undefined, tick: number): { x: number; y: number } {
  let cx = 0, cy = 0;
  const pl = n.around !== undefined ? planets?.find((p) => p.id === n.around) : undefined;
  if (pl) {
    const p = planetPosition(pl, tick);
    cx = p.x; cy = p.y;
    if (n.moon !== undefined && pl.moons?.[n.moon]) {
      const m = moonOffset(pl, n.moon, tick);
      cx += m.x; cy += m.y;
    }
  }
  const o = planetPosition({ orbit: n.orbit }, tick);
  return { x: cx + o.x, y: cy + o.y };
}

/** The nearest and farthest a nest comes to the system centre */
export function nestReach(n: NestData, planets: readonly PlanetData[] | undefined): { min: number; max: number } {
  const pl = n.around !== undefined ? planets?.find((p) => p.id === n.around) : undefined;
  // (One that circles the centre stays at its orbit's radius)
  if (!pl) return { min: n.orbit.radius, max: n.orbit.radius };
  const moon = n.moon !== undefined ? pl.moons?.[n.moon]?.distance ?? 0 : 0;
  const swing = moon + n.orbit.radius;
  return { min: Math.max(0, pl.orbit.radius - swing), max: pl.orbit.radius + swing };
}
