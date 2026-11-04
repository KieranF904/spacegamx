/**
 * Terrain: a surface's rock (data/terrain/<surface>.json), solid scenery in
 * world units. Ships can't fly through it (collideTerrain, run inside the
 * shared physics step, so the server, a pilot's own prediction and everyone's
 * replicas push a ship out of it alike), and shots, beams and drones are
 * stopped by it (rayTerrain, insideTerrain).
 *
 * Each rock is a simple polygon; it's split into convex pieces, and the
 * pieces are filed in a coarse grid so a ship only tests the rock near it.
 * Pure and deterministic.
 */

import type { Vec2 } from './ships/types.js';
import { convexDecompose, normalizePolygon } from './ships/geometry.js';
import { dhypot } from './math/detTrig.js';

export interface TerrainFile {
  _comment?: string;
  /** Boulders and pillars: each one's outline (world units), solid */
  rocks: Vec2[][];
  /** A valley's outline (its cliffs' foot), and at each point the way into the rock (look only: the cliffs drawn along it) */
  cliff?: Vec2[];
  cliffIn?: Vec2[];
  /** The rock mass along the valley, as triangles: solid */
  mass?: Vec2[][];
  /** Rock further off: drawn only (nothing can reach it) */
  fill?: Vec2[][];
  /** Lava running over the floor: each a line of points and its width at each (look only) */
  streams?: { pts: Vec2[]; w: number[] }[];
  /** Openings into the dark (a cave's mouth): drawn only, black, falling away */
  holes?: Vec2[][];
  /** Ridges of rock (look only: put their footprint in `mass` to make them solid): each a line along its crest, and its half-width and height at each point */
  ridges?: { pts: Vec2[]; w: number[]; h: number[] }[];
}

interface Piece { pts: number[]; x0: number; y0: number; x1: number; y1: number }

export interface Terrain {
  /** Each rock as given (for drawing) */
  rocks: Vec2[][];
  /** The file as given (the cliffs, mass and fill, for drawing) */
  file: TerrainFile;
  pieces: Piece[];
  /** Grid cell → the pieces touching it */
  grid: Map<number, number[]>;
}

const CELL = 2000;
const key = (cx: number, cy: number) => (cx + 4096) * 8192 + (cy + 4096);

export function buildTerrain(file: TerrainFile): Terrain {
  const pieces: Piece[] = [];
  const grid = new Map<number, number[]>();
  for (const rock of [...file.rocks, ...(file.mass ?? [])]) {
    if (rock.length < 3) continue;
    for (const c of convexDecompose(normalizePolygon(rock.map(([x, y]) => [x, y] as Vec2)))) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const pts: number[] = [];
      for (const [x, y] of c) { pts.push(x, y); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const k = pieces.push({ pts, x0, y0, x1, y1 }) - 1;
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const list = grid.get(key(cx, cy));
          if (list) list.push(k); else grid.set(key(cx, cy), [k]);
        }
      }
    }
  }
  return { rocks: file.rocks, file, pieces, grid };
}

/** The pieces whose boxes come within `pad` of the box (x0, y0)-(x1, y1), each once, in order */
function near(t: Terrain, x0: number, y0: number, x1: number, y1: number, pad: number): number[] {
  const out = new Set<number>();
  for (let cx = Math.floor((x0 - pad) / CELL); cx <= Math.floor((x1 + pad) / CELL); cx++) {
    for (let cy = Math.floor((y0 - pad) / CELL); cy <= Math.floor((y1 + pad) / CELL); cy++) {
      for (const k of t.grid.get(key(cx, cy)) ?? []) {
        const p = t.pieces[k];
        if (p.x1 < x0 - pad || p.x0 > x1 + pad || p.y1 < y0 - pad || p.y0 > y1 + pad) continue;
        out.add(k);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * A circle against one convex piece (counter-clockwise or clockwise alike):
 * how far it's in, and the way out, or null when it's clear
 */
function circleOut(p: Piece, x: number, y: number, r: number): { depth: number; nx: number; ny: number } | null {
  const pts = p.pts, n = pts.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
  const sgn = area >= 0 ? 1 : -1;
  // The edge the centre is furthest outside of (or least inside of)
  let best = -Infinity, bnx = 0, bny = 0, inside = true;
  let cd = Infinity, cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = pts[i * 2], ay = pts[i * 2 + 1], ex = pts[j * 2] - ax, ey = pts[j * 2 + 1] - ay, l = dhypot(ex, ey) || 1;
    // outward normal
    const nx = (ey / l) * sgn, ny = (-ex / l) * sgn;
    const d = (x - ax) * nx + (y - ay) * ny;
    if (d > 0) inside = false;
    if (d > best) { best = d; bnx = nx; bny = ny; }
    // the nearest point of this edge
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (l * l)));
    const qx = ax + ex * t, qy = ay + ey * t, qd = dhypot(x - qx, y - qy);
    if (qd < cd) { cd = qd; cx = qx; cy = qy; }
  }
  if (inside) return { depth: r - best, nx: bnx, ny: bny };
  if (cd >= r) return null;
  const l = cd || 1;
  return { depth: r - cd, nx: (x - cx) / l, ny: (y - cy) / l };
}

/**
 * Push a ship (a circle `r` across, at the body's place) out of the rock, and
 * take away the part of its velocity going into it (a little bounce). True if
 * it touched. Run inside the physics step, before the body's rounded.
 */
export function collideTerrain(body: { x: number; y: number; vx: number; vy: number }, r: number, t: Terrain | null | undefined): boolean {
  if (!t || !t.pieces.length) return false;
  let hit = false;
  // A few passes: being pushed out of one piece may push it into the next
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const k of near(t, body.x, body.y, body.x, body.y, r)) {
      const o = circleOut(t.pieces[k], body.x, body.y, r);
      if (!o || o.depth <= 0) continue;
      body.x += o.nx * o.depth;
      body.y += o.ny * o.depth;
      const vn = body.vx * o.nx + body.vy * o.ny;
      if (vn < 0) { body.vx -= o.nx * vn * 1.2; body.vy -= o.ny * vn * 1.2; }
      hit = moved = true;
    }
    if (!moved) break;
  }
  return hit;
}

/** How far along (x0, y0) → (x1, y1) it first meets rock: 0..1, or 1 when it's clear */
export function rayTerrain(t: Terrain | null | undefined, x0: number, y0: number, x1: number, y1: number): number {
  if (!t || !t.pieces.length) return 1;
  let best = 1;
  const dx = x1 - x0, dy = y1 - y0;
  for (const k of near(t, Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), 0)) {
    const pts = t.pieces[k].pts, n = pts.length / 2;
    let area = 0;
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1]; }
    const sgn = area >= 0 ? 1 : -1;
    // Cyrus–Beck: where the segment is inside every edge
    let te = 0, tx = 1, ok = true;
    for (let i = 0; i < n && ok; i++) {
      const j = (i + 1) % n, ax = pts[i * 2], ay = pts[i * 2 + 1], ex = pts[j * 2] - ax, ey = pts[j * 2 + 1] - ay;
      const nx = ey * sgn, ny = -ex * sgn;
      const num = (x0 - ax) * nx + (y0 - ay) * ny, den = dx * nx + dy * ny;
      if (Math.abs(den) < 1e-12) { if (num > 0) ok = false; continue; }
      const tt = -num / den;
      if (den < 0) te = Math.max(te, tt); else tx = Math.min(tx, tt);
      if (te > tx) ok = false;
    }
    if (ok && te < best) best = te;
  }
  return best;
}

/** Is a circle `r` across at (x, y) touching rock */
export function insideTerrain(t: Terrain | null | undefined, x: number, y: number, r = 0): boolean {
  if (!t) return false;
  for (const k of near(t, x, y, x, y, r)) {
    const o = circleOut(t.pieces[k], x, y, Math.max(r, 0.001));
    if (o && o.depth > 0) return true;
  }
  return false;
}

/** A ship's collision circle against terrain: most of its bounding radius (its outline is ragged, its middle solid) */
export const terrainRadius = (shipRadius: number) => Math.max(20, shipRadius * 0.72);
