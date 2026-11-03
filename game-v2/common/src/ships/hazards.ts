/**
 * Hazards a system can carry (rated 0-5 in systems.json) and what a ship's
 * build makes of them. Tolerance comes from composition alone: each cell of a
 * material with a hazard rating counts its share of the hull, so an iridium
 * nose and a titanium engine bay is partial cover (rebuild.ts makeup).
 */

import type { WarmthRules } from './warmth.js';
import { dhypot } from '../math/detTrig.js';

export const HAZARDS = ['radiation', 'thermal', 'cryo', 'corrosive', 'gravitational', 'electromagnetic'] as const;
export type Hazard = typeof HAZARDS[number];

/** What materials can be: the hazard rules and later systems read these (materials.json traits) */
export const MATERIAL_TRAITS: Record<string, string> = {
  light: 'Light: quick to push about',
  heavy: 'Heavy: slow, but hard to toss about',
  brittle: 'Brittle: takes double damage from collisions',
  conductive: 'Conductive: conduits and gun mounts made of it work better',
  mass_anchor: 'Mass anchor: counts double against a gravity well',
  costly_repair: 'Costly to repair: twice the usual',
};

/** data/hazards.json */
export interface HazardRules {
  /** Within `margin` of the body's surface (or `radii` × its radius from its centre) */
  nearStar?: { radii?: number; margin?: number; ratings: Record<string, number> };
  nearBlackHole?: { radii?: number; margin?: number; ratings: Record<string, number> };
  tolerance?: {
    gravitational?: { massFloor: number; massPerPoint: number };
    thermal?: { massOver: number; points: number };
    electromagnetic?: { conductiveConduits: number };
  };
  effects?: Record<string, { summary: string; [k: string]: number | string }>;
  /** Cold builds up on a ship (cryo): how fast, and what warms it (warmth.ts) */
  warmth?: WarmthRules;
}
export type HazardRatings = Partial<Record<Hazard, number>>;

/** A system's hazards at a point: its own ratings, raised near its star or black hole */
export function hazardsAt(
  rules: HazardRules, sys: { hazardRatings?: Record<string, number>; starRadius?: number; centralBody?: { type?: string } },
  x: number, y: number,
): HazardRatings {
  const out: HazardRatings = {};
  for (const h of HAZARDS) if ((sys.hazardRatings?.[h] ?? 0) > 0) out[h] = sys.hazardRatings![h];
  const d = dhypot(x, y), r = sys.starRadius ?? 0, type = sys.centralBody?.type ?? 'sun';
  const near = type === 'black_hole' ? rules.nearBlackHole : type === 'none' ? undefined : rules.nearStar;
  if (near && r > 0 && d < (near.margin !== undefined ? r + near.margin : (near.radii ?? 0) * r)) {
    for (const [h, v] of Object.entries(near.ratings)) out[h as Hazard] = Math.max(out[h as Hazard] ?? 0, v);
  }
  return out;
}

/** What a ship's build stands up to, per hazard (0-5, fractional) */
export function hazardTolerance(rules: HazardRules, d: { mass: number; makeup: { tolerance: Record<string, number>; conduits: number; conductiveConduits: number; anchorMass: number } }): HazardRatings {
  const t = rules.tolerance ?? {}, m = d.makeup;
  const out: HazardRatings = {};
  for (const h of HAZARDS) out[h] = m.tolerance[h] ?? 0;
  if (t.gravitational) out.gravitational! += Math.max(0, d.mass + m.anchorMass - t.gravitational.massFloor) / t.gravitational.massPerPoint;
  if (t.thermal && d.mass > t.thermal.massOver) out.thermal! += t.thermal.points;
  if (t.electromagnetic && m.conduits > 0) out.electromagnetic! += (m.conductiveConduits / m.conduits) * t.electromagnetic.conductiveConduits;
  for (const h of HAZARDS) out[h] = Math.min(5, out[h]!);
  return out;
}

/**
 * What a ship's hazards do to how it flies, where it is (worked out alike on
 * server and client, from the same ratings, rules and build): steering and
 * thrust × control, a pull towards the well (world units / tick²), jump range
 * × jump, battery capacity × cap. Undefined: nothing.
 */
export interface HazardFlight { control: number; driftAccel: number; jump: number; cap: number }

/** An EMP cripples the drive rather than killing it: steering and thrust at this share while it lasts (its guns are out, and no jump starts) */
export const EMP_CONTROL = 0.35;

/** A ship's hazards with an EMP on top (server, prediction and replicas all fly it with this) */
export function withEmp(h: HazardFlight | undefined): HazardFlight {
  return { control: (h?.control ?? 1) * EMP_CONTROL, driftAccel: h?.driftAccel ?? 0, jump: h?.jump ?? 1, cap: h?.cap ?? 1 };
}

export function hazardFlight(rules: HazardRules, sys: Parameters<typeof hazardsAt>[1] | null | undefined, d: Parameters<typeof hazardTolerance>[1], x: number, y: number): HazardFlight | undefined {
  if (!sys) return undefined;
  const ratings = hazardsAt(rules, sys, x, y);
  if (!Object.keys(ratings).length) return undefined;
  const short = hazardDeficit(ratings, hazardTolerance(rules, d));
  if (!Object.keys(short).length) return undefined;
  const e = (h: string, k: string) => { const v = rules.effects?.[h]?.[k]; return typeof v === 'number' ? v : 0; };
  const grav = short.gravitational ?? 0;
  return {
    control: Math.max(0.2, 1 + grav * e('gravitational', 'control')),
    driftAccel: grav * e('gravitational', 'driftAccel'),
    jump: Math.max(0.2, 1 + grav * e('gravitational', 'jumpRange')),
    // (Cold doesn't drain the batteries: it builds up on the ship instead, warmth.ts)
    cap: Math.max(0.2, 1 + (short.radiation ?? 0) * e('radiation', 'batteryCap')),
  };
}

/** Rating minus tolerance, floored at 0: what a ship pays for, per hazard (only the ones it's short of) */
export function hazardDeficit(ratings: HazardRatings, tolerance: HazardRatings): HazardRatings {
  const out: HazardRatings = {};
  for (const h of HAZARDS) {
    const short = (ratings[h] ?? 0) - (tolerance[h] ?? 0);
    if (short > 0.05) out[h] = Math.round(short * 10) / 10;
  }
  return out;
}
