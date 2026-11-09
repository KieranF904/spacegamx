/**
 * Where a shell's drawn line first meets something drawn (WeaponFx.castHit): the client's own picture of the world, so
 * a shell stops at the surface it is seen to touch, in the frame it touches it, whatever the server's hit says
 * (the server's hits only confirm the damage: docs/areas/weapons.md, "Where a shell stops").
 *
 *   ships    their standing parts' real outlines (common collide.ts castParts, the server's own test) at the pose they
 *            are drawn at; a ship whose shield is up, its bubble (the circle DamageFx draws); not the shooter, nor a
 *            ship its shells pass through on the server (hitRules sidesHurt: allies, docked ships, people's craft)
 *   rocks    their outlines (getAsteroidPolygon, as the server's hit test), not gas pockets
 *
 * A bounding-circle test first, then the parts in the ship's grid; nothing is allocated unless something is struck.
 */

import { EntityType, castParts, getAsteroidPolygon, shapedReachWorld, shapedStopAt, sidesHurt, standing, type ShipState } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipSource } from './ShipStore';
import { GAS_TYPES } from '../rendering/AsteroidLook';
import { inertBody } from '../state/trainingBodies';
import type { DrawnHit } from '../rendering/weapons/WeaponFx';

/** The shield bubble DamageFx draws round a ship: its radius */
export function bubbleRadius(ship: ShipState): number {
  return ship.derived.radius * 1.12 + 10;
}

/** How much of its shield a drawn ship has up (0..100: a pilot's row data[4], a ship body's data[1]) */
export function shieldOf(e: { type: number; data?: number[] }): number {
  return (e.type === EntityType.Player ? e.data?.[4] : e.data?.[1]) ?? 0;
}

/** The first t in [0, 1] at which the segment enters a circle (null: it doesn't, or it starts inside) */
export function circleEntry(x0: number, y0: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const fx = x0 - cx, fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return null;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const b = fx * dx + fy * dy;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

export class DrawnWorld {
  /** The ship castParts is asking about (one closure, made once) */
  private cur: ShipState | null = null;
  private readonly ok = (i: number) => standing(this.source.catalog, this.cur!, i);

  constructor(
    private readonly source: ShipSource,
    private readonly state: GameState,
    /** A ship's side (hitRules SIDE bits), as the client knows it */
    private readonly side: (id: number) => number,
  ) {}

  /**
   * The first surface the segment (x0, y0) -> (x1, y1) meets, into `out` (t along it, the point, what it is): false if
   * none. `owner`'s ship and the ids in `skip` (what a piercing shell has passed through) are never struck.
   */
  cast(x0: number, y0: number, x1: number, y1: number, owner: number, skip: readonly number[] | null, out: DrawnHit): boolean {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) return false;
    let best = Infinity, target = -1;
    const cs = this.source.tuning.cellSize;
    const sideA = this.side(owner);
    const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
    for (const [id, ship] of this.source.bodies) {
      if (id === owner || (skip && skip.includes(id))) continue;
      const e = this.state.entities.get(id);
      if (!e) continue;
      const shield = ship.kind === 'ship' ? shieldOf(e) : 0;
      // (a shaped shield may stand past the hull: features/zoneshield)
      const R = Math.max(shield > 0 ? Math.max(bubbleRadius(ship), ship.derived.radius) : ship.derived.radius, shapedReachWorld(ship, cs));
      const cx = e.renderX, cy = e.renderY;
      // (coarse: the segment's box against the circle's, then its distance from the middle)
      if (cx + R < minX || cx - R > maxX || cy + R < minY || cy - R > maxY) continue;
      const u = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2));
      const ex = x0 + dx * u - cx, ey = y0 + dy * u - cy;
      if (ex * ex + ey * ey > R * R) continue;
      if (sidesHurt(sideA, this.side(id)) !== 1) continue;
      if (shield > 0) {
        const t = circleEntry(x0, y0, dx, dy, cx, cy, bubbleRadius(ship));
        if (t !== null) { if (t < best) { best = t; target = id; } continue; }
      }
      // Its parts, in its grid (cells about its centre of mass), at the pose it's drawn at
      const phi = e.renderAngle + Math.PI / 2, c = Math.cos(phi), s = Math.sin(phi), com = ship.derived.com;
      const ax = x0 - cx, ay = y0 - cy, bx = x1 - cx, by = y1 - cy;
      this.cur = ship;
      const h = castParts(this.source.geometry(ship), this.ok,
        (ax * c + ay * s) / cs + com[0], (-ax * s + ay * c) / cs + com[1], (bx * c + by * s) / cs + com[0], (-bx * s + by * c) / cs + com[1]);
      this.cur = null;
      // (a live shaped shield its line crosses before the hull stops it there: the same rule the server runs, common hitRules.ts)
      const sh = ship.derived.fx?.shaped ? shapedStopAt(ship, cs, cx, cy, e.renderAngle, x0, y0, x1, y1, h) : null;
      if (sh) { if (sh.t < best) { best = sh.t; target = id; } continue; }
      if (h && h.t < best) { best = h.t; target = id; }
    }
    for (const e of this.state.entities.ofType(EntityType.Asteroid)) {
      const size = e.data?.[0] ?? 30, cx = e.renderX, cy = e.renderY;
      if (cx + size < minX || cx - size > maxX || cy + size < minY || cy - size > maxY) continue;
      if (GAS_TYPES.has(e.composition?.type ?? '')) continue;
      // (a training drone this pilot is not on, or done with: their shots pass it, state/trainingBodies.ts)
      if (inertBody(e.id)) continue;
      const u = Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2));
      const ex = x0 + dx * u - cx, ey = y0 + dy * u - cy;
      if (ex * ex + ey * ey > size * size * 1.5) continue;
      const poly = getAsteroidPolygon(e.id, cx, cy, size, e.renderAngle);
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k], q = poly[(k + 1) % poly.length];
        // (where the shell's segment crosses this edge)
        const qx = q.x - p.x, qy = q.y - p.y, den = dx * qy - dy * qx;
        if (Math.abs(den) < 1e-12) continue;
        const wx = p.x - x0, wy = p.y - y0;
        const t = (wx * qy - wy * qx) / den, v = (wx * dy - wy * dx) / den;
        if (t >= 0 && t <= 1 && v >= 0 && v <= 1 && t < best) { best = t; target = e.id; }
      }
    }
    if (target < 0) return false;
    out.t = best;
    out.x = x0 + dx * best;
    out.y = y0 + dy * best;
    out.target = target;
    return true;
  }
}
