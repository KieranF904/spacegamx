/**
 * Placed parts on the ship grid: absolute geometry, overlap and joins.
 * Joins are always derived from the grid; blueprints never store them.
 */

import type { Connector, PieceMount, PlacedPart, Side, Vec2 } from './types.js';
import { Catalog, LineEdge, PieceVariant, SIDE_NORMAL, connectorEndpoints, getVariant } from './catalog.js';
import { bounds, convexOverlap, cross, pointInConvex } from './geometry.js';
import { dhypot } from '../math/detTrig.js';

export interface PlacedGeom {
  part: PlacedPart;
  variant: PieceVariant;
  cells: Vec2[];
  polygon: Vec2[];
  convex: Vec2[][];
  convexShrunk: Vec2[][];
  lines: LineEdge[];
  connectors: Connector[];
  centroid: Vec2;
  area: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** A bespoke piece's mount, placed */
  mount?: PieceMount;
  /** A bespoke piece (joins what it touches) */
  bespoke?: boolean;
}

const add = (p: Vec2, x: number, y: number): Vec2 => [p[0] + x, p[1] + y];

export function placeGeometry(catalog: Catalog, part: PlacedPart): PlacedGeom {
  const v = getVariant(catalog, part.piece, part.rot, part.flip);
  const { x, y } = part;
  const polygon = v.polygon.map((p) => add(p, x, y));
  return {
    part,
    variant: v,
    cells: v.cells.map((c) => add(c, x, y)),
    polygon,
    convex: v.convex.map((c) => c.map((p) => add(p, x, y))),
    convexShrunk: v.convexShrunk.map((c) => c.map((p) => add(p, x, y))),
    lines: v.lines.map((l) => ({ a: add(l.a, x, y), b: add(l.b, x, y) })),
    connectors: v.connectors.map((c) => ({ ...c, cell: add(c.cell, x, y) })),
    centroid: add(v.centroid, x, y),
    area: v.area,
    bbox: bounds(polygon),
    ...(v.mount ? { mount: { ...v.mount, at: add(v.mount.at, x, y) } } : {}),
    ...(catalog.pieces.get(part.piece)?.bespoke ? { bespoke: true } : {}),
  };
}

/**
 * Where a part points out (engines, weapons, mining lasers, bays): the middle
 * of its business edge, the unit direction out of it, and the edge itself (as
 * unit-cell edges for a grid piece's facing, one edge for a bespoke mount).
 * Null when it has none.
 */
export interface PartMount { at: Vec2; dir: Vec2; edges: [Vec2, Vec2][] }
export function mountOf(g: PlacedGeom): PartMount | null {
  if (g.mount) {
    const { at, dir } = g.mount, h = (g.mount.width ?? 1) / 2, t: Vec2 = [-dir[1], dir[0]];
    return { at, dir, edges: [[[at[0] - t[0] * h, at[1] - t[1] * h], [at[0] + t[0] * h, at[1] + t[1] * h]]] };
  }
  const side = g.part.facing;
  if (!side) return null;
  const edges = facingEdges(g, side);
  if (!edges.length) return null;
  let ex = 0, ey = 0;
  for (const [a, b] of edges) { ex += (a[0] + b[0]) / 2; ey += (a[1] + b[1]) / 2; }
  return { at: [ex / edges.length, ey / edges.length], dir: SIDE_NORMAL[side], edges };
}

/** Bespoke parts join if an edge of one lies along an edge of the other for at least this much (cells), or they overlap */
const TOUCH = 0.2, TOUCH_GAP = 0.03;

function edgesTouch(a: Vec2[], b: Vec2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    const ex = q[0] - p[0], ey = q[1] - p[1], len = dhypot(ex, ey);
    if (len < TOUCH) continue;
    const ux = ex / len, uy = ey / len;
    for (let j = 0; j < b.length; j++) {
      const r = b[j], s = b[(j + 1) % b.length];
      // Both of b's ends on a's line, and a's stretch of it overlapping b's by TOUCH
      if (Math.abs(cross(ux, uy, r[0] - p[0], r[1] - p[1])) > TOUCH_GAP || Math.abs(cross(ux, uy, s[0] - p[0], s[1] - p[1])) > TOUCH_GAP) continue;
      const t0 = (r[0] - p[0]) * ux + (r[1] - p[1]) * uy, t1 = (s[0] - p[0]) * ux + (s[1] - p[1]) * uy;
      if (Math.min(len, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) >= TOUCH) return true;
    }
  }
  return false;
}

function bespokeTouch(a: PlacedGeom, b: PlacedGeom): boolean {
  if (a.bbox.maxX + TOUCH_GAP < b.bbox.minX || b.bbox.maxX + TOUCH_GAP < a.bbox.minX) return false;
  if (a.bbox.maxY + TOUCH_GAP < b.bbox.minY || b.bbox.maxY + TOUCH_GAP < a.bbox.minY) return false;
  return edgesTouch(a.polygon, b.polygon) || partsOverlap(a, b);
}

export function geomContainsPoint(g: PlacedGeom, x: number, y: number): boolean {
  return g.convex.some((c) => pointInConvex(c, x, y));
}

/** Exact overlap test on the shrunk convex pieces. */
export function partsOverlap(a: PlacedGeom, b: PlacedGeom): boolean {
  if (a.bbox.maxX <= b.bbox.minX || b.bbox.maxX <= a.bbox.minX) return false;
  if (a.bbox.maxY <= b.bbox.minY || b.bbox.maxY <= a.bbox.minY) return false;
  for (const ca of a.convexShrunk) {
    for (const cb of b.convexShrunk) {
      if (convexOverlap(ca, cb)) return true;
    }
  }
  return false;
}

/**
 * Pairs of parts that could touch: those in the same or neighbouring cells.
 * Returned sorted (i < j, lexicographic) so every caller sees the same order.
 */
export function candidatePairs(geoms: PlacedGeom[]): [number, number][] {
  const byCell = new Map<string, number[]>();
  geoms.forEach((g, i) => {
    for (const c of g.cells) {
      const k = `${c[0]},${c[1]}`;
      const list = byCell.get(k);
      if (list) list.push(i); else byCell.set(k, [i]);
    }
  });
  const seen = new Set<number>();
  const pairs: [number, number][] = [];
  geoms.forEach((g, i) => {
    for (const c of g.cells) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const j of byCell.get(`${c[0] + dx},${c[1] + dy}`) ?? []) {
            if (j <= i) continue;
            const key = i * 65536 + j;
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push([i, j]);
          }
        }
      }
    }
  });
  return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** Index pairs of parts that overlap each other. */
export function findOverlaps(geoms: PlacedGeom[]): [number, number][] {
  return candidatePairs(geoms).filter(([i, j]) => partsOverlap(geoms[i], geoms[j]));
}

/** Does `g` overlap any of `others` (skipping index `skip`)? */
export function overlapsAny(g: PlacedGeom, others: PlacedGeom[], skip = -1): boolean {
  return others.some((o, i) => i !== skip && partsOverlap(g, o));
}

function connectorKey(c: Connector): { key: string; normal: Vec2 | null } {
  if ('diag' in c) return { key: `D:${c.cell[0]},${c.cell[1]},${c.diag}`, normal: null };
  const [p, q] = connectorEndpoints(c);
  return { key: `E:${p[0]},${p[1]}:${q[0]},${q[1]}`, normal: SIDE_NORMAL[c.side] };
}

/**
 * Pairs of parts joined by a connector: the same cell edge from opposite
 * sides, or the same diagonal of the same cell. Sorted and de-duplicated.
 */
export function computeJoins(geoms: PlacedGeom[]): [number, number][] {
  const byKey = new Map<string, { i: number; normal: Vec2 | null }[]>();
  geoms.forEach((g, i) => {
    for (const c of g.connectors) {
      const { key, normal } = connectorKey(c);
      const list = byKey.get(key);
      if (list) list.push({ i, normal }); else byKey.set(key, [{ i, normal }]);
    }
  });
  const out = new Set<number>();
  for (const list of byKey.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b];
        if (A.i === B.i) continue;
        const opposite = A.normal === null || B.normal === null
          ? A.normal === B.normal
          : A.normal[0] === -B.normal[0] && A.normal[1] === -B.normal[1];
        if (!opposite) continue;
        out.add(Math.min(A.i, B.i) * 65536 + Math.max(A.i, B.i));
      }
    }
  }
  // Bespoke parts have no connectors: they hold on to whatever they touch
  if (geoms.some((g) => g.bespoke)) {
    for (const [i, j] of candidatePairs(geoms)) {
      if ((geoms[i].bespoke || geoms[j].bespoke) && bespokeTouch(geoms[i], geoms[j])) out.add(i * 65536 + j);
    }
  }
  return [...out].sort((a, b) => a - b).map((k) => [Math.floor(k / 65536), k % 65536]);
}

/**
 * Unit cell edges on the part's straight outline whose outward normal is `side`.
 * These are the edges a thruster or weapon "faces" out of.
 */
export function facingEdges(g: PlacedGeom, side: Side): [Vec2, Vec2][] {
  const n = SIDE_NORMAL[side];
  const out: [Vec2, Vec2][] = [];
  for (const l of g.lines) {
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1];
    // Axis-aligned and perpendicular to the normal
    if (dx * n[0] + dy * n[1] !== 0 || (dx !== 0 && dy !== 0)) continue;
    const len = Math.abs(dx + dy);
    const ux = Math.sign(dx), uy = Math.sign(dy);
    for (let k = 0; k < len; k++) {
      const a: Vec2 = [l.a[0] + ux * k, l.a[1] + uy * k];
      const b: Vec2 = [a[0] + ux, a[1] + uy];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      // Outward: just past the edge is outside the part, just before is inside
      if (!geomContainsPoint(g, mx + n[0] * 0.05, my + n[1] * 0.05) && geomContainsPoint(g, mx - n[0] * 0.05, my - n[1] * 0.05)) {
        out.push(a[0] < b[0] || a[1] < b[1] ? [a, b] : [b, a]);
      }
    }
  }
  return out;
}

/** Nothing else sits against this edge: no other part covers the space just outside it. */
export function isEdgeFree(geoms: PlacedGeom[], self: number, edge: [Vec2, Vec2], side: Side): boolean {
  const n = SIDE_NORMAL[side];
  const [a, b] = edge;
  const probes: Vec2[] = [0.1, 0.5, 0.9].map((t) => [
    a[0] + (b[0] - a[0]) * t + n[0] * 0.05,
    a[1] + (b[1] - a[1]) * t + n[1] * 0.05,
  ]);
  return geoms.every((g, i) => i === self || probes.every((p) => !geomContainsPoint(g, p[0], p[1])));
}
