/**
 * The PT layer's contact pass (ptst.ts PtContacts) on predicted ticks.
 *
 * RealContacts is the server's pass (server ships/bridge/flight.ts resolveContacts) over PT states: the tick's bodies
 * (sorted by id; no debris, none massless or mid-jump) through the one pair finder (common sim/c-contactCache.ts
 * contactPairs, cached per tick in a ContactPairCache: found once a tick, found again only for ticks a re-step
 * stepped again), each pair in the pass's order from the bodies as earlier pairs left them, its push worked out with
 * common ships/contact.ts (contactPieces, contactPair: polygon pieces, the deepest overlap, mass shares, restitution),
 * and every body the pass moved rounded as the server's tick end rounds it. With the same states before the pass, the
 * same states after it: collisions between predicted ships are no correction.
 *
 * Confirmed ticks don't come through here: there the tick layer finds its own pairs (client ships/causes/
 * ContactWorld.ts), once a tick, and ST is read from it.
 *
 * CircleContacts is the stand-in the fake-transport tests use (and Stage 4's model): circles, mass-shared push.
 */
import {
  CONTACT_BIG_BODY, ContactPairCache, contactJumping, contactPair, contactPairs, contactPieces, dhypot, quantizeShipBody,
  type ContactEntry, type ContactPiece, type ContactPair, type PlacedGeom, type ReplicaState, type ShipTuning, type SimEvent, type Vec2,
} from '@space-game/common';
import type { PtBody, PtContacts } from './ptst';

/** What the pass needs of a ship's structure at a tick */
export interface PtShape {
  mass: number;
  radius: number;
  geom: readonly PlacedGeom[];
  alive: readonly boolean[];
  com: Vec2;
  /** Over CONTACT_BIG_BODY parts: only its pieces near the other body are made (a boss) */
  big: boolean;
  /** Doesn't give (all the push is the other's) */
  pinned?: boolean;
}

export class RealContacts implements PtContacts {
  /** The bodies of the pass being run (the cache's finder reads them) */
  private cur: ContactEntry[] = [];
  /** Each tick's pairs, found once (dropped from a tick a re-step steps again) */
  readonly cache = new ContactPairCache(() => contactPairs(this.cur), 600);
  readonly stats = { passes: 0, pairs: 0, touched: 0 };

  constructor(
    /** A ship's structure as it flew tick t (null: takes no contacts) */
    private readonly shape: (id: number, t: number) => PtShape | null,
    private readonly tuning: ShipTuning,
  ) {}

  private entries(t: number, bodies: readonly PtBody[]): { entries: ContactEntry[]; shapes: Map<number, PtShape>; by: Map<number, PtBody> } {
    const entries: ContactEntry[] = [], shapes = new Map<number, PtShape>(), by = new Map<number, PtBody>();
    for (const b of bodies) {
      const sh = this.shape(b.s.id, t);
      if (!sh || !(sh.mass > 0) || contactJumping(b.s.body.jump, this.tuning)) continue;
      entries.push({ id: b.s.id, x: b.s.body.x, y: b.s.body.y, r: sh.radius });
      shapes.set(b.s.id, sh);
      by.set(b.s.id, b);
    }
    return { entries, shapes, by };
  }

  pass(t: number, bodies: readonly PtBody[], out: SimEvent[]): void {
    const { entries, shapes, by } = this.entries(t, bodies);
    if (entries.length < 2) return;
    this.stats.passes++;
    this.cur = entries;
    const pairs: readonly ContactPair[] = this.cache.pairs(t);
    this.cur = [];
    this.stats.pairs += pairs.length;
    const cs = this.tuning.cellSize, restitution = this.tuning.collision?.restitution ?? 0.3;
    // (A small body's pieces kept for the pass until it's pushed; a big one's only those near the other: the server's)
    const pieces = new Map<number, ContactPiece[]>();
    const piecesOf = (id: number, sh: PtShape, o: PtBody, osh: PtShape) => {
      const b = by.get(id)!.s.body;
      if (sh.big) return contactPieces(sh.geom, sh.alive, sh.com, cs, b, { x: o.s.body.x, y: o.s.body.y, r: osh.radius });
      let p = pieces.get(id);
      if (!p) pieces.set(id, (p = contactPieces(sh.geom, sh.alive, sh.com, cs, b)));
      return p;
    };
    const moved = new Set<PtBody>();
    for (const [ia, ib] of pairs) {
      const A = by.get(ia), B = by.get(ib), sa = shapes.get(ia), sb = shapes.get(ib);
      if (!A || !B || !sa || !sb) continue;
      const a0 = A.s.body, b0 = B.s.body;
      if (dhypot(b0.x - a0.x, b0.y - a0.y) > sa.radius + sb.radius) continue;
      const pa = piecesOf(ia, sa, B, sb), pb = piecesOf(ib, sb, A, sa);
      const a = { x: a0.x, y: a0.y, vx: a0.vx, vy: a0.vy }, b = { x: b0.x, y: b0.y, vx: b0.vx, vy: b0.vy };
      const res = contactPair(pa, pb, a, b, sa.pinned ? 0 : 1 / sa.mass, sb.pinned ? 0 : 1 / sb.mass, restitution);
      if (!res) continue;
      const dvax = a.vx - a0.vx, dvay = a.vy - a0.vy, dvbx = b.vx - b0.vx, dvby = b.vy - b0.vy;
      a0.x = a.x; a0.y = a.y; a0.vx = a.vx; a0.vy = a.vy;
      b0.x = b.x; b0.y = b.y; b0.vx = b.vx; b0.vy = b.vy;
      pieces.delete(ia); pieces.delete(ib);
      moved.add(A); moved.add(B);
      this.stats.touched++;
      out.push({ k: 'contact', tick: t, a: ia, b: ib, dvax, dvay, dvbx, dvby, speed: res.closing });
    }
    // (The tick's end: every body rounded to snapshot precision, as the server's are)
    for (const b of moved) quantizeShipBody(b.s.body);
  }

  touches(t: number, s: ReplicaState, others: Iterable<ReplicaState>): boolean {
    const a = this.shape(s.id, t);
    if (!a || !(a.mass > 0)) return false;
    for (const o of others) {
      if (o.id === s.id) continue;
      const b = this.shape(o.id, t);
      if (!b) continue;
      if (dhypot(o.body.x - s.body.x, o.body.y - s.body.y) <= a.radius + b.radius) return true;
    }
    return false;
  }

  dropFrom(t: number): void {
    this.cache.dropFrom(t);
  }

  reset(): void {
    this.cache.clear();
  }
}

/** Circles of radius r, pushed apart by inverse-mass shares, restitution on closing (the fake-transport tests' model) */
export class CircleContacts implements PtContacts {
  constructor(private readonly shape: (id: number) => { r: number; inv: number } | null, private readonly restitution = 0.3) {}

  pass(t: number, bodies: readonly PtBody[], out: SimEvent[]): void {
    const e = this.restitution;
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const A = bodies[i], B = bodies[j], ra = this.shape(A.s.id), rb = this.shape(B.s.id);
        if (!ra || !rb) continue;
        const a = A.s.body, b = B.s.body;
        const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy, r = ra.r + rb.r;
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2) || 1e-6, nx = d2 ? dx / d : 1, ny = d2 ? dy / d : 0;
        const inv = ra.inv + rb.inv || 1, sa = ra.inv / inv, sb = rb.inv / inv;
        const over = r - d;
        a.x -= nx * over * sa; a.y -= ny * over * sa;
        b.x += nx * over * sb; b.y += ny * over * sb;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        let dvax = 0, dvay = 0, dvbx = 0, dvby = 0;
        if (vn < 0) {
          const j2 = -(1 + e) * vn;
          dvax = -nx * j2 * sa; dvay = -ny * j2 * sa; dvbx = nx * j2 * sb; dvby = ny * j2 * sb;
          a.vx += dvax; a.vy += dvay; b.vx += dvbx; b.vy += dvby;
        }
        out.push({ k: 'contact', tick: t, a: A.s.id, b: B.s.id, dvax, dvay, dvbx, dvby, speed: -vn });
      }
    }
  }

  touches(_t: number, s: ReplicaState, others: Iterable<ReplicaState>): boolean {
    const a = this.shape(s.id);
    if (!a) return false;
    for (const o of others) {
      const b = this.shape(o.id);
      if (!b || o.id === s.id) continue;
      const dx = o.body.x - s.body.x, dy = o.body.y - s.body.y, r = a.r + b.r;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
}
