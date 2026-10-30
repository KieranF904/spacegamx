/**
 * Hit tests against a ship's parts, in its grid space (cells, about the grid
 * origin: ShipBridge.worldToGrid puts a world point there). Shared by the
 * server's hits and the client's beam visuals, so both stop at the same part.
 *
 *   castParts     the first standing part a segment (or a thick one: a capsule) meets, and how far along
 *   partDistance  how far a point is from a part's real outline (0 inside it)
 *   nearestParts  the parts within a radius of a point by that distance (splash, blasts)
 *
 * Each part's bounding box is tried first, so the convex pieces of a huge
 * boss are only clipped where the segment or point actually is.
 */

import type { Vec2 } from './types.js';
import type { PlacedGeom } from './grid.js';
import { segmentConvexEntry } from './geometry.js';

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Where segment p0→p1 enters a box grown by `pad` (0..1), or -1 if it misses it.
 * (Slab test: no allocation.)
 */
export function segmentBoxEntry(x0: number, y0: number, x1: number, y1: number, b: Box, pad = 0): number {
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const minX = b.minX - pad, maxX = b.maxX + pad, minY = b.minY - pad, maxY = b.maxY + pad;
  if (Math.abs(dx) < 1e-12) { if (x0 < minX || x0 > maxX) return -1; }
  else {
    let a = (minX - x0) / dx, c = (maxX - x0) / dx;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return -1;
  }
  if (Math.abs(dy) < 1e-12) { if (y0 < minY || y0 > maxY) return -1; }
  else {
    let a = (minY - y0) / dy, c = (maxY - y0) / dy;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return -1;
  }
  return t0;
}

/** Where segment p0→p1 first comes within r of point c (0..1), or null */
function segmentCircleEntry(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number): number | null {
  const fx = x0 - cx, fy = y0 - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const dx = x1 - x0, dy = y1 - y0;
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const b = fx * dx + fy * dy;
  if (b >= 0) return null; // heading away
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : null;
}

/** One reused quad (an edge pushed out by r) for the capsule test */
const QUAD: Vec2[] = [[0, 0], [0, 0], [0, 0], [0, 0]];

/**
 * Segment p0→p1, `r` thick, against a convex polygon (counter-clockwise, as
 * pointInConvex takes them): the smallest t where the capsule touches it, or
 * null. Exact: the polygon grown by r is the polygon, a slab out of each edge
 * and a disc at each corner.
 */
export function capsuleConvexEntry(poly: Vec2[], x0: number, y0: number, x1: number, y1: number, r: number): number | null {
  let best = segmentConvexEntry(poly, x0, y0, x1, y1);
  if (r <= 0 || best === 0) return best;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    // Outward normal (the inside is on the left of a→b)
    const nx = (ey / len) * r, ny = (-ex / len) * r;
    QUAD[0][0] = a[0]; QUAD[0][1] = a[1];
    QUAD[1][0] = a[0] + nx; QUAD[1][1] = a[1] + ny;
    QUAD[2][0] = b[0] + nx; QUAD[2][1] = b[1] + ny;
    QUAD[3][0] = b[0]; QUAD[3][1] = b[1];
    const t = segmentConvexEntry(QUAD, x0, y0, x1, y1);
    if (t !== null && (best === null || t < best)) best = t;
    const tc = segmentCircleEntry(x0, y0, x1, y1, a[0], a[1], r);
    if (tc !== null && (best === null || tc < best)) best = tc;
    if (best === 0) return 0;
  }
  return best;
}

/** Distance from a point to a convex polygon (0 inside it) */
export function pointConvexDistance(poly: Vec2[], x: number, y: number): number {
  let inside = true, best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const px = x - a[0], py = y - a[1];
    if (ex * py - ey * px < 0) inside = false;
    const l2 = ex * ex + ey * ey;
    const u = l2 > 1e-12 ? Math.max(0, Math.min(1, (px * ex + py * ey) / l2)) : 0;
    const qx = px - ex * u, qy = py - ey * u;
    const d = qx * qx + qy * qy;
    if (d < best) best = d;
  }
  return inside ? 0 : Math.sqrt(best);
}

/** How far a point is outside a box (0 inside) */
function boxDistance(b: Box, x: number, y: number): number {
  const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
  const dy = y < b.minY ? b.minY - y : y > b.maxY ? y - b.maxY : 0;
  return dx === 0 ? dy : dy === 0 ? dx : Math.hypot(dx, dy);
}

/** How far a point is from a part's outline (0 inside it); Infinity if that's further than `within` */
export function partDistance(g: PlacedGeom, x: number, y: number, within = Infinity): number {
  if (boxDistance(g.bbox, x, y) > within) return Infinity;
  let best = Infinity;
  for (const c of g.convex) {
    const d = pointConvexDistance(c, x, y);
    if (d < best) best = d;
    if (best === 0) break;
  }
  return best;
}

/**
 * The first part (that `ok` lets be hit) a segment meets in grid space, `r`
 * thick (0: a line), and how far along it (0..1); null if it meets none.
 */
export function castParts(geoms: PlacedGeom[], ok: (i: number) => boolean, x0: number, y0: number, x1: number, y1: number, r = 0): { part: number; t: number } | null {
  let part = -1, best = Infinity;
  for (let i = 0; i < geoms.length; i++) {
    const g = geoms[i];
    // (Its box first: nothing in it can be met sooner than the box is)
    const tb = segmentBoxEntry(x0, y0, x1, y1, g.bbox, r);
    if (tb < 0 || tb >= best || !ok(i)) continue;
    for (const c of g.convex) {
      const t = r > 0 ? capsuleConvexEntry(c, x0, y0, x1, y1, r) : segmentConvexEntry(c, x0, y0, x1, y1);
      if (t !== null && t < best) { best = t; part = i; }
    }
  }
  return part < 0 ? null : { part, t: best };
}

/** Parts (that `ok` lets be hit) within `radius` of a point by their real outline, nearest first */
export function nearestParts(geoms: PlacedGeom[], ok: (i: number) => boolean, x: number, y: number, radius: number): { i: number; d: number }[] {
  const out: { i: number; d: number }[] = [];
  for (let i = 0; i < geoms.length; i++) {
    const d = partDistance(geoms[i], x, y, radius);
    if (d < radius && ok(i)) out.push({ i, d });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}
