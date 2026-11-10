/**
 * @contract client.predict.kind.bodies
 * owns:       PT bookkeeping for bodies the replica layer flies from their decisions (bosses): hash by tick, confirm against ST, ease the drawn pose
 * needs:      @space-game/common, ptKinds (PtKind, PtEase), a BodiesKindHost (ids, at)
 * invariants: a body whose recorded hash misses ST is re-read to the PT head once, never stepped on the PT layer itself — client/src/predict/kindInvariants.test.ts
 * extend:     a new kind of body is a host ids() source; the kind itself is registered in worldKinds.ts at order 10
 */
/**
 * Bodies on the PT timeline: ships the replica layer flies from their decisions whose PT isn't the ship layer's
 * (bosses: BodyRunner runs them, their hits told; the ship layer, PtStLayer, holds pilots and the AI it can push). The
 * replica layer already steps such a body to any tick from its decisions (BodyRunner's driver), and a snapshot's
 * decisions rewind it where they land: this kind is the PT bookkeeping round that.
 *
 *   advance   each body read off the replica layer up to the PT head, its state hashed by tick (shipHash)
 *   confirm   ST(c), the replica layer at c now the snapshot's decisions are in, against the hash recorded at c; a
 *             miss (a decision PT couldn't know, a keyframe) re-reads it to the head once (the replica layer steps it
 *             again from where the decision landed) and the drawn pose eases from the old head to the new
 *   draw      at its PT draw tick (Timeline 'ahead': where your shells meet it), placed by the replica layer, eased
 */
import { shipHash, type ReplicaState } from '@space-game/common';
import { PtEase, noPtStats, type PoseXY, type PtKind } from '../ptKinds';

export interface BodiesKindHost {
  /** The bodies to keep on PT now (bosses) */
  ids(): Iterable<number>;
  /** Its state as tick t ended on the replica layer (stepped there if need be); null: none */
  at(id: number, t: number): ReplicaState | null;
  lerpMs?: number;
  now?(): number;
}

interface Track { hashes: Map<number, number>; head: number }

export class BodiesKind implements PtKind {
  readonly name = 'bodies';
  readonly order = 10;
  readonly stats = noPtStats();
  readonly ease: PtEase;
  private readonly tracks = new Map<number, Track>();
  private confirmed = -Infinity;
  private readonly now: () => number;

  constructor(private readonly host: BodiesKindHost) {
    this.now = host.now ?? (() => performance.now());
    this.ease = new PtEase(host.lerpMs ?? 150, this.now);
  }

  reset(): void {
    this.tracks.clear();
    this.ease.clear();
    this.confirmed = -Infinity;
    Object.assign(this.stats, noPtStats());
  }

  has(id: number): boolean {
    return this.tracks.has(id);
  }

  /** A pose the replica layer placed at its draw tick, with what's left of its ease */
  eased(id: number, p: PoseXY): PoseXY {
    return this.ease.apply(id, p);
  }

  confirm(c: number): void {
    if (c <= this.confirmed) return;
    this.confirmed = c;
    const t0 = this.now();
    let any = false;
    for (const [id, tr] of this.tracks) {
      const h = tr.hashes.get(c);
      for (const k of tr.hashes.keys()) if (k < c) tr.hashes.delete(k);
      if (h === undefined) continue;
      const st = this.host.at(id, c);
      if (!st) continue;
      this.stats.checks++;
      if (shipHash(st) === h) { this.stats.matches++; continue; }
      this.stats.misses++;
      // (re-stepped once, to the head: the replica layer steps it again from where the snapshot's decisions landed)
      tr.hashes.clear();
      for (let t = c; t <= tr.head; t++) { const s = this.host.at(id, t); if (s) tr.hashes.set(t, shipHash(s)); }
      this.stats.restepThings++;
      this.stats.restepTicks += tr.head - c;
      any = true;
      // (drawn from where PT had its head before, eased onto where it has it now)
      const now = this.host.at(id, tr.head), was = this.lastHead.get(id);
      if (now && was) {
        const to = { x: now.body.x, y: now.body.y, angle: now.body.angle };
        const d = this.ease.moved(id, was, to);
        if (d > 0) { this.stats.corrections++; this.stats.correctionDist += d; }
        this.lastHead.set(id, to);
      }
    }
    if (any) { this.stats.resteps++; this.stats.restepMs += this.now() - t0; }
  }

  /** Each body's head pose as PT last stepped it (the replica layer's own may have been rewound since) */
  private readonly lastHead = new Map<number, PoseXY>();

  advance(to: number): void {
    if (this.confirmed === -Infinity) return;
    const t0 = this.now();
    const live = new Set(this.host.ids());
    for (const id of this.tracks.keys()) if (!live.has(id)) { this.tracks.delete(id); this.lastHead.delete(id); this.ease.drop(id); }
    for (const id of live) {
      let tr = this.tracks.get(id);
      if (!tr) { tr = { hashes: new Map(), head: this.confirmed }; this.tracks.set(id, tr); }
      for (let t = Math.max(tr.head + 1, this.confirmed); t <= to; t++) {
        const s = this.host.at(id, t);
        if (!s) break;
        tr.hashes.set(t, shipHash(s));
        tr.head = t;
        this.stats.steps++;
      }
      const h = this.host.at(id, tr.head);
      if (h) this.lastHead.set(id, { x: h.body.x, y: h.body.y, angle: h.body.angle });
    }
    if (to > this.head) { this.stats.ticks += Number.isFinite(this.head) ? to - this.head : 1; this.head = to; }
    this.stats.advanceMs += this.now() - t0;
  }

  private head = -Infinity;
}
