/**
 * @contract network.replication.debris
 * owns:       the client's debris world inside the replica set: every piece stepped all together a tick at a time (drift,
 *             then knocks), as the server steps it, and stepped again from the earliest tick a keyframe or new piece changed
 * needs:      common/ships/debris (stepDebrisWorld), ships/physics (SHIP_FLIGHT_CONSTANTS), sim/ring, sim/c-replicaState,
 *             network/replication/rep and hooks (DebrisWorld)
 * invariants: a control row or a rewind for a piece already stepped past leaves it moving, not frozen —
 *             common/src/network/replicaSmoothing.test.ts
 * extend:     what a piece asks of the client (its shape, life, rebuild point) is a DebrisWorld member (hooks.ts)
 */

import { ReplicaMode, type ReplicaEnv, type ShipTuning } from '../../ships/index.js';
import { stepDebrisWorld, type DebrisBody } from '../../ships/debris.js';
import { SHIP_FLIGHT_CONSTANTS } from '../../ships/physics.js';
import type { StateRing } from '../../sim/ring.js';
import { ReplicaState } from '../../sim/c-replicaState.js';
import { cloneBody, dropKeepingKf, rewrote, type Rep } from './rep.js';
import type { DebrisWorld } from './hooks.js';

/** Debris is stepped all together (drift, then knocks: common ships/debris.ts), as on the server */
export class DebrisSteps {
  /** Stepped through this tick */
  last = -Infinity;
  /** ...and from this tick on it must be stepped again (a keyframe or a new piece came for an earlier tick) */
  dirty = Infinity;

  constructor(
    private readonly ring: StateRing,
    private readonly reps: ReadonlyMap<number, Rep>,
    private readonly debris: DebrisWorld | undefined,
    private readonly env: () => ReplicaEnv,
    private readonly tuning: ShipTuning,
  ) {}

  /** Stepped again from tick t + 1 on (a keyframe or a new piece for tick t, or a rewind) */
  stale(t: number): void {
    this.dirty = Math.min(this.dirty, t);
  }

  /**
   * Every piece of debris to tick `to`, a tick at a time and all together, in id order: each drifts, then pieces that
   * overlap are pushed apart (stepDebrisWorld, the server's step). A keyframe (or a new piece) is its state at the end
   * of its tick, after that tick's step on the server: it takes no part in that tick's step, and joins in from the next.
   * A keyframe or new piece for a tick already stepped makes them all step again from there.
   */
  stepTo(to: number): void {
    if (to <= this.last && this.dirty > this.last) return;
    const drift: [number, Rep][] = [];
    const ring = this.ring;
    for (const e of this.reps) if (e[1].mode === ReplicaMode.Drift && ring.size(e[0])) drift.push(e);
    if (!drift.length) { this.last = Math.max(this.last, to); this.dirty = Infinity; return; }
    drift.sort((a, b) => a[0] - b[0]);
    let from = Math.min(this.last, this.dirty);
    if (from === -Infinity) { from = Infinity; for (const [, r] of drift) from = Math.min(from, r.kf); }
    // (Stepped again from `from`: what came after it goes, bar keyframes)
    for (const [id, r] of drift) {
      dropKeepingKf(ring, id, r, from + 1);
      rewrote(r, from + 1);
    }
    const env = this.env();
    const k = env.gravity ? { ...SHIP_FLIGHT_CONSTANTS, gravity: env.gravity } : SHIP_FLIGHT_CONSTANTS;
    const cs = this.tuning.cellSize, restitution = this.tuning.collision?.restitution ?? 0.3;
    const end = Math.min(to, from + 600);
    const list: DebrisBody[] = [], reps: Rep[] = [];
    for (let t = from + 1; t <= end; t++) {
      list.length = reps.length = 0;
      for (const [id, r] of drift) {
        // (its keyframe or spawn is this tick's end: kept as it is)
        if (r.kf === t) continue;
        const prev = ring.get(id, t - 1);
        if (!prev || this.debris?.gone?.(id, t)) continue;
        const shape = this.debris?.shape(id, t);
        list.push({ id, body: cloneBody(prev.body), mass: shape?.mass ?? 0, radius: shape?.radius ?? 0, com: shape?.com ?? [0, 0], pieces: shape?.pieces ?? [], born: shape?.born });
        reps.push(r);
      }
      stepDebrisWorld(list, k, cs, restitution, t);
      for (let i = 0; i < list.length; i++) {
        // (A piece it runs: its rebuild point; nothing left of it, it has no state at t's end, and isn't stepped again)
        if (this.debris?.after && !this.debris.after(list[i].id, t, list[i].body)) continue;
        ring.keep(t, new ReplicaState(list[i].id, ReplicaMode.Drift, list[i].body, 0, 0));
      }
    }
    // (Stepped again from `from`, it's been stepped to `end` only: what came after went in the rewind. The ring keeps
    // the window)
    this.last = end;
    this.dirty = Infinity;
  }
}
