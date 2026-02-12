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
): Point2D[] {
  const rng = mulberry32(hashString(`asteroid:${asteroidId}`));
  const numPoints = 8 + Math.floor(rng() * 5); // 8-12 vertices
  const points: Point2D[] = [];

  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;
    const variance = 0.6 + rng() * 0.4; // 60-100% of radius
    const r = size * variance;
    points.push({
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    });
  }

  return points;
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
