/**
 * Every enemy's recovery (docs/bosses/rework-2026-11.md 8; the timings: common bosses/lifecycle.ts LIFE): packs, AI
 * ships, custom enemies and bosses without a lifecycle of their own. One that has neither dealt nor taken damage for
 * LIFE.idle ticks heals, every part alike, full LIFE.heal ticks after the heal starts; at its end its lost parts regrow
 * (one full repair: one rebuild, batched at the tick's rebuild point). Any damage, dealt or taken, stops the heal; it
 * starts again after the next LIFE.idle quiet ticks.
 *
 * Only enemies that were hurt are kept (from the damage report), so the cost is the wounded, not every hostile.
 * Custom enemies heal their standing pieces only: their lost groups travel as decisions (common bodies/custom), and
 * regrowing them is still to do.
 */

import { LIFE } from '@space-game/common';

export interface RecoveryHost {
  tick(): number;
  /** An enemy that heals this way: alive, hostile, not a lair boss with a lifecycle of its own */
  heals(eid: number): boolean;
  /** Its system steps this pass (crowd dilation: each system heals at its own ticks) */
  active(eid: number): boolean;
  /** A custom enemy (its standing pieces heal; lost ones don't regrow yet) */
  custom(eid: number): boolean;
  /** The last tick it dealt or took damage */
  lastCombat(eid: number): number;
  /** Every part healed by this share of its max */
  heal(eid: number, share: number): void;
  /** Full repair: lost parts regrown, every part full */
  restore(eid: number): void;
}

/** Heal steps (ticks apart) */
const STEP = 30;

export class EnemyRecovery {
  /** The wounded: when each was last seen hurt (its combat clock may know of later fights, never of none) */
  private wounded = new Map<number, number>();

  constructor(private host: RecoveryHost) {}

  /** It took damage from `source` (its own, a split or a crumble: not a wound): keep an eye on it */
  hurt(eid: number, source = -1): void {
    if (source !== eid && this.host.heals(eid)) this.wounded.set(eid, this.host.tick());
  }

  /** How many are being watched (tests) */
  get size(): number {
    return this.wounded.size;
  }

  /** The tick its heal started (or will), from its last combat */
  healFrom(eid: number): number {
    return Math.max(this.host.lastCombat(eid), this.wounded.get(eid) ?? -Infinity) + LIFE.idle;
  }

  tick(): void {
    const now = this.host.tick();
    for (const eid of this.wounded.keys()) {
      if (!this.host.heals(eid)) { this.wounded.delete(eid); continue; }
      if (!this.host.active(eid)) continue;
      const from = this.healFrom(eid);
      if (now < from) continue;
      if (now >= from + LIFE.heal) {
        if (!this.host.custom(eid)) this.host.restore(eid);
        else this.host.heal(eid, 1);
        this.wounded.delete(eid);
        continue;
      }
      if ((now - from) % STEP === 0 && now > from) this.host.heal(eid, STEP / LIFE.heal);
    }
  }
}
