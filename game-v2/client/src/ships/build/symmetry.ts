/**
 * @contract client.ships.build-symmetry
 * owns:       the mirror across the ship's centre line both build editors use for symmetry mode: the axis (the core's centre,
 *             ships point N so the line runs along y), a point, a side and a whole part reflected across it
 * needs:      common placeGeometry / hasFixedBarrel / gunFacing (the game's own geometry); no DOM, no editor state
 * invariants: a mirrored part's footprint is the reflection of the original's, in all eight orientations of every piece — client/src/ships/build/symmetry.test.ts
 *             a part on the axis is its own mirror, so only one is placed — client/src/ships/build/symmetry.test.ts
 *             the mirror of a fixed-barrel gun fires out of the mirrored side — client/src/ships/build/symmetry.test.ts
 *             mirroring twice gives the original back — client/src/ships/build/symmetry.test.ts
 * extend:     a new piece shape needs nothing (the mirror is rot -> -rot, flip toggled, then placed by bounding box); a new kind of
 *             per-part state that mirrors (not a facing) is one more line in mirrorPart()
 */

import { placeGeometry, gunFacing, hasFixedBarrel } from '@space-game/common';
import type { Catalog, PlacedPart, Rot, Side, Vec2 } from '@space-game/common';

/** The axis as twice its x (an integer for a 1-wide core: the line through its middle), or null when there is no core */
export function axisOf(catalog: Catalog, parts: readonly PlacedPart[]): number | null {
  const core = parts.find((p) => p.fn === 'core');
  if (!core) return null;
  const b = placeGeometry(catalog, core).bbox;
  return b.minX + b.maxX;
}

/** A grid point across the axis */
export function mirrorPoint(at: Vec2, axis2: number): Vec2 {
  return [axis2 - at[0], at[1]];
}

/** East and west swap, north and south stay */
export function mirrorSide(s: Side): Side {
  return s === 'E' ? 'W' : s === 'W' ? 'E' : s;
}

const EPS = 1e-6;

/**
 * The part across the axis: the same piece, function and material, flipped (F) and turned the other way, standing where the
 * original's reflection stands, facing mirrored. Keeps `uid` (the caller gives the copy its own). Null: the reflection
 * does not land on whole cells (an axis through a cell's middle with an odd-width piece, say)
 */
export function mirrorPart(catalog: Catalog, p: PlacedPart, axis2: number): PlacedPart | null {
  const rot = ((4 - p.rot) % 4) as Rot, flip = !p.flip;
  const own = placeGeometry(catalog, p).bbox;
  const base = placeGeometry(catalog, { ...p, rot, flip, x: 0, y: 0 }).bbox;
  const x = axis2 - own.maxX - base.minX, y = own.minY - base.minY;
  if (Math.abs(x - Math.round(x)) > EPS || Math.abs(y - Math.round(y)) > EPS) return null;
  const out: PlacedPart = { ...p, rot, flip, x: Math.round(x), y: Math.round(y) };
  if (p.facing) out.facing = (hasFixedBarrel(catalog, p.fn) ? gunFacing(catalog, out) : null) ?? mirrorSide(p.facing as Side);
  return out;
}

const vertexKey = (g: ReturnType<typeof placeGeometry>) =>
  g.polygon.map((v) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)}`).sort().join('|');

/** Does the part stand on the axis, so that its mirror is itself (one part to place, not two) */
export function onAxis(catalog: Catalog, p: PlacedPart, axis2: number): boolean {
  const m = mirrorPart(catalog, p, axis2);
  if (!m) return false;
  return vertexKey(placeGeometry(catalog, m)) === vertexKey(placeGeometry(catalog, p));
}
