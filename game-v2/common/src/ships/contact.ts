/**
 * Ship-to-ship contacts, worked out alike on both sides. The server's contact pass (bridge/flight.ts resolveContacts)
 * finds the pairs and calls `contactPair` for each; a pilot's client runs the same function on its tick-aligned own
 * ship (client ships/own/OwnTick.ts) for each contact the server tells it of (network/ownTick.ts), so the push it
 * gets is the server's to the bit (docs/design/confirmed-hits.md part G).
 *
 * Deterministic: piece transforms use detTrig (dcos/dsin), penetration is common geometry.ts convexPenetration, and
 * every sum is done in the same order on both sides.
 */

import type { Vec2 } from './types.js';
import type { PlacedGeom } from './grid.js';
import { convexPenetration } from './geometry.js';
import { worldToLocalDir, localToWorldDir } from './flight.js';
import { dcos, dsin } from '../math/detTrig.js';

/** A convex piece of a part in world space, with its bounding box */
export interface ContactPiece { part: number; poly: Vec2[]; x0: number; x1: number; y0: number; y1: number }

/** Where a body is for its contacts: its centre (the centre of mass) and heading */
export interface ContactPose { x: number; y: number; angle: number }

/** What a contact moves: a body's place and velocity */
export interface ContactBody { x: number; y: number; vx: number; vy: number }

export function centroidOf(poly: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

/** A world point in a ship's grid (cells, from its blueprint's origin) */
export function worldToShipGrid(pose: ContactPose, com: Vec2, cs: number, x: number, y: number): Vec2 {
  const [lx, ly] = worldToLocalDir([x - pose.x, y - pose.y], pose.angle);
  return [lx / cs + com[0], ly / cs + com[1]];
}

/**
 * World-space convex pieces of every alive part (shrunk, so parts that merely touch don't collide), each with its
 * bounding box. `near`: only the parts that could reach that circle (a boss's far side isn't transformed for a ship
 * grinding its flank)
 */
export function contactPieces(geom: readonly PlacedGeom[], alive: readonly boolean[], com: Vec2, cs: number, pose: ContactPose, near?: { x: number; y: number; r: number }): ContactPiece[] {
  const [cx, cy] = com;
  const px = pose.x, py = pose.y;
  const phi = pose.angle + Math.PI / 2;
  const c = dcos(phi), s = dsin(phi);
  const out: ContactPiece[] = [];
  let nx = 0, ny = 0, nr = Infinity;
  if (near) { [nx, ny] = worldToShipGrid(pose, com, cs, near.x, near.y); nr = near.r / cs + 1; }
  geom.forEach((g, i) => {
    if (!alive[i]) return;
    if (near && (g.bbox.maxX < nx - nr || g.bbox.minX > nx + nr || g.bbox.maxY < ny - nr || g.bbox.minY > ny + nr)) return;
    for (const piece of g.convexShrunk) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const poly = piece.map(([x, y]) => {
        const lx = (x - cx) * cs, ly = (y - cy) * cs;
        const wx = px + lx * c - ly * s, wy = py + lx * s + ly * c;
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy;
        if (wy > y1) y1 = wy;
        return [wx, wy] as Vec2;
      });
      out.push({ part: i, poly, x0, x1, y0, y1 });
    }
  });
  return out;
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
 * pieces overlap (or neither can move): nothing happened.
 */
export function contactPair(pa: readonly ContactPiece[], pb: readonly ContactPiece[], a: ContactBody, b: ContactBody, invA: number, invB: number, restitution: number): ContactResult | null {
  let deepest: { depth: number; nx: number; ny: number } | null = null;
  let at: Vec2 = [0, 0];
  const partsA = new Set<number>(), partsB = new Set<number>();
  // All of B's pieces lie in this box: A's pieces outside it touch nothing
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const q of pb) {
    if (q.x0 < bx0) bx0 = q.x0;
    if (q.x1 > bx1) bx1 = q.x1;
    if (q.y0 < by0) by0 = q.y0;
    if (q.y1 > by1) by1 = q.y1;
  }
  for (const p of pa) {
    if (p.x1 < bx0 || p.x0 > bx1 || p.y1 < by0 || p.y0 > by1) continue;
    for (const q of pb) {
      if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
      const pen = convexPenetration(p.poly, q.poly);
      if (!pen) continue;
      partsA.add(p.part);
      partsB.add(q.part);
      if (!deepest || pen.depth > deepest.depth) {
        deepest = pen;
        // Contact point: between the two overlapping pieces
        const ca = centroidOf(p.poly), cb = centroidOf(q.poly);
        at = [(ca[0] + cb[0]) / 2, (ca[1] + cb[1]) / 2];
      }
    }
  }
  if (!deepest) return null;
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
