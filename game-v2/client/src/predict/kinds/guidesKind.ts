/**
 * @contract client.predict.kind.guides
 * owns:       homing shells and mobs on the PT timeline: forks GuideRunner runs from ST and steps the copy to the PT head
 * needs:      @space-game/common (guideHash, GuideBody), GuideRunner (GuideFork), ptKinds, a GuidesKindHost
 * invariants: a hash miss at the confirmed tick re-forks from ST once and eases the drawn place — client/src/predict/kindInvariants.test.ts
 * extend:     a change to the waypoint law belongs in common/guidance, not here; the kind is registered in worldKinds.ts
 */
/**
 * Homing shells and mobs (mites, seekers: GuideRunner's runs) on the PT timeline. The snapshots step each to the
 * confirmed tick (ST); this kind copies each run there (GuideRunner.fork) and steps the copy on to the PT head by the
 * shared waypoint law, its target read off the replica layer at those ticks (your own ship: its prediction; another
 * ship: its PT on the replica layer), recording a state and its hash (guideHash) a tick.
 *
 *   confirm   the run's ST at c against the hash recorded at c; a miss (a waypoint the server sent, a target that
 *             went elsewhere, a LOST or TARGET record) copies the run again from ST(c), steps it to the head once,
 *             and the drawn place eases from the old PT head to the new
 *   draw      at its PT draw tick (non-pilot: where your shells meet it), between the two stepped ticks either side
 */
import { guideHash, wrapPi, type GuideBody } from '@space-game/common';
import type { GuideFork } from '../../ships/guides/GuideRunner';
import { PtEase, noPtStats, type PoseXY, type PtKind } from '../ptKinds';

export interface GuidesKindHost {
  /** The shells and mobs the snapshots run (GuideRunner.ids) */
  ids(): Iterable<number>;
  /** ST: a copy of one's run as its last stepped tick ended */
  fork(id: number): GuideFork | null;
  /** One tick of a copy (GuideRunner.stepFork) */
  step(id: number, f: GuideFork, t: number): void;
  lerpMs?: number;
  now?(): number;
}

interface Track { f: GuideFork; states: Map<number, GuideBody>; hashes: Map<number, number> }

const poseOf = (m: GuideBody): PoseXY => ({ x: m.x, y: m.y, angle: m.a ?? Math.atan2(m.vy, m.vx) });

export class GuidesKind implements PtKind {
  readonly name = 'guides';
  readonly order = 20;
  readonly stats = noPtStats();
  readonly ease: PtEase;
  private readonly tracks = new Map<number, Track>();
  private confirmed = -Infinity;
  private head = -Infinity;
  private readonly now: () => number;

  constructor(private readonly host: GuidesKindHost) {
    this.now = host.now ?? (() => performance.now());
    this.ease = new PtEase(host.lerpMs ?? 150, this.now);
  }

  reset(): void {
    this.tracks.clear();
    this.ease.clear();
    this.confirmed = this.head = -Infinity;
    Object.assign(this.stats, noPtStats());
  }

  has(id: number): boolean {
    return this.tracks.has(id);
  }

  confirm(c: number): void {
    if (c <= this.confirmed) return;
    this.confirmed = c;
    const t0 = this.now();
    let any = false;
    for (const [id, tr] of this.tracks) {
      const st = this.host.fork(id);
      if (!st) continue;
      // (ST is as its last stepped tick ended: the snapshot's)
      const h = tr.hashes.get(st.last);
      for (const k of tr.hashes.keys()) if (k < st.last) { tr.hashes.delete(k); tr.states.delete(k); }
      if (h === undefined) continue;
      this.stats.checks++;
      if (guideHash(id, st.m) === h) { this.stats.matches++; continue; }
      this.stats.misses++;
      any = true;
      const to = Math.max(tr.f.last, st.last), was = tr.states.get(to);
      this.stats.restepThings++;
      this.stats.restepTicks += to - st.last;
      this.seed(id, st, to);
      const now = this.tracks.get(id)?.states.get(to);
      if (was && now) {
        const d = this.ease.moved(id, poseOf(was), poseOf(now));
        if (d > 0) { this.stats.corrections++; this.stats.correctionDist += d; }
      }
    }
    if (any) { this.stats.resteps++; this.stats.restepMs += this.now() - t0; }
  }

  advance(to: number): void {
    if (this.confirmed === -Infinity) return;
    const t0 = this.now();
    const live = new Set(this.host.ids());
    for (const id of this.tracks.keys()) if (!live.has(id)) { this.tracks.delete(id); this.ease.drop(id); }
    for (const id of live) {
      const tr = this.tracks.get(id);
      if (!tr) { const st = this.host.fork(id); if (st) this.seed(id, st, to); continue; }
      while (tr.f.last < to) this.stepOne(id, tr);
    }
    if (to > this.head) { this.stats.ticks += Number.isFinite(this.head) ? to - this.head : 1; this.head = to; }
    this.stats.advanceMs += this.now() - t0;
  }

  /** Where it's drawn at tick t (as tick t ended), between the stepped ticks either side, eased */
  pose(id: number, t: number): PoseXY | null {
    const tr = this.tracks.get(id);
    if (!tr) return null;
    const f = Math.min(Math.floor(t), tr.f.last), a = tr.states.get(f);
    if (!a) return null;
    const b = tr.states.get(f + 1) ?? a, k = Math.max(0, Math.min(1, t - f));
    const pa = poseOf(a), pb = poseOf(b);
    return this.ease.apply(id, { x: pa.x + (pb.x - pa.x) * k, y: pa.y + (pb.y - pa.y) * k, angle: pa.angle + wrapPi(pb.angle - pa.angle) * k });
  }

  /** Its PT afresh from a copy of its ST run, stepped to `to` */
  private seed(id: number, st: GuideFork, to: number): void {
    const tr: Track = { f: st, states: new Map([[st.last, { ...st.m }]]), hashes: new Map([[st.last, guideHash(id, st.m)]]) };
    this.tracks.set(id, tr);
    while (tr.f.last < to) this.stepOne(id, tr);
  }

  private stepOne(id: number, tr: Track): void {
    const t = tr.f.last + 1;
    this.host.step(id, tr.f, t);
    tr.states.set(t, { ...tr.f.m });
    tr.hashes.set(t, guideHash(id, tr.f.m));
    this.stats.steps++;
  }
}
