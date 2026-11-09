/**
 * Ship-to-ship contacts, worked out alike on both sides. The server's contact pass (bridge/flight.ts resolveContacts)
 * finds the pairs and calls `contactPair` for each; a pilot's client runs the same function on its tick-aligned own
 * ship (client ships/own/OwnTick.ts) for each contact the server tells it of (network/ownTick.ts), so the push it
 * gets is the server's to the bit (docs/design/confirmed-hits.md part G).
 *
 * Deterministic: piece transforms use detTrig (dcos/dsin), penetration is common geometry.ts convexPenetration (on flat
 * corners: penetrationFlat), and every sum is done in the same order on both sides.
 *
 * Only the real pieces make a contact. Circles only choose what to test: the pass's candidate pairs (both bounding
 * circles meet: contactPass.ts) and a big body's parts worth placing (contactPieces `near`), both holding everything
 * that could touch. Cheap where it runs most (server pass, every client's tick layer, the server's shadows of them):
 * each structure's pieces kept in its own frame (bodyPieces), a placing one flat buffer, nothing allocated per corner.
 */

import type { Vec2 } from './types.js';
import type { PlacedGeom } from './grid.js';
import { worldToLocalDir, localToWorldDir } from './flight.js';
import { penetrationFlat } from './geometry.js';
import { dcos, dsin } from '../math/detTrig.js';

/**
 * A convex piece of a part in world space, with its bounding box: its corners are `n` points at `pts[o..]` (x, y
 * interleaved; one buffer holds every piece a contactPieces call placed)
 */
export interface ContactPiece { part: number; pts: Float64Array; o: number; n: number; x0: number; x1: number; y0: number; y1: number }

/** Where a body is for its contacts: its centre (the centre of mass) and heading */
export interface ContactPose { x: number; y: number; angle: number }

/** What a contact moves: a body's place and velocity */
export interface ContactBody { x: number; y: number; vx: number; vy: number }

export function centroidOf(poly: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

/** A placed piece's centroid (centroidOf's sums, in its order) */
function pieceCentroid(p: ContactPiece): Vec2 {
  const pts = p.pts, n = p.n;
  let x = 0, y = 0;
  for (let j = 0, k = p.o; j < n; j++, k += 2) { x += pts[k]; y += pts[k + 1]; }
  return [x / n, y / n];
}

/** A world point in a ship's grid (cells, from its blueprint's origin) */
export function worldToShipGrid(pose: ContactPose, com: Vec2, cs: number, x: number, y: number): Vec2 {
  const [lx, ly] = worldToLocalDir([x - pose.x, y - pose.y], pose.angle);
  return [lx / cs + com[0], ly / cs + com[1]];
}

/**
 * A body's shrunk pieces in its own frame, world units from its centre of mass ((x - com) * cs), worked out once per
 * structure (every rebuild makes its `com` anew) instead of at every placing: the same numbers placing worked out each
 * time, so what's placed is the same to the bit
 */
interface BodyPieces { geom: readonly PlacedGeom[]; cx: number; cy: number; cs: number; lp: Float64Array[]; ln: number[][] }
const BODY = new WeakMap<Vec2, BodyPieces>();

function bodyPieces(geom: readonly PlacedGeom[], com: Vec2, cs: number): BodyPieces {
  const cx = com[0], cy = com[1];
  const had = BODY.get(com);
  if (had && had.geom === geom && had.cx === cx && had.cy === cy && had.cs === cs) return had;
  const lp: Float64Array[] = [], ln: number[][] = [];
  for (const g of geom) {
    let n = 0;
    for (const piece of g.convexShrunk) n += piece.length;
    const f = new Float64Array(n * 2), counts: number[] = [];
    let k = 0;
    for (const piece of g.convexShrunk) {
      counts.push(piece.length);
      for (const [x, y] of piece) { f[k++] = (x - cx) * cs; f[k++] = (y - cy) * cs; }
    }
    lp.push(f);
    ln.push(counts);
  }
  const b = { geom, cx, cy, cs, lp, ln };
  BODY.set(com, b);
  return b;
}

/**
 * A ship's hull for its contacts with rock (terrain.ts collideTerrainHull): every alive part's shrunk convex pieces in
 * its own frame, world units from its centre of mass ((x - com) * cs, as placing has them), corners x, y interleaved
 * in `pts`, each piece's corner count in `n`. Made with its structure (rebuild.ts: ShipDerived.hull)
 */
export interface ShipHull { pts: Float64Array; n: Int32Array }

export function hullOf(geom: readonly PlacedGeom[], alive: readonly boolean[], com: Vec2, cs: number): ShipHull {
  const cx = com[0], cy = com[1];
  let corners = 0, pieces = 0;
  for (let i = 0; i < geom.length; i++) {
    if (!alive[i]) continue;
    for (const piece of geom[i].convexShrunk) { corners += piece.length; pieces++; }
  }
  const pts = new Float64Array(corners * 2), n = new Int32Array(pieces);
  let k = 0, q = 0;
  for (let i = 0; i < geom.length; i++) {
    if (!alive[i]) continue;
    for (const piece of geom[i].convexShrunk) {
      n[q++] = piece.length;
      for (const [x, y] of piece) { pts[k++] = (x - cx) * cs; pts[k++] = (y - cy) * cs; }
    }
  }
  return { pts, n };
}

/** The parts a placing keeps (reused: placing never calls itself) */
let TAKE = new Int32Array(256);

/**
 * World-space convex pieces of every alive part (shrunk, so parts that merely touch don't collide), each with its
 * bounding box. `near`: only the parts that could reach the other body, given as its circle (its centre and bounding
 * radius: every corner of every alive part lies within it, rebuild.ts); a boss's far side isn't placed for a ship
 * grinding its flank. Each part's box (grid) is held whole against the square round that circle, a cell to spare: a
 * part left out can't overlap any of the other, so leaving it out adds no contact and moves none (contactPair takes
 * the same overlaps from the parts that stay). The circle only chooses what to place: the contact is the pieces'
 */
export function contactPieces(geom: readonly PlacedGeom[], alive: readonly boolean[], com: Vec2, cs: number, pose: ContactPose, near?: { x: number; y: number; r: number }): ContactPiece[] {
  const px = pose.x, py = pose.y;
  const phi = pose.angle + Math.PI / 2;
  const c = dcos(phi), s = dsin(phi);
  const out: ContactPiece[] = [];
  // (The other's circle in this body's grid, turned back by the placing's own turn: a cell to spare covers any rounding)
  let gx0 = -Infinity, gx1 = Infinity, gy0 = -Infinity, gy1 = Infinity;
  if (near) {
    const dx = near.x - px, dy = near.y - py, r = near.r / cs + 1;
    const gx = (dx * c + dy * s) / cs + com[0], gy = (-dx * s + dy * c) / cs + com[1];
    gx0 = gx - r; gx1 = gx + r; gy0 = gy - r; gy1 = gy + r;
  }
  const bp = bodyPieces(geom, com, cs);
  // (The parts that stay, and their corners: one buffer for them all)
  if (TAKE.length < geom.length) TAKE = new Int32Array(geom.length * 2);
  const take = TAKE;
  let parts = 0, size = 0;
  for (let i = 0; i < geom.length; i++) {
    if (!alive[i]) continue;
    const bb = geom[i].bbox;
    if (bb.maxX < gx0 || bb.minX > gx1 || bb.maxY < gy0 || bb.minY > gy1) continue;
    take[parts++] = i;
    size += bp.lp[i].length;
  }
  if (!parts) return out;
  const pts = new Float64Array(size);
  let w = 0;
  for (let t = 0; t < parts; t++) {
    const i = take[t], lp = bp.lp[i], ln = bp.ln[i];
    let k = 0;
    for (let q = 0; q < ln.length; q++) {
      const n = ln[q], o = w;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let j = 0; j < n; j++) {
        const lx = lp[k++], ly = lp[k++];
        const wx = px + lx * c - ly * s, wy = py + lx * s + ly * c;
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy;
        if (wy > y1) y1 = wy;
        pts[w++] = wx; pts[w++] = wy;
      }
      out.push({ part: i, pts, o, n, x0, x1, y0, y1 });
    }
  }
  return out;
}

/** What placing a body for a pair needs: its parts' outlines, which stand, its centre of mass and reach, and whether
 * it has more parts than are placed whole (network/ownTick.ts CONTACT_BIG_BODY) */
export interface PairShape { geom: readonly PlacedGeom[]; alive: readonly boolean[]; com: Vec2; radius: number; big: boolean }

/**
 * Both bodies' pieces for a pair, as contactPair takes them: a small body whole (`hadA`/`hadB`: already placed at this
 * pose, kept for a pass), a big one (a boss, a giant) only where it could reach the other (contactPieces `near`)
 */
export function pairPieces(A: PairShape, pa: ContactPose, B: PairShape, pb: ContactPose, cs: number, hadA?: ContactPiece[], hadB?: ContactPiece[]): [ContactPiece[], ContactPiece[]] {
  return [
    hadA ?? contactPieces(A.geom, A.alive, A.com, cs, pa, A.big ? { x: pb.x, y: pb.y, r: B.radius } : undefined),
    hadB ?? contactPieces(B.geom, B.alive, B.com, cs, pb, B.big ? { x: pa.x, y: pa.y, r: A.radius } : undefined),
  ];
}

/** Two placed pieces' penetration: geometry.ts penetrationFlat (convexPenetration on flat corners), `a` towards `b` */
function piecePenetration(a: ContactPiece, b: ContactPiece): { depth: number; nx: number; ny: number } | null {
  return penetrationFlat(a.pts, a.o, a.n, b.pts, b.o, b.n);
}

/** One pair's contact, as resolved: the deepest overlap, where it was, the parts touching, and how fast they closed */
export interface ContactResult {
  depth: number; nx: number; ny: number;
  at: Vec2;
  partsA: Set<number>; partsB: Set<number>;
  /** Closing speed along the normal (<= 0: they were already separating, so no impulse was exchanged) */
  closing: number;
}

/**
 * Two bodies' pieces overlapping: push them apart along the deepest overlap's normal, by their inverse masses
 * (0: pinned, it doesn't give), and exchange an impulse if they were closing. Mutates `a` and `b`. Null when no
 * pieces overlap (or neither can move): nothing happened. Only real pieces overlapping make a contact, never a circle
 */
export function contactPair(pa: readonly ContactPiece[], pb: readonly ContactPiece[], a: ContactBody, b: ContactBody, invA: number, invB: number, restitution: number): ContactResult | null {
  let deepest: { depth: number; nx: number; ny: number } | null = null;
  let at: Vec2 = [0, 0];
  let partsA: Set<number> | null = null, partsB: Set<number> | null = null;
  // All of B's pieces lie in this box: A's pieces outside it touch nothing
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (let j = 0; j < pb.length; j++) {
    const q = pb[j];
    if (q.x0 < bx0) bx0 = q.x0;
    if (q.x1 > bx1) bx1 = q.x1;
    if (q.y0 < by0) by0 = q.y0;
    if (q.y1 > by1) by1 = q.y1;
  }
  for (let i = 0; i < pa.length; i++) {
    const p = pa[i];
    if (p.x1 < bx0 || p.x0 > bx1 || p.y1 < by0 || p.y0 > by1) continue;
    for (let j = 0; j < pb.length; j++) {
      const q = pb[j];
      if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
      const pen = piecePenetration(p, q);
      if (!pen) continue;
      (partsA ??= new Set()).add(p.part);
      (partsB ??= new Set()).add(q.part);
      if (!deepest || pen.depth > deepest.depth) {
        deepest = pen;
        // Contact point: between the two overlapping pieces
        const ca = pieceCentroid(p), cb = pieceCentroid(q);
        at = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2];
      }
    }
  }
  if (!deepest || !partsA || !partsB) return null;
  if (invA + invB === 0) return null;
  const { nx, ny, depth } = deepest;
  const corr = depth / (invA + invB);
  a.x -= nx * corr * invA; a.y -= ny * corr * invA;
  b.x += nx * corr * invB; b.y += ny * corr * invB;
  const vrel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vrel < 0) {
    const jImp = -(1 + restitution) * vrel / (invA + invB);
    a.vx -= jImp * invA * nx; a.vy -= jImp * invA * ny;
    b.vx += jImp * invB * nx; b.vy += jImp * invB * ny;
  }
  return { depth, nx, ny, at, partsA, partsB, closing: -vrel };
}

/**
 * A rebuild keeps the remaining parts where they were: the centre of mass moved in grid space, so the body's centre
 * moves by this much in the world (bridge/rebuild.ts rebuildNow; a pilot's client recentres its own tick-aligned ship
 * alike)
 */
export function recentreShift(oldCom: Vec2, newCom: Vec2, cs: number, angle: number): Vec2 | null {
  if (newCom[0] === oldCom[0] && newCom[1] === oldCom[1]) return null;
  return localToWorldDir([(newCom[0] - oldCom[0]) * cs, (newCom[1] - oldCom[1]) * cs], angle);
}
