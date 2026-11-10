/**
 * @contract server.snapshot.rounds
 * owns:       when snapshot rounds are due: every CROWD_BASE_WINDOW ticks, a widened system's (crowd fallbacks) when its
 *             wider window comes round, and a system on a clock of its own in its own pass
 * needs:      CrowdControl (widened, windowOf), sim/SystemClocks SimPass, the server's tick; npm: @space-game/common
 * invariants: a round goes every CROWD_BASE_WINDOW ticks for unwidened systems — server/src/net/snapshot/snapshotParts.test.ts
 *             widened systems skip until their window comes round — server/src/net/crowd/crowd.test.ts
 * extend:     a new reason to skip a system's round is one `skip.add` in due()
 */
import { CROWD_BASE_WINDOW } from '@space-game/common';
import type { CrowdControl } from '../crowd/CrowdControl.js';
import { SimPass } from '../../sim/SystemClocks.js';

/** The systems a snapshot round is not for (a wider window not come round, a clock of their own): a Set will do */
export interface RoundSkip { has(system: number): boolean; readonly size: number }

export class RoundClock {
  /** Base tick of the last round, and each widened system's last (crowd fallbacks: its window, CrowdControl) */
  private lastRound = 0;
  private readonly lastWide = new Map<number, number>();
  private readonly lastOwn = new Map<number, number>();

  constructor(private readonly crowd: CrowdControl | null, private readonly ticks: { readonly currentTick: number }) {}

  /**
   * Once a tick: is a snapshot round due (every CROWD_BASE_WINDOW ticks, as always; false: not this tick)? It is for every
   * system but the ones returned, whose wider window (crowd fallbacks) hasn't come round yet (null: none)
   */
  due(): RoundSkip | null | false {
    const t = this.ticks.currentTick;
    if (t - this.lastRound < CROWD_BASE_WINDOW) return false;
    this.lastRound = t;
    let skip: Set<number> | null = null;
    // (Systems with a clock of their own have their rounds in their own passes: ownRound)
    if (!SimPass.all) for (const s of SimPass.own) (skip ??= new Set()).add(s);
    if (this.crowd) {
      for (const [sys, w] of this.crowd.widened()) {
        const last = this.lastWide.get(sys);
        if (last !== undefined && t - last < w) (skip ??= new Set()).add(sys);
        else this.lastWide.set(sys, t);
      }
      for (const sys of this.lastWide.keys()) if (this.crowd.windowOf(sys) <= CROWD_BASE_WINDOW) this.lastWide.delete(sys);
    }
    return skip;
  }

  /** A system with a clock of its own, in its pass: is its round due (its window, in its ticks)? The skip if so */
  ownRound(system: number): RoundSkip | false {
    const t = this.ticks.currentTick, last = this.lastOwn.get(system);
    const w = this.crowd?.windowOf(system) ?? CROWD_BASE_WINDOW;
    if (last !== undefined && t - last < w && t > last) return false;
    this.lastOwn.set(system, t);
    return { has: (s: number) => s !== system, size: 1 };
  }
}
