/**
 * @contract server.gun-range.target
 * owns:       one of the gun range's targets: standing while anyone is in the range, put away when nobody is, back whole a
 *             few seconds after it is destroyed, and flown back to its spot when it has been pushed off it
 * needs:      TargetHost (spawn, alive, remove, steer, where); npm: @space-game/common (dhypot, GunRangeTargetDef)
 * invariants: it comes back after respawnSeconds and is gone while the range is empty; pushed beyond keepRadius it is
 *             steered home and let go near its spot — server/src/game/gunRange/gunRange.test.ts
 * extend:     another target is another entry of systems.json gunRange.targets (GunRange makes a RangeTarget for each and ticks them)
 *
 * A target with `mob` is a mob laid at its spot instead (Mobs: one that sits still, a mine): it is never steered, bursts
 * like any of its kind, and comes back the same way.
 * The target is a live ship (Enemies.spawnTarget: no AI, never fires, pays nothing), not pinned: shots, beams and
 * collisions treat it as every client's prediction treats any ship. It holds still by itself (no controls: CTL.hold, and
 * friction) and is heavy, so a ram only nudges it; past keepRadius its autopilot flies it home, which clients replay from
 * its controls like any pilotless ship's.
 */

import type { GunRangeTargetDef } from '@space-game/common';
import { dhypot } from '@space-game/common';

export interface TargetHost {
  /** A target ship (or, `def.mob`, a mob) at its spot: its entity (-1: couldn't) */
  spawn(def: GunRangeTargetDef): number;
  /** Is this target still there (not destroyed, burst or timed out) */
  alive(eid: number): boolean;
  /** Take it away (the range is empty) */
  remove(eid: number): void;
  /** Fly it to a spot, or (null) let it hold still where it is */
  steer(eid: number, to: { x: number; y: number; arriveRadius: number } | null): void;
  where(eid: number): { x: number; y: number };
}

const TPS = 60;
/** How often (ticks) it looks to see whether it has been pushed off its spot */
const KEEP_EVERY = 15;
/** Steered home, it is let go this far (a share of keepRadius) from its spot */
const LET_GO = 0.3;

export class RangeTarget {
  /** The ship (-1: none standing) */
  eid = -1;
  private deadAt = -1;
  private steering = false;

  constructor(private readonly host: TargetHost, readonly def: GunRangeTargetDef) {}

  /** One tick. `occupied`: someone is in the range. True when the target's entity changed (it went down or came back) */
  tick(now: number, occupied: boolean): boolean {
    if (!occupied) {
      const had = this.eid >= 0;
      if (had) this.host.remove(this.eid);
      this.eid = -1;
      this.deadAt = -1;
      this.steering = false;
      return had;
    }
    if (this.eid >= 0 && !this.host.alive(this.eid)) {
      this.eid = -1;
      this.deadAt = now;
      this.steering = false;
      return true;
    }
    if (this.eid < 0) {
      if (this.deadAt >= 0 && now - this.deadAt < this.def.respawnSeconds * TPS) return false;
      this.eid = this.host.spawn(this.def);
      this.deadAt = this.eid >= 0 ? -1 : now;
      return this.eid >= 0;
    }
    if (now % KEEP_EVERY === 0 && !this.def.mob) this.keep();
    return false;
  }

  /** Pushed off its spot: flown home, and let go near it */
  private keep(): void {
    const at = this.host.where(this.eid), d = dhypot(at.x - this.def.x, at.y - this.def.y), r = this.def.keepRadius;
    if (!this.steering && d > r) {
      this.steering = true;
      this.host.steer(this.eid, { x: this.def.x, y: this.def.y, arriveRadius: r * LET_GO });
    } else if (this.steering && d < r * LET_GO) {
      this.steering = false;
      this.host.steer(this.eid, null);
    }
  }

  isTarget(eid: number): boolean {
    return eid >= 0 && eid === this.eid;
  }
}
