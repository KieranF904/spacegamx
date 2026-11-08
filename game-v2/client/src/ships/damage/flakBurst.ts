/**
 * @contract client.damage.flak-burst
 * owns:       the maths of a flak burst's fragmentation: how many fragments a quality tier throws, where each one flies (a
 *             ring of streaks that end exactly on the burst's damage radius) and which ships' outlines the ends land inside
 * needs:      ShipSource (bodies, geometry, tuning), GameState (drawn ship poses), common standing/localToWorldDir
 * invariants: every fragment ends at the damage radius from the burst, whatever its count — client/src/ships/damage/flakBurst.test.ts
 *             a fragment's end is on a ship only when it is inside a standing part's outline — client/src/ships/damage/flakBurst.test.ts
 *             nothing here changes a hit or a blast; it only draws what the server's detonation already says — none pinned
 * extend:     a new quality tier is one more row of FRAGMENT_TIERS
 */

import { standing } from '@space-game/common';
import type { GameState } from '../../state/GameState';
import type { ShipSource } from '../ShipStore';

/** Fragments a burst throws by the particle quality (DamageParticles.keepShare): most to least */
export const FRAGMENT_TIERS: readonly { keep: number; count: number }[] = [
  { keep: 1, count: 16 },
  { keep: 0.6, count: 13 },
  { keep: 0, count: 10 },
];

/** Frames a fragment takes to fly out to the damage radius */
export const FRAGMENT_FRAMES = 16;

/** How many fragments a burst throws at this quality share (10 on the lowest tier, 16 on the highest) */
export function fragmentCount(keep: number): number {
  for (const t of FRAGMENT_TIERS) if (keep >= t.keep) return t.count;
  return FRAGMENT_TIERS[FRAGMENT_TIERS.length - 1].count;
}

export interface Fragment {
  /** Direction of flight (radians) */
  angle: number;
  /** World units a frame: over FRAGMENT_FRAMES it covers exactly the damage radius */
  speed: number;
}

/**
 * `count` fragments evenly round a burst (each nudged by up to a fifth of the gap between them), every one flying out to
 * exactly `radius` in FRAGMENT_FRAMES. `rnd` is the randomness (Math.random in play).
 */
export function fragmentPlan(count: number, radius: number, rnd: () => number, out: Fragment[] = []): Fragment[] {
  out.length = 0;
  const gap = (Math.PI * 2) / Math.max(1, count), base = rnd() * gap;
  for (let i = 0; i < count; i++) {
    out.push({ angle: base + i * gap + (rnd() - 0.5) * gap * 0.4, speed: radius / FRAGMENT_FRAMES });
  }
  return out;
}

/** Where a fragment ends (written into `out`): its direction out to the damage radius */
export function fragmentEnd(x: number, y: number, f: Fragment, out: { x: number; y: number }): void {
  const r = f.speed * FRAGMENT_FRAMES;
  out.x = x + Math.cos(f.angle) * r;
  out.y = y + Math.sin(f.angle) * r;
}

/** Is the point inside the convex polygon (flat grid-cell points `[x, y][]`)? */
export function insideConvex(poly: readonly (readonly number[])[], gx: number, gy: number): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = (q[0] - p[0]) * (gy - p[1]) - (q[1] - p[1]) * (gx - p[0]);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return sign !== 0;
}

/**
 * The id of the ship whose standing parts' outline holds the world point (-1: none), among the drawn ships within `reach`
 * of (cx, cy). Their drawn pose, as the shells' hits are cast (ships/hitSurface.ts)
 */
export function shipAtPoint(source: ShipSource, state: GameState, cx: number, cy: number, reach: number, x: number, y: number): number {
  const cs = source.tuning.cellSize;
  for (const [id, ship] of source.bodies) {
    const e = state.entities.get(id);
    if (!e) continue;
    if (Math.hypot(e.renderX - cx, e.renderY - cy) > reach + ship.derived.radius + 3 * cs) continue;
    if (Math.hypot(e.renderX - x, e.renderY - y) > ship.derived.radius + 3 * cs) continue;
    const com = ship.derived.com, phi = e.renderAngle + Math.PI / 2, c = Math.cos(phi), s = Math.sin(phi);
    const lx = x - e.renderX, ly = y - e.renderY;
    const gx = (lx * c + ly * s) / cs + com[0], gy = (-lx * s + ly * c) / cs + com[1];
    const geoms = source.geometry(ship);
    for (let i = 0; i < geoms.length; i++) {
      const b = geoms[i].bbox;
      if (gx < b.minX || gx > b.maxX || gy < b.minY || gy > b.maxY) continue;
      if (!standing(source.catalog, ship, i)) continue;
      for (const poly of geoms[i].convex) if (insideConvex(poly, gx, gy)) return id;
    }
  }
  return -1;
}
