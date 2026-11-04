/**
 * How nest packs get about (factions.json nest/group `style`):
 *
 * - anchored: guards. Each ship patrols close round the nest (`roam`), as
 *   camps and the Graveyard's hulks do.
 * - loose (the usual): the pack wanders as one, well beyond `roam`, waypoints
 *   drawn wide round wherever it is now, with a pull back towards the nest
 *   that grows the further it strays (`bias`); now and then it pauses, drifts
 *   along the nest's orbit lane, or makes an excursion to something nearby (a
 *   planet, a station's outskirts, a gate, a belt) and comes back.
 * - nomad: it leaves the nest and travels the system between such places,
 *   settling a while at each, often towards where pilots are; it keeps to the
 *   nest's danger band (never into a safe band it doesn't belong to).
 *
 * Everything stays inside the nest's band (`nestBand`): its region of the
 * system, clear of the star. Paths go round the centre, not across it, so a
 * nomad crossing to the far side of the Drift never cuts through inner Sol.
 */

import type { NestData, PlanetData, StarSystemData } from '@space-game/common';
import { planetPosition, nestReach, datan2, dcos, dhypot, dsin } from '@space-game/common';

export type RoamStyle = 'anchored' | 'loose' | 'nomad';
export type XY = { x: number; y: number };
export interface Band { min: number; max: number }

/** How far a loose pack strays: up to this many times its `roam` from the nest */
export const LOOSE_REACH = 3.5;

/** The ring of the system a nest's packs keep to: its region band (or the whole system), clear of the central body */
export function nestBand(sys: Pick<StarSystemData, 'regions' | 'centralBody' | 'starRadius' | 'asteroidBelt' | 'portals' | 'planets'> | undefined, place: NestData): Band {
  const reach = nestReach(place, sys?.planets);
  const r = (reach.min + reach.max) / 2;
  const cb = sys?.centralBody as { radius?: number; gravity?: { horizon?: number } } | undefined;
  const body = Math.max(cb?.gravity?.horizon ?? 0, cb?.radius ?? sys?.starRadius ?? 0) + 6000;
  const belts = [sys?.asteroidBelt, ...(sys?.asteroidBelt?.extra ?? [])].map((b) => b?.outerRadius ?? 0);
  const edge = Math.max(reach.max, ...belts, ...(sys?.planets ?? []).map((p) => p.orbit.radius + p.radius + 4000), ...(sys?.portals ?? []).map((g) => dhypot(g.position.x, g.position.y))) * 1.08;
  const regions = sys?.regions ?? [];
  if (!regions.length) return { min: body, max: edge };
  let i = regions.findIndex((g) => r <= g.outer);
  if (i < 0) i = regions.length - 1;
  const inner = i > 0 ? regions[i - 1].outer : 0;
  // (Out of a safe band by a margin: a pack's ships reach a little past their home)
  const margin = i > 0 && regions[i - 1].danger === 'safe' ? 3000 : 0;
  return { min: Math.max(body, inner + margin), max: i === regions.length - 1 ? Math.max(edge, regions[i].outer) : regions[i].outer };
}

/** A point pushed back into the band (radially) */
export function clampBand(p: XY, b: Band): XY {
  const r = dhypot(p.x, p.y);
  if (r >= b.min && r <= b.max) return p;
  if (r < 1) return { x: b.min, y: 0 };
  const k = Math.min(b.max, Math.max(b.min, r)) / r;
  return { x: p.x * k, y: p.y * k };
}

/**
 * Move `from` towards `to` by about `step`, round the centre (radius and
 * angle together), so the path stays between the two radii. Returns the new
 * point and whether it arrived.
 */
export function stepRound(from: XY, to: XY, step: number): { at: XY; arrived: boolean } {
  const r0 = dhypot(from.x, from.y), r1 = dhypot(to.x, to.y);
  const a0 = datan2(from.y, from.x);
  let da = datan2(to.y, to.x) - a0;
  da = datan2(dsin(da), dcos(da));
  const left = dhypot(r1 - r0, ((r0 + r1) / 2) * da);
  if (left <= step) return { at: { ...to }, arrived: true };
  const f = step / left, r = r0 + (r1 - r0) * f, a = a0 + da * f;
  return { at: { x: dcos(a) * r, y: dsin(a) * r }, arrived: false };
}

/** Places worth going to in a system (planets' near sides, stations' outskirts, gates, belts, other nests), in the band */
export function placesOfInterest(sys: Pick<StarSystemData, 'asteroidBelt'> | undefined, planets: PlanetData[] | undefined, tick: number, extra: XY[], band: Band, rng: () => number): XY[] {
  const out: XY[] = [];
  for (const p of planets ?? []) {
    const at = planetPosition(p, tick), r = dhypot(at.x, at.y) || 1, off = p.radius + 3000;
    out.push({ x: at.x - (at.x / r) * off, y: at.y - (at.y / r) * off });
  }
  for (const b of [sys?.asteroidBelt, ...(sys?.asteroidBelt?.extra ?? [])]) {
    if (!b) continue;
    for (let k = 0; k < 3; k++) { const a = rng() * Math.PI * 2, r = b.innerRadius + rng() * (b.outerRadius - b.innerRadius); out.push({ x: dcos(a) * r, y: dsin(a) * r }); }
  }
  out.push(...extra);
  return out.filter((q) => { const r = dhypot(q.x, q.y); return r >= band.min && r <= band.max; });
}

/**
 * A loose pack's next waypoint: drawn wide round where it is, pulled back
 * towards home the further it has strayed; sometimes along the nest's orbit
 * lane, or out to a place nearby. `pause`: hold here a while instead.
 */
export function looseWaypoint(at: XY, home: XY, roam: number, bias: number, band: Band, places: XY[], laneR: number, rng: () => number): { wp: XY; pause: boolean } {
  const reach = roam * LOOSE_REACH;
  const off = dhypot(at.x - home.x, at.y - home.y);
  const roll = rng();
  let wp: XY;
  if (roll < 0.1 && off < reach * 0.7) return { wp: at, pause: true };
  if (roll < 0.25) {
    // An excursion: something within reach of home, or just a long way out
    const near = places.filter((q) => dhypot(q.x - home.x, q.y - home.y) < reach * 1.1);
    const a = rng() * Math.PI * 2;
    wp = near.length ? near[Math.floor(rng() * near.length)] : { x: home.x + dcos(a) * reach * 0.9, y: home.y + dsin(a) * reach * 0.9 };
  } else if (roll < 0.45 && laneR > 0) {
    // Along the nest's orbit lane, ahead or behind it
    const a = datan2(home.y, home.x) + ((rng() < 0.5 ? -1 : 1) * roam * (0.8 + rng() * 2)) / laneR;
    wp = { x: dcos(a) * laneR, y: dsin(a) * laneR };
  } else {
    // Somewhere wide round here, the pull home growing with how far it has come
    const pull = Math.min(1, bias * (0.3 + off / reach));
    const cx = at.x + (home.x - at.x) * pull, cy = at.y + (home.y - at.y) * pull;
    const a = rng() * Math.PI * 2, d = roam * (0.4 + 1.8 * rng() * rng());
    wp = { x: cx + dcos(a) * d, y: cy + dsin(a) * d };
  }
  // Never past its reach of home, and inside its band
  const d = dhypot(wp.x - home.x, wp.y - home.y);
  if (d > reach) wp = { x: home.x + ((wp.x - home.x) / d) * reach, y: home.y + ((wp.y - home.y) / d) * reach };
  return { wp: clampBand(wp, band), pause: false };
}

/** A nomad pack's next stop: often near a pilot in its band (if any), else a place of interest, not where it is now */
export function nomadDestination(at: XY, places: XY[], pilots: XY[], band: Band, rng: () => number): XY {
  const inBand = pilots.filter((p) => { const r = dhypot(p.x, p.y); return r >= band.min - 4000 && r <= band.max + 4000; });
  if (inBand.length && rng() < 0.45) {
    const p = inBand[Math.floor(rng() * inBand.length)], a = rng() * Math.PI * 2, d = 9000 + rng() * 12000;
    return clampBand({ x: p.x + dcos(a) * d, y: p.y + dsin(a) * d }, band);
  }
  const far = places.filter((q) => dhypot(q.x - at.x, q.y - at.y) > 15000);
  const pool = far.length ? far : places;
  if (pool.length) return clampBand(pool[Math.floor(rng() * pool.length)], band);
  const a = rng() * Math.PI * 2, r = band.min + rng() * (band.max - band.min);
  return { x: dcos(a) * r, y: dsin(a) * r };
}
