/**
 * The surface a shell struck, for its impact's direction (WeaponFx.surfaceAt): worked out on the client from what it
 * already draws, the hit point the server sent (projectileHit) and the shell's line, so it costs no network. The
 * shell's line, from a little back along its path to a little past the hit, is cast against the standing parts of
 * every ship near the hit (their real outlines, in world space at their drawn pose) and the outline of every rock
 * near it (getAsteroidPolygon, as the server's hit test); the first edge it crosses is the surface, and its owner what
 * was hit (out.target: the impact rides it, WeaponFx anchors).
 */

import { EntityType, getAsteroidPolygon, localToWorldDir, standing } from '@space-game/common';
import type { GameState } from '../state/GameState';
import type { ShipSource } from './ShipStore';
import { GAS_TYPES } from '../rendering/AsteroidLook';
import { inertBody } from '../state/trainingBodies';
import { SurfaceProbe, type SurfaceNormal } from '../rendering/weapons/impactAim';

const probe = new SurfaceProbe();

/**
 * The normal of the surface a shell flying (dx, dy) (a unit vector) struck at (x, y), facing the shell, into `out`;
 * null if nothing near the hit has an edge there (it hit something without an outline here: the impact goes back up
 * its line). `owner`'s own hull is never the surface.
 */
export function hitSurface(source: ShipSource, state: GameState, x: number, y: number, dx: number, dy: number, owner: number, out: SurfaceNormal): SurfaceNormal | null {
  const cs = source.tuning.cellSize;
  // From two cells back along its path (it came from outside) to one past the hit; the nearest edge within a cell and a
  // half if the drawn pose has the hull a little off the server's
  const back = 2 * cs, on = cs;
  probe.begin(x - dx * back, y - dy * back, x + dx * on, y + dy * on, x, y, 1.5 * cs);
  for (const [id, ship] of source.bodies) {
    if (id === owner) continue;
    const e = state.entities.get(id);
    if (!e || Math.hypot(e.renderX - x, e.renderY - y) > ship.derived.radius + 3 * cs) continue;
    // The hit in the ship's grid (cells about its centre of mass), to skip the parts nowhere near it
    const com = ship.derived.com, phi = e.renderAngle + Math.PI / 2, c = Math.cos(phi), s = Math.sin(phi);
    const lx = x - e.renderX, ly = y - e.renderY;
    const gx = (lx * c + ly * s) / cs + com[0], gy = (-lx * s + ly * c) / cs + com[1];
    const geoms = source.geometry(ship);
    for (let i = 0; i < geoms.length; i++) {
      const b = geoms[i].bbox;
      if (gx < b.minX - 3 || gx > b.maxX + 3 || gy < b.minY - 3 || gy > b.maxY + 3) continue;
      if (!standing(source.catalog, ship, i)) continue;
      for (const poly of geoms[i].convex) {
        for (let k = 0; k < poly.length; k++) {
          const p = poly[k], q = poly[(k + 1) % poly.length];
          const [ax, ay] = localToWorldDir([(p[0] - com[0]) * cs, (p[1] - com[1]) * cs], e.renderAngle);
          const [bx, by] = localToWorldDir([(q[0] - com[0]) * cs, (q[1] - com[1]) * cs], e.renderAngle);
          probe.edge(e.renderX + ax, e.renderY + ay, e.renderX + bx, e.renderY + by, id);
        }
      }
    }
  }
  for (const e of state.entities.ofType(EntityType.Asteroid)) {
    const size = e.data?.[0] ?? 30;
    if (Math.abs(e.renderX - x) > size + back || Math.abs(e.renderY - y) > size + back) continue;
    // (shells pass through gas pockets: the server's isGas)
    if (GAS_TYPES.has(e.composition?.type ?? '')) continue;
    // (a training drone this pilot is not on, or done with: state/trainingBodies.ts)
    if (inertBody(e.id)) continue;
    const poly = getAsteroidPolygon(e.id, e.renderX, e.renderY, size, e.renderAngle);
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      probe.edge(p.x, p.y, q.x, q.y, e.id);
    }
  }
  const n = probe.result(out);
  // (no outline here: what it hit is the nearest body round the point that has none, a single-body enemy or a station)
  if (!n) out.target = nearestBody(state, x, y, owner);
  return n;
}

const BODY_TYPES = [EntityType.Enemy, EntityType.NPC, EntityType.Player, EntityType.ShipBody, EntityType.Station];

/** The entity (not `owner`) whose middle is nearest (x, y), within its own size (a station's radius, else 90): -1 if none */
function nearestBody(state: GameState, x: number, y: number, owner: number): number {
  let best = -1, bd = Infinity;
  for (const type of BODY_TYPES) {
    for (const e of state.entities.ofType(type)) {
      if (e.id === owner) continue;
      const d = Math.hypot(e.renderX - x, e.renderY - y);
      if (d < (e.stationRadius ?? 90) && d < bd) { bd = d; best = e.id; }
    }
  }
  return best;
}
