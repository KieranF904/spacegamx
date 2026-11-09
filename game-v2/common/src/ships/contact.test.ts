/**
 * Ship-to-ship contacts against the real part outlines (ships/contact.ts), big bodies included: a big body (over
 * CONTACT_BIG_BODY parts) only has the parts near the other placed, and that must never miss a part that overlaps nor
 * make a contact where none does. No circle is ever the contact: a ship in a big hull's concave gap, beside a thin
 * spar, or where a part was shot away touches nothing, though it's deep inside the hull's bounding circle; touching
 * any real part is a contact. The client's function (network/ownTick.ts applyCauseRows) gives the server pass's push
 * to the bit. And the placing as it is now (each structure's pieces kept in its own frame, one flat buffer a placing)
 * is held to the bit against the placing and SAT it replaced, kept here verbatim as the reference.
 */
import { describe, it, expect } from 'vitest';
import { loadCatalog } from './catalog.js';
import { readCatalogFiles, readShipJson } from './testData.js';
import { createShipState, rebuildShip } from './state.js';
import { blueprintGeometry } from './blueprint.js';
import { contactPieces, contactPair, pairPieces, centroidOf, type ContactPose, type ContactBody, type PairShape, type ContactResult } from './contact.js';
import { convexPenetration } from './geometry.js';
import { worldToLocalDir } from './flight.js';
import { dcos, dsin } from '../math/detTrig.js';
import { applyCauseRows, CONTACT_BIG_BODY, OWN_CAUSE, CONTACT_FLAG, type OwnShape } from '../network/ownTick.js';
import { seededRng } from './rng.js';
import type { Blueprint, PlacedPart, Vec2 } from './types.js';
import type { PlacedGeom } from './grid.js';
import type { ShipState } from './state.js';

const tuning = readShipJson('tuning.json');
const cat = loadCatalog(readCatalogFiles(), { overlapShrink: tuning.overlapShrink });
const CS: number = tuning.cellSize;

/**
 * A big body (61 parts): a U of hull squares (its bottom bar along y 0..1, its arms up to y -14 at x -8 and 8: the gap
 * between them 15 cells across) with a core in the bar, and a thin spar (one cell thick) out of the bar's right end
 * to x 22
 */
function bigU(): Blueprint {
  const parts: PlacedPart[] = [];
  let uid = 0;
  const sq = (x: number, y: number) => parts.push({ uid: uid++, piece: 'sq', fn: 'hull', material: 'steel', x, y, rot: 0, flip: false } as PlacedPart);
  parts.push({ uid: uid++, piece: 'rect2', fn: 'core', material: 'steel', x: 0, y: 0, rot: 0, flip: false } as PlacedPart);
  for (let x = -8; x <= 8; x++) if (x !== 0 && x !== 1) sq(x, 0);
  for (let y = -1; y >= -14; y--) { sq(-8, y); sq(8, y); }
  for (let x = 9; x <= 22; x++) sq(x, 0);
  return { name: 'U', catalogVersion: 1, parts } as Blueprint;
}

interface Body { ship: ShipState; geom: PlacedGeom[]; shape: PairShape & OwnShape }
function body(bp: Blueprint, id: number): Body {
  const ship = createShipState(cat, tuning, id, bp, 0);
  const geom = blueprintGeometry(cat, bp);
  return { ship, geom, shape: shapeOf(ship, geom) };
}
function shapeOf(ship: ShipState, geom: PlacedGeom[]): PairShape & OwnShape {
  const d = ship.derived;
  return { geom, alive: d.alive, com: d.com, mass: d.mass, radius: d.radius, big: ship.blueprint.parts.length > CONTACT_BIG_BODY };
}
/** A grid point of a body (cells) in the world, at a pose */
function gridToWorld(b: Body, pose: ContactPose, gx: number, gy: number): Vec2 {
  const phi = pose.angle + Math.PI / 2, c = dcos(phi), s = dsin(phi);
  const lx = (gx - b.ship.derived.com[0]) * CS, ly = (gy - b.ship.derived.com[1]) * CS;
  return [pose.x + lx * c - ly * s, pose.y + lx * s + ly * c];
}

// ---- The reference: placing and SAT as they were (Vec2 corners, every part placed or the near circle's) ----

interface RefPiece { part: number; poly: Vec2[]; x0: number; x1: number; y0: number; y1: number }
function refPieces(geom: readonly PlacedGeom[], alive: readonly boolean[], com: Vec2, cs: number, pose: ContactPose, near?: { x: number; y: number; r: number }): RefPiece[] {
  const [cx, cy] = com;
  const px = pose.x, py = pose.y;
  const phi = pose.angle + Math.PI / 2;
  const c = dcos(phi), s = dsin(phi);
  const out: RefPiece[] = [];
  let nx = 0, ny = 0, nr = Infinity;
  if (near) {
    const [lx, ly] = worldToLocalDir([near.x - pose.x, near.y - pose.y], pose.angle);
    nx = lx / cs + com[0]; ny = ly / cs + com[1]; nr = near.r / cs + 1;
  }
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
function refPair(pa: readonly RefPiece[], pb: readonly RefPiece[], a: ContactBody, b: ContactBody, invA: number, invB: number, restitution: number): ContactResult | null {
  let deepest: { depth: number; nx: number; ny: number } | null = null;
  let at: Vec2 = [0, 0];
  const partsA = new Set<number>(), partsB = new Set<number>();
  let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
  for (const q of pb) { if (q.x0 < bx0) bx0 = q.x0; if (q.x1 > bx1) bx1 = q.x1; if (q.y0 < by0) by0 = q.y0; if (q.y1 > by1) by1 = q.y1; }
  for (const p of pa) {
    if (p.x1 < bx0 || p.x0 > bx1 || p.y1 < by0 || p.y0 > by1) continue;
    for (const q of pb) {
      if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
      const pen = convexPenetration(p.poly, q.poly);
      if (!pen) continue;
      partsA.add(p.part); partsB.add(q.part);
      if (!deepest || pen.depth > deepest.depth) {
        deepest = pen;
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

type Pose = ContactPose & { vx: number; vy: number };
/** A pair resolved as the pass does now (big bodies placed near the other) */
function now(A: Body, pa: Pose, B: Body, pb: Pose) {
  const [xa, xb] = pairPieces(A.shape, pa, B.shape, pb, CS);
  const a = { ...pa }, b = { ...pb };
  const res = contactPair(xa, xb, a, b, 1 / A.shape.mass, 1 / B.shape.mass, 0.3);
  return { res, a, b };
}
/** ...the reference: every part of both placed (`near`: the near circle as it was) */
function ref(A: Body, pa: Pose, B: Body, pb: Pose, near: boolean) {
  const xa = refPieces(A.geom, A.shape.alive, A.shape.com, CS, pa, near && A.shape.big ? { x: pb.x, y: pb.y, r: B.shape.radius } : undefined);
  const xb = refPieces(B.geom, B.shape.alive, B.shape.com, CS, pb, near && B.shape.big ? { x: pa.x, y: pa.y, r: A.shape.radius } : undefined);
  const a = { ...pa }, b = { ...pb };
  const res = refPair(xa, xb, a, b, 1 / A.shape.mass, 1 / B.shape.mass, 0.3);
  return { res, a, b };
}
const flat = (r: ReturnType<typeof now>) => r.res && [r.res.depth, r.res.nx, r.res.ny, r.res.at[0], r.res.at[1], r.res.closing, [...r.res.partsA], [...r.res.partsB], r.a.x, r.a.y, r.a.vx, r.a.vy, r.b.x, r.b.y, r.b.vx, r.b.vy];

describe('ship contacts against the real part outlines (ships/contact.ts)', () => {
  const U = body(bigU(), 1);
  const small = body(readShipJson('blueprints/sparrow-t.json'), 2);
  const hauler = body(readShipJson('blueprints/hauler.json'), 3);
  const uPose: Pose = { x: 5000, y: -3000, angle: 0.7, vx: 0.5, vy: -0.25 };

  it('the test bodies: a big U (placed near the other), a small ship (whole)', () => {
    expect(U.shape.big).toBe(true);
    expect(hauler.shape.big).toBe(true);
    expect(small.shape.big).toBe(false);
    expect(U.ship.derived.alive.every(Boolean)).toBe(true);
  });

  it("in the U's gap, deep inside its bounding circle, it touches nothing", () => {
    // (The gap's middle: between the arms, 7 cells clear of each side; the small ship is a couple of cells across)
    for (const [gx, gy] of [[0.5, -7], [0.5, -12], [-3, -9], [4, -5]] as Vec2[]) {
      for (const angle of [0, 0.9, 2.2, -1.4]) {
        const [x, y] = gridToWorld(U, uPose, gx, gy);
        const p: Pose = { x, y, angle, vx: 0, vy: 0 };
        expect(Math.hypot(x - uPose.x, y - uPose.y)).toBeLessThan(U.shape.radius * 0.8);
        expect(now(U, uPose, small, p).res).toBeNull();
        expect(now(small, p, U, uPose).res).toBeNull();
      }
    }
  });

  it('beside the thin spar it touches nothing; on it, it touches the spar part', () => {
    const sparPart = (x: number) => U.ship.blueprint.parts.findIndex((q) => q.x === x && q.y === 0);
    for (const sx of [12, 16, 20]) {
      // (The spar's cells are y 0..1: a cell and a half off its middle, either side, it's clear by more than the ship)
      for (const gy of [-3.5, 4.5]) {
        const [x, y] = gridToWorld(U, uPose, sx + 0.5, gy);
        expect(now(small, { x, y, angle: uPose.angle, vx: 0, vy: 0 }, U, uPose).res).toBeNull();
      }
      const [x, y] = gridToWorld(U, uPose, sx + 0.5, 0.5);
      const r = now(small, { x, y, angle: uPose.angle + 0.3, vx: 0, vy: 0 }, U, uPose).res;
      expect(r).not.toBeNull();
      expect(r!.partsB.has(sparPart(sx))).toBe(true);
    }
  });

  it('where a part was shot away there is nothing to touch', () => {
    // (A probe: a lone core, two cells by one, laid along the spar over its last cell and past its end)
    const probe = body({ name: 'probe', catalogVersion: 1, parts: [{ uid: 0, piece: 'rect2', fn: 'core', material: 'steel', x: 0, y: 0, rot: 0, flip: false }] } as Blueprint, 8);
    const ship = createShipState(cat, tuning, 9, bigU(), 0);
    const tip = ship.blueprint.parts.findIndex((q) => q.x === 22 && q.y === 0);
    const at = (B: Body, gx: number): Pose => { const [x, y] = gridToWorld(B, uPose, gx, 0.5); return { x, y, angle: uPose.angle, vx: 0, vy: 0 }; };
    const B: Body = { ship, geom: U.geom, shape: shapeOf(ship, U.geom) };
    const r = now(probe, at(B, 23.6), B, uPose).res;
    expect(r).not.toBeNull();
    expect([...r!.partsB]).toEqual([tip]);
    ship.hp[tip] = 0;
    rebuildShip(ship, cat, tuning);
    expect(ship.derived.alive[tip]).toBe(false);
    // (Placed as the hull stands now: its com moved a little with the part gone, so the same spot is asked of it)
    const B2: Body = { ship, geom: U.geom, shape: shapeOf(ship, U.geom) };
    expect(now(probe, at(B2, 23.6), B2, uPose).res).toBeNull();
    expect(now(B2, uPose, probe, at(B2, 23.6)).res).toBeNull();
    // (...and the part next to it still stands)
    expect(now(probe, at(B2, 22.6), B2, uPose).res).not.toBeNull();
  });

  it('touching any real part is a contact, and the near placing finds the same contact as placing every part', () => {
    for (const B of [U, hauler]) {
      for (let i = 0; i < B.geom.length; i++) {
        if (!B.shape.alive[i]) continue;
        const [gx, gy] = B.geom[i].centroid;
        const [x, y] = gridToWorld(B, uPose, gx, gy);
        for (const angle of [0.1, 1.9]) {
          const p: Pose = { x, y, angle, vx: -1, vy: 0.5 };
          const got = now(small, p, B, uPose);
          expect(got.res, `part ${i}`).not.toBeNull();
          expect(got.res!.partsB.has(i), `part ${i}`).toBe(true);
          expect(flat(got)).toEqual(flat(ref(small, p, B, uPose, false)));
        }
      }
    }
  });

  it('the placing as it is now is the reference to the bit: small, big and big against big, near and far, parts gone', () => {
    const rng = seededRng(4242);
    const hurt = createShipState(cat, tuning, 11, readShipJson('blueprints/hauler.json'), 0);
    for (let i = 0; i < hurt.hp.length; i += 7) if (hurt.blueprint.parts[i].fn !== 'core') hurt.hp[i] = 0;
    rebuildShip(hurt, cat, tuning);
    const hurtB: Body = { ship: hurt, geom: hauler.geom, shape: shapeOf(hurt, hauler.geom) };
    expect(hurt.derived.alive.filter((a) => !a).length).toBeGreaterThan(5);
    let touched = 0, compared = 0;
    for (const [A, B] of [[small, U], [U, small], [small, hauler], [hauler, U], [U, hurtB], [hurtB, small], [small, small]] as [Body, Body][]) {
      for (let k = 0; k < 150; k++) {
        const pa: Pose = { x: 1000 + (rng() - 0.5) * 50, y: -200 + (rng() - 0.5) * 50, angle: (rng() - 0.5) * 7, vx: (rng() - 0.5) * 8, vy: (rng() - 0.5) * 8 };
        const d = (A.shape.radius + B.shape.radius) * Math.sqrt(rng()), h = rng() * Math.PI * 2;
        const pb: Pose = { x: pa.x + Math.cos(h) * d, y: pa.y + Math.sin(h) * d, angle: (rng() - 0.5) * 7, vx: (rng() - 0.5) * 8, vy: (rng() - 0.5) * 8 };
        const got = now(A, pa, B, pb);
        compared++;
        if (got.res) touched++;
        // (as the near circle placed it, and with every part placed: the same contact either way)
        expect(flat(got)).toEqual(flat(ref(A, pa, B, pb, true)));
        expect(flat(got)).toEqual(flat(ref(A, pa, B, pb, false)));
      }
    }
    expect(compared).toBe(1050);
    expect(touched).toBeGreaterThan(200);
  });

  it("the client's function on a cause gives the server pass's push to the bit, big bodies either side", () => {
    const rng = seededRng(77);
    let checked = 0;
    for (const [A, B] of [[small, U], [U, small], [hauler, U]] as [Body, Body][]) {
      for (let k = 0; k < 80; k++) {
        const pa: Pose = { x: 300, y: 300, angle: (rng() - 0.5) * 6, vx: (rng() - 0.5) * 6, vy: (rng() - 0.5) * 6 };
        const d = (A.shape.radius + B.shape.radius) * 0.6 * Math.sqrt(rng()), h = rng() * Math.PI * 2;
        const pb: Pose = { x: pa.x + Math.cos(h) * d, y: pa.y + Math.sin(h) * d, angle: (rng() - 0.5) * 6, vx: (rng() - 0.5) * 6, vy: (rng() - 0.5) * 6 };
        const pass = now(A, pa, B, pb);
        if (!pass.res) continue;
        checked++;
        // (A's side: the pass's first body; B's: the second)
        const env = (self: Body, other: Body, ob: Pose) => ({ cellSize: CS, restitution: 0.3, self: self.shape, other: () => ({ shape: other.shape, body: { ...ob } }), rebuilt: () => null });
        const sa = { ...pa, angVel: 0 } as never as { x: number; y: number; vx: number; vy: number };
        expect(applyCauseRows(sa as never, [[OWN_CAUSE.CONTACT, 2, 0]], env(A, B, pb))).toBe(true);
        expect([sa.x, sa.y, sa.vx, sa.vy]).toEqual([pass.a.x, pass.a.y, pass.a.vx, pass.a.vy]);
        const sb = { ...pb, angVel: 0 } as never as { x: number; y: number; vx: number; vy: number };
        expect(applyCauseRows(sb as never, [[OWN_CAUSE.CONTACT, 1, CONTACT_FLAG.SECOND]], env(B, A, pa))).toBe(true);
        expect([sb.x, sb.y, sb.vx, sb.vy]).toEqual([pass.b.x, pass.b.y, pass.b.vx, pass.b.vy]);
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('a placing reads the parts standing now, whatever was placed before with the same structure', () => {
    const p: Pose = { x: 0, y: 0, angle: 0.4, vx: 0, vy: 0 };
    const all = contactPieces(U.geom, U.shape.alive, U.shape.com, CS, p);
    const fewer = U.shape.alive.map((a, i) => a && i % 2 === 0);
    const some = contactPieces(U.geom, fewer, U.shape.com, CS, p);
    expect(new Set(some.map((q) => q.part))).toEqual(new Set(all.map((q) => q.part).filter((i) => i % 2 === 0)));
    expect(contactPieces(U.geom, U.shape.alive, U.shape.com, CS, p).map((q) => [q.part, q.x0, q.y1])).toEqual(all.map((q) => [q.part, q.x0, q.y1]));
  });
});
