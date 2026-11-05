/**
 * 2D geometry for ship pieces (grid units, y down).
 *
 * Polygons are arrays of points with positive signed area (shoelace sum > 0),
 * which is clockwise on screen because y points down. Everything here is pure
 * and deterministic.
 */

import type { Segment, Vec2 } from './types.js';
import { dcos, dhypot, dsin } from '../math/detTrig.js';

const DEG = Math.PI / 180;
export const EPS = 1e-9;

/**
 * Math.hypot(dx, dy) < r and > r, decided exactly as hypot decides them but without its cost (for loops that ask it
 * of every body or row): the squared distance settles it unless it's within a hair of r², and only then is hypot
 * asked. (NaN is never nearer nor farther, as with hypot.)
 */
export function nearerThan(dx: number, dy: number, r: number): boolean {
  const q = dx * dx + dy * dy, r2 = r * r;
  if (q < r2 * (1 - 1e-9)) return true;
  if (q > r2 * (1 + 1e-9)) return false;
  return dhypot(dx, dy) < r;
}
export function fartherThan(dx: number, dy: number, r: number): boolean {
  const q = dx * dx + dy * dy, r2 = r * r;
  if (q > r2 * (1 + 1e-9)) return true;
  if (q < r2 * (1 - 1e-9)) return false;
  return dhypot(dx, dy) > r;
}

export function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

/** Round away float noise from trig so grid points stay exact (e.g. cos(90°) → 0). */
export function snap(v: number): number {
  const r = Math.round(v * 1e9) / 1e9;
  return r === 0 ? 0 : r;
}

export function arcPoint(c: Vec2, r: number, deg: number): Vec2 {
  return [snap(c[0] + r * dcos(deg * DEG)), snap(c[1] + r * dsin(deg * DEG))];
}

export function segmentStart(s: Segment): Vec2 {
  return s.type === 'line' ? s.a : arcPoint(s.c, s.r, s.a0);
}

export function segmentEnd(s: Segment): Vec2 {
  return s.type === 'line' ? s.b : arcPoint(s.c, s.r, s.a1);
}

/**
 * Turn an outline into a polygon. Arc vertices sit on an absolute angle grid
 * (90 / segsPerQuarter degrees), so two pieces flattening the same arc in
 * opposite directions produce identical vertices.
 */
export function flattenOutline(outline: Segment[], segsPerQuarter = 8): Vec2[] {
  const pts: Vec2[] = [];
  const step = 90 / segsPerQuarter;
  for (const s of outline) {
    if (s.type === 'line') {
      pts.push(s.b);
    } else {
      const dir = s.a1 >= s.a0 ? 1 : -1;
      const n = Math.round(Math.abs(s.a1 - s.a0) / step);
      for (let i = 1; i <= n; i++) pts.push(arcPoint(s.c, s.r, s.a0 + dir * i * step));
    }
  }
  return normalizePolygon(pts);
}

/** Remove duplicate and collinear vertices and make the orientation positive. */
export function normalizePolygon(input: Vec2[]): Vec2[] {
  let pts = input.filter((p, i) => {
    const q = input[(i + input.length - 1) % input.length];
    return Math.abs(p[0] - q[0]) > EPS || Math.abs(p[1] - q[1]) > EPS;
  });
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      if (Math.abs(cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1])) < 1e-12) {
        pts.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (signedArea(pts) < 0) pts = pts.reverse();
  return pts;
}

export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Exact signed area of an outline (lines and true circular arcs), via Green's theorem. */
export function outlineArea(outline: Segment[]): number {
  let a = 0;
  for (const s of outline) {
    if (s.type === 'line') {
      a += (s.a[0] * s.b[1] - s.b[0] * s.a[1]) / 2;
    } else {
      const t0 = s.a0 * DEG;
      const t1 = s.a1 * DEG;
      const [cx, cy] = s.c;
      a += 0.5 * (s.r * cx * (dsin(t1) - dsin(t0)) - s.r * cy * (dcos(t1) - dcos(t0)) + s.r * s.r * (t1 - t0));
    }
  }
  return a;
}

export function polygonCentroid(pts: Vec2[]): Vec2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const w = p[0] * q[1] - q[0] * p[1];
    a += w;
    cx += (p[0] + q[0]) * w;
    cy += (p[1] + q[1]) * w;
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}

/** Polar second moment of area ∫(x²+y²)dA about the origin. */
export function polygonPolarMomentOrigin(pts: Vec2[]): number {
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const w = x0 * y1 - x1 * y0;
    j += w * (x0 * x0 + x0 * x1 + x1 * x1 + y0 * y0 + y0 * y1 + y1 * y1);
  }
  return j / 12;
}

/** Polar second moment of area about the polygon's own centroid. */
export function polygonPolarMomentCentroid(pts: Vec2[]): number {
  const a = signedArea(pts);
  const c = polygonCentroid(pts);
  return polygonPolarMomentOrigin(pts) - a * (c[0] * c[0] + c[1] * c[1]);
}

export function isConvex(pts: Vec2[]): boolean {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    if (cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]) < -1e-12) return false;
  }
  return true;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]);
  const d2 = cross(c[0] - b[0], c[1] - b[1], p[0] - b[0], p[1] - b[1]);
  const d3 = cross(a[0] - c[0], a[1] - c[1], p[0] - c[0], p[1] - c[1]);
  return d1 >= -EPS && d2 >= -EPS && d3 >= -EPS;
}

/** Ear-clip a simple positive-orientation polygon into triangles (as vertex index triples). */
function triangulate(pts: Vec2[]): number[][] {
  const idx = pts.map((_, i) => i);
  const tris: number[][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length];
      const ib = idx[i];
      const ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]) <= 1e-12) continue;
      let blocked = false;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (pointInTriangle(pts[j], a, b, c)) { blocked = true; break; }
      }
      if (blocked) continue;
      tris.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('triangulate: polygon is not simple');
  }
  tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

/**
 * Split a simple polygon into convex pieces: ear-clip, then merge neighbouring
 * pieces across shared diagonals while the result stays convex (Hertel–Mehlhorn).
 */
export function convexDecompose(pts: Vec2[]): Vec2[][] {
  if (isConvex(pts)) return [pts];
  let polys = triangulate(pts);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < polys.length; i++) {
      for (let j = i + 1; j < polys.length; j++) {
        const m = mergeAcrossEdge(polys[i], polys[j]);
        if (m && isConvex(m.map((k) => pts[k]))) {
          polys[i] = m;
          polys.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return polys.map((p) => p.map((k) => pts[k]));
}

/** If A and B share an edge (u→v in A, v→u in B), return the merged index loop. */
function mergeAcrossEdge(a: number[], b: number[]): number[] | null {
  for (let i = 0; i < a.length; i++) {
    const u = a[i];
    const v = a[(i + 1) % a.length];
    const j = b.indexOf(v);
    if (j < 0 || b[(j + 1) % b.length] !== u) continue;
    // Walk A from v round to u, then B from u (exclusive) round to v (exclusive)
    const out: number[] = [];
    for (let k = 0; k < a.length; k++) out.push(a[(i + 1 + k) % a.length]);
    for (let k = 2; k < b.length; k++) out.push(b[(j + k) % b.length]);
    return out;
  }
  return null;
}

/** Keep the part of a convex polygon where nx*x + ny*y <= d (Sutherland–Hodgman, one plane). */
export function clipHalfPlane(poly: Vec2[], nx: number, ny: number, d: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const dp = nx * p[0] + ny * p[1] - d;
    const dq = nx * q[0] + ny * q[1] - d;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Inward offset of a convex polygon. Returns null when it collapses. */
export function shrinkConvex(poly: Vec2[], amount: number): Vec2[] | null {
  let out = poly;
  for (let i = 0; i < poly.length && out.length >= 3; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = dhypot(ex, ey);
    // Interior is where cross(e, p - a) > 0; keep cross(e, p - a) >= amount * len
    // cross(e, p) = ex*py - ey*px  →  ey*px - ex*py <= -amount*len + (ey*ax - ex*ay)
    out = clipHalfPlane(out, ey, -ex, ey * a[0] - ex * a[1] - amount * len);
  }
  if (out.length < 3 || signedArea(out) < 1e-6) return null;
  return out;
}

/** Area of a convex polygon inside the axis-aligned box. */
export function convexAreaInBox(poly: Vec2[], x0: number, y0: number, x1: number, y1: number): number {
  let p = clipHalfPlane(poly, 1, 0, x1);
  p = clipHalfPlane(p, -1, 0, -x0);
  p = clipHalfPlane(p, 0, 1, y1);
  p = clipHalfPlane(p, 0, -1, -y0);
  return p.length >= 3 ? signedArea(p) : 0;
}

function project(poly: Vec2[], ax: number, ay: number): [number, number] {
  let min = Infinity, max = -Infinity;
  for (const p of poly) {
    const d = p[0] * ax + p[1] * ay;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return [min, max];
}

/** Separating axis test for two convex polygons. True when they overlap. */
export function convexOverlap(a: Vec2[], b: Vec2[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const ax = q[1] - p[1], ay = p[0] - q[0];
      const [amin, amax] = project(a, ax, ay);
      const [bmin, bmax] = project(b, ax, ay);
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}

export function pointInConvex(poly: Vec2[], x: number, y: number): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (cross(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1]) < 0) return false;
  }
  return true;
}

/** Segment p0→p1 vs convex polygon: smallest t in [0,1] where the segment is inside, or null. */
export function segmentConvexEntry(poly: Vec2[], x0: number, y0: number, x1: number, y1: number): number | null {
  // Cyrus–Beck: clip the parametric segment against every edge half-plane
  let tEnter = 0, tExit = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    // inside when cross(e, p - a) >= 0
    const num = cross(ex, ey, x0 - a[0], y0 - a[1]);
    const den = cross(ex, ey, dx, dy);
    if (Math.abs(den) < 1e-12) {
      if (num < 0) return null;
      continue;
    }
    const t = -num / den;
    if (den > 0) { if (t > tEnter) tEnter = t; }
    else { if (t < tExit) tExit = t; }
    if (tEnter > tExit) return null;
  }
  return tEnter;
}

export function bounds(pts: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * SAT with the minimum-penetration axis. Returns null when separated, otherwise
 * the overlap depth and a unit normal pointing from `a` towards `b`.
 */
export function convexPenetration(a: Vec2[], b: Vec2[]): { depth: number; nx: number; ny: number } | null {
  let best = Infinity, bx = 0, by = 0;
  for (let k = 0; k < 2; k++) {
    const poly = k === 0 ? a : b;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      let ax = q[1] - p[1], ay = p[0] - q[0];
      const len = Math.sqrt(ax * ax + ay * ay); // (not Math.hypot: the same bits in every engine, ships/debris.ts)
      if (len < 1e-12) continue;
      ax /= len; ay /= len;
      // Both projections, inline (this runs for every pair of touching pieces: no arrays)
      let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (let j = 0; j < a.length; j++) {
        const d = a[j][0] * ax + a[j][1] * ay;
        if (d < amin) amin = d;
        if (d > amax) amax = d;
      }
      for (let j = 0; j < b.length; j++) {
        const d = b[j][0] * ax + b[j][1] * ay;
        if (d < bmin) bmin = d;
        if (d > bmax) bmax = d;
      }
      const overlap = Math.min(amax, bmax) - Math.max(amin, bmin);
      if (overlap <= 0) return null;
      if (overlap < best) {
        best = overlap;
        // Orient from a to b
        const flip = (amin + amax) / 2 > (bmin + bmax) / 2;
        bx = flip ? -ax : ax;
        by = flip ? -ay : ay;
      }
    }
  }
  return { depth: best, nx: bx, ny: by };
}
