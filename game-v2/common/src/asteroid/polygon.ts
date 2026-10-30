/**
 * Shared asteroid polygon generation and ray intersection utilities.
 *
 * Used by BOTH server (for authoritative collision) and client (for
 * deterministic rendering + local laser hitscan).  Every function in
 * this module is pure — no side effects, no state — so calling it with
 * the same arguments always gives the same result.
 */

// ── PRNG helpers ────────────────────────────────────────────────────

/** FNV-1a hash — turns a string into a 32-bit unsigned seed. */
export function hashString(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 seeded PRNG — returns a function that yields [0, 1). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Asteroid polygon ────────────────────────────────────────────────

export interface Point2D {
  x: number;
  y: number;
}

/**
 * Generate the collision / render polygon for an asteroid.
 *
 * The polygon is deterministic — given the same `asteroidId` and `size`
 * it always produces identical vertices.  Pass `cx,cy = 0` when you
 * want local-space vertices (for rendering), or pass the asteroid's
 * world position to get world-space vertices (for hitscan).
 *
 * @param asteroidId  Entity id — used to seed the PRNG.
 * @param cx          Centre X (world or 0).
 * @param cy          Centre Y (world or 0).
 * @param size        Asteroid radius (Asteroid.size[eid]).
 * @returns           Array of vertices forming a closed polygon.
 */
export function getAsteroidPolygon(
  asteroidId: number,
  cx: number,
  cy: number,
  size: number,
  angle = 0,
): Point2D[] {
  // The shape around its centre depends only on the id and size: worked out once
  let shape = shapeCache.get(asteroidId);
  if (!shape || shape.size !== size) {
    const rng = mulberry32(hashString(`asteroid:${asteroidId}`));
    const numPoints = 8 + Math.floor(rng() * 5); // 8-12 vertices
    const dx = new Float64Array(numPoints), dy = new Float64Array(numPoints);
    for (let i = 0; i < numPoints; i++) {
      const angle = (i / numPoints) * Math.PI * 2;
      const variance = 0.6 + rng() * 0.4; // 60-100% of radius (so it lies within `size` of the centre)
      const r = size * variance;
      dx[i] = Math.cos(angle) * r;
      dy[i] = Math.sin(angle) * r;
    }
    shape = { size, dx, dy };
    shapeCache.set(asteroidId, shape);
  }
  const points: Point2D[] = new Array(shape.dx.length);
  if (angle === 0) {
    for (let i = 0; i < points.length; i++) points[i] = { x: cx + shape.dx[i], y: cy + shape.dy[i] };
    return points;
  }
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < points.length; i++) points[i] = { x: cx + shape.dx[i] * c - shape.dy[i] * s, y: cy + shape.dx[i] * s + shape.dy[i] * c };
  return points;
}

/**
 * How far an asteroid has turned at a tick: a slow, steady spin (one turn in
 * 35 s to 3 min, either way) set by its id, so the server's outline and the
 * rock the client draws always agree
 */
export function asteroidSpin(asteroidId: number, tick: number): number {
  let spin = spinCache.get(asteroidId);
  if (!spin) {
    const rng = mulberry32(hashString(`spin:${asteroidId}`));
    const phase = rng() * Math.PI * 2;
    const rate = (0.0006 + rng() * 0.0024) * (rng() < 0.5 ? -1 : 1);
    spinCache.set(asteroidId, (spin = { phase, rate }));
  }
  return (spin.phase + spin.rate * tick) % (Math.PI * 2);
}

const spinCache = new Map<number, { phase: number; rate: number }>();

/** Asteroid outlines around their centres, by id (see getAsteroidPolygon) */
const shapeCache = new Map<number, { size: number; dx: Float64Array; dy: Float64Array }>();

/**
 * Can a segment come within `r` of a point? Asteroid outlines lie within
 * their size of their centre, so a shot or beam that can't is no hit (and
 * skips the edge tests). A hair of slack keeps rounding from ever ruling out
 * a real hit.
 */
export function segmentNearCircle(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const u = len2 > 0 ? Math.max(0, Math.min(1, ((cx - x0) * dx + (cy - y0) * dy) / len2)) : 0;
  const ex = x0 + dx * u - cx, ey = y0 + dy * u - cy;
  const lim = r * (1 + 1e-9) + 1e-6;
  return ex * ex + ey * ey <= lim * lim;
}

// ── Ray / segment intersection ──────────────────────────────────────

/** 2D cross product of vectors (ax,ay) and (bx,by). */
export function cross2(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/**
 * Segment–segment intersection test.
 *
 * Tests the segment A→B against segment C→D.
 * Returns the parametric `t` along A→B (0 ≤ t ≤ 1) if they intersect,
 * or `null` if they don't.
 */
export function segmentIntersectT(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): number | null {
  const rX = bx - ax;
  const rY = by - ay;
  const sX = dx - cx;
  const sY = dy - cy;
  const denom = cross2(rX, rY, sX, sY);
  if (Math.abs(denom) < 1e-9) return null;
  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = cross2(qpx, qpy, sX, sY) / denom;
  const u = cross2(qpx, qpy, rX, rY) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
  return null;
}

/**
 * Point-in-polygon test (ray-casting algorithm).
 */
export function pointInPolygon(x: number, y: number, poly: Point2D[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Cast a ray from (startX,startY) → (endX,endY) against every edge
 * of the given polygon.  Returns the smallest parametric `t` (0–1)
 * where a hit occurs, or `null` if no edge is intersected.
 */
export function raycastPolygon(
  startX: number, startY: number,
  endX: number, endY: number,
  poly: Point2D[],
): number | null {
  let best: number | null = null;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    const t = segmentIntersectT(startX, startY, endX, endY, p1.x, p1.y, p2.x, p2.y);
    if (t !== null && (best === null || t < best)) {
      best = t;
    }
  }
  return best;
}
