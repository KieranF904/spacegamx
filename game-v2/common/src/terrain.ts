/**
 * Terrain: a surface's rock (data/terrain/<surface>.json), solid scenery in
 * world units. Ships can't fly through it (collideTerrainHull, run inside the
 * shared physics step, so the server, a pilot's own prediction and everyone's
 * replicas push a ship out of it alike: its hull's real pieces against the
 * rock's, no circle), and shots, beams and drones are stopped by it
 * (rayTerrain, insideTerrain).
 *
 * Each rock is a simple polygon; it's split into convex pieces, and the
 * pieces are filed in a coarse grid so a ship only tests the rock near it.
 * Pure and deterministic.
 */

import type { Vec2 } from './ships/types.js';
import { convexDecompose, normalizePolygon } from './ships/geometry.js';
import type { ShipHull } from './ships/contact.js';
import { dcos, dhypot, dsin } from './math/detTrig.js';

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
  /** A boss arena's barrier (world/gates.ts, from systems.json `arena`): solid both ways, drawn as a shimmer, not rock */
  gates?: Vec2[][];
  /** A station chamber's walls (gunRange/layout.ts, from systems.json `gunRange`): solid both ways, drawn as the chamber's own look, not as rock */
  walls?: Vec2[][];
  /**
   * More outlines like `cliff` (look only), for rock in several pieces or open ground in several places (a hollowed
   * asteroid: its shell and its core): each with the way into the rock at every point, and how deep the rock goes there
   * (its drawn top stops there, so walls between two chambers meet in the middle)
   */
  cliffs?: { pts: Vec2[]; in: Vec2[]; depth?: number[] }[];
  /** The rock's colours (look only: CSS hex), instead of the cavern's: its foot, its face, its top, rock further off */
  palette?: { foot: string; face: string; top: string; far: string; floor?: string };
  /** The floor under open ground inside the rock (look only: a hollowed asteroid's chambers), drawn under everything */
  floor?: Vec2[][];
  /** Things in and on the rock that aren't rock (look only: client rendering/DenDressing.ts) */
  dressing?: {
    /** Work lamps on the walls */
    lamps?: Vec2[];
    /** Cables slung across chambers */
    cables?: Vec2[][];
    /** Glowing veins in the rock's cracks */
    veins?: Vec2[][];
    /** Conveyor belts, running the way their points go */
    belts?: { pts: Vec2[]; w: number }[];
    /** Plates welded over the rock */
    plates?: Vec2[][];
    /** Rust bleeding down the rock (wide faint streaks) */
    rust?: Vec2[][];
  };
}

interface Piece {
  pts: Float64Array; x0: number; y0: number; x1: number; y1: number;
  /** Per edge (from corner i to i + 1): 1 if it's the rock's face, 0 if another piece lies against it (a seam inside the rock) */
  face: Uint8Array;
}

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
  for (const rock of [...file.rocks, ...(file.mass ?? []), ...(file.gates ?? []), ...(file.walls ?? [])]) {
    if (rock.length < 3) continue;
    for (const c of convexDecompose(normalizePolygon(rock.map(([x, y]) => [x, y] as Vec2)))) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const pts: number[] = [];
      for (const [x, y] of c) { pts.push(x, y); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const k = pieces.push({ pts: Float64Array.from(pts), x0, y0, x1, y1, face: new Uint8Array(c.length) }) - 1;
      for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
        for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
          const list = grid.get(key(cx, cy));
          if (list) list.push(k); else grid.set(key(cx, cy), [k]);
        }
      }
    }
  }
  // (The seams: an edge two pieces share (a convex split's diagonal, mass triangles side by side) is inside the rock, and
  // no way out of it: pushing a hull across a seam only puts it into the piece beyond)
  const edge = (P: Piece, i: number) => {
    const n = P.pts.length / 2, j = (i + 1) % n, r = (v: number) => Math.round(v * 1000);
    const a = r(P.pts[i * 2]) + ',' + r(P.pts[i * 2 + 1]), b = r(P.pts[j * 2]) + ',' + r(P.pts[j * 2 + 1]);
    return a < b ? a + ';' + b : b + ';' + a;
  };
  const uses = new Map<string, number>();
  for (const P of pieces) for (let i = 0; i < P.face.length; i++) { const e = edge(P, i); uses.set(e, (uses.get(e) ?? 0) + 1); }
  for (const P of pieces) for (let i = 0; i < P.face.length; i++) P.face[i] = uses.get(edge(P, i))! > 1 ? 0 : 1;
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

/**
 * A hull's piece (`hn` corners from H[ho]) into a rock piece: clear if any edge of either separates them (SAT); else
 * the way out, through one of the rock's faces: the face the hull's piece is least far behind, and how far (a seam is
 * no way out, and nor is the far side of the rock: each face is left only outwards). Its depth and the face's outward
 * unit normal; a piece with no face (deep in the rock) by the least overlap of all its edges. Null if clear
 */
function intoRock(H: Float64Array, ho: number, hn: number, P: Piece): { depth: number; nx: number; ny: number } | null {
  const R = P.pts, rn = R.length / 2;
  let area = 0;
  for (let i = 0; i < rn; i++) { const j = (i + 1) % rn; area += R[i * 2] * R[j * 2 + 1] - R[j * 2] * R[i * 2 + 1]; }
  const sgn = area >= 0 ? 1 : -1;
  let best = Infinity, bx = 0, by = 0, any = Infinity, ax0 = 0, ay0 = 0;
  for (let k = 0; k < 2; k++) {
    const A = k === 0 ? H : R, o = k === 0 ? ho : 0, n = k === 0 ? hn : rn;
    for (let i = 0; i < n; i++) {
      const p = o + i * 2, q = o + ((i + 1) % n) * 2;
      let ax = A[q + 1] - A[p + 1], ay = A[p] - A[q];
      const len = Math.sqrt(ax * ax + ay * ay);
      if (len < 1e-12) continue;
      ax /= len; ay /= len;
      let hmin = Infinity, hmax = -Infinity, rmin = Infinity, rmax = -Infinity;
      for (let j = 0, m = ho; j < hn; j++, m += 2) { const d = H[m] * ax + H[m + 1] * ay; if (d < hmin) hmin = d; if (d > hmax) hmax = d; }
      for (let j = 0, m = 0; j < rn; j++, m += 2) { const d = R[m] * ax + R[m + 1] * ay; if (d < rmin) rmin = d; if (d > rmax) rmax = d; }
      const overlap = Math.min(hmax, rmax) - Math.max(hmin, rmin);
      if (overlap <= 0) return null;
      if (overlap < any) { const flip = (hmin + hmax) / 2 > (rmin + rmax) / 2; any = overlap; ax0 = flip ? ax : -ax; ay0 = flip ? ay : -ay; }
      if (k === 1 && P.face[i]) {
        // (Out through this face: its outward normal, and how far the hull's piece lies behind it)
        const ox = ax * sgn, oy = ay * sgn, off = R[p] * ox + R[p + 1] * oy;
        let lo = Infinity;
        for (let j = 0, m = ho; j < hn; j++, m += 2) { const d = H[m] * ox + H[m + 1] * oy; if (d < lo) lo = d; }
        const depth = off - lo;
        if (depth < best) { best = depth; bx = ox; by = oy; }
      }
    }
  }
  return best < Infinity ? { depth: best, nx: bx, ny: by } : { depth: any, nx: ax0, ny: ay0 };
}

/** A hull placed at a pose (collideTerrainHull): its corners, and each piece's box [x0, y0, x1, y1] (scratch, reused) */
let HULL = new Float64Array(256), BOX = new Float64Array(64);

/**
 * Push a ship out of the rock by its hull (ShipDerived.hull: its alive parts' real pieces, not a circle), and take away
 * the part of its velocity going into it (a little bounce). True if it touched. Rock near enough to matter is what
 * lies within its bounding radius (`radius`); for each such piece, the hull's piece deepest into it pushes the ship
 * out along the way out of it. A few passes (being pushed out of one piece may push it into the next). Run inside the
 * physics step, before the body's rounded: the same on every side
 */
export function collideTerrainHull(body: { x: number; y: number; vx: number; vy: number; angle: number }, hull: ShipHull, radius: number, t: Terrain | null | undefined): boolean {
  if (!t || !t.pieces.length || !hull.n.length) return false;
  let hit = false, placed = false;
  const n = hull.n, lp = hull.pts;
  let hx0 = 0, hy0 = 0, hx1 = 0, hy1 = 0;
  for (let pass = 0; pass < 3; pass++) {
    const rocks = near(t, body.x, body.y, body.x, body.y, radius);
    if (!rocks.length) break;
    if (!placed) {
      // (Placed once, as contacts place pieces (ships/contact.ts); each push then moves it with the body)
      placed = true;
      if (HULL.length < lp.length) HULL = new Float64Array(lp.length * 2);
      if (BOX.length < n.length * 4) BOX = new Float64Array(n.length * 8);
      const phi = body.angle + Math.PI / 2, c = dcos(phi), s = dsin(phi), px = body.x, py = body.y;
      hx0 = hy0 = Infinity; hx1 = hy1 = -Infinity;
      for (let q = 0, k = 0; q < n.length; q++) {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let j = 0; j < n[q]; j++, k += 2) {
          const lx = lp[k], ly = lp[k + 1];
          const wx = px + lx * c - ly * s, wy = py + lx * s + ly * c;
          HULL[k] = wx; HULL[k + 1] = wy;
          if (wx < x0) x0 = wx;
          if (wx > x1) x1 = wx;
          if (wy < y0) y0 = wy;
          if (wy > y1) y1 = wy;
        }
        BOX[q * 4] = x0; BOX[q * 4 + 1] = y0; BOX[q * 4 + 2] = x1; BOX[q * 4 + 3] = y1;
        if (x0 < hx0) hx0 = x0;
        if (y0 < hy0) hy0 = y0;
        if (x1 > hx1) hx1 = x1;
        if (y1 > hy1) hy1 = y1;
      }
    }
    let moved = false;
    for (const r of rocks) {
      const P = t.pieces[r];
      if (P.x1 < hx0 || P.x0 > hx1 || P.y1 < hy0 || P.y0 > hy1) continue;
      // The hull's piece deepest into this rock, and the way out of it
      let depth = 0, nx = 0, ny = 0;
      for (let q = 0, k = 0; q < n.length; k += n[q] * 2, q++) {
        if (BOX[q * 4 + 2] < P.x0 || BOX[q * 4] > P.x1 || BOX[q * 4 + 3] < P.y0 || BOX[q * 4 + 1] > P.y1) continue;
        const pen = intoRock(HULL, k, n[q], P);
        if (pen && pen.depth > depth) { depth = pen.depth; nx = pen.nx; ny = pen.ny; }
      }
      if (!(depth > 0)) continue;
      // Out of it, the hull moved with the body
      const dx = nx * depth, dy = ny * depth;
      body.x += dx; body.y += dy;
      for (let k = 0; k < lp.length; k += 2) { HULL[k] += dx; HULL[k + 1] += dy; }
      for (let q = 0; q < n.length; q++) { BOX[q * 4] += dx; BOX[q * 4 + 2] += dx; BOX[q * 4 + 1] += dy; BOX[q * 4 + 3] += dy; }
      hx0 += dx; hx1 += dx; hy0 += dy; hy1 += dy;
      const vn = body.vx * nx + body.vy * ny;
      if (vn < 0) { body.vx -= nx * vn * 1.2; body.vy -= ny * vn * 1.2; }
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

/**
 * Most of a ship's bounding radius: a circle for keeping clear of rock (where to put a ship, an arena gate's far side)
 * and for a body with no hull. Contact with rock is by the hull (collideTerrainHull)
 */
export const terrainRadius = (shipRadius: number) => Math.max(20, shipRadius * 0.72);
