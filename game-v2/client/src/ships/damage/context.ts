/**
 * @contract client.damage.context
 * owns:       what the damage effect modules share: the particle field, the world (ships, entities), the sound hook, the
 *             effects clock and its delayed actions
 * needs:      DamageParticles, ShipSource, GameState
 * invariants: a delayed action runs once, on the first update at or after its time — client/src/ships/damage/context.test.ts
 * extend:     a shared capability for every effect is one member here
 */

import type { GameState } from '../../state/GameState';
import type { ShipSource } from '../ShipStore';
import type { DamageParticles } from './particles';

export type Sound = (id: string, at?: { x: number; y: number }, volume?: number) => void;

interface Pending { at: number; run: () => void }

export class DamageCtx {
  /** Seconds on the effects' clock */
  time = 0;
  /** When a crumble last played its sound (they are throttled) */
  lastCrumbleSound = 0;
  private pending: Pending[] = [];

  constructor(
    readonly p: DamageParticles,
    readonly source: ShipSource,
    readonly state: GameState,
    readonly sound: Sound,
    readonly repairRange: number,
  ) {}

  /** Runs the delayed actions that have come due */
  runPending(): void {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].at > this.time) continue;
      const p = this.pending[i];
      this.pending.splice(i, 1);
      p.run();
    }
  }

  later(seconds: number, run: () => void): void {
    this.pending.push({ at: this.time + seconds, run });
  }

  near(x: number, y: number, r: number): boolean {
    const me = this.state.entities.get(this.state.playerId);
    return !!me && Math.hypot(me.renderX - x, me.renderY - y) < r;
  }

  /** World position and velocity of a part as drawn now */
  partWorld(bodyId: number, part: number): { x: number; y: number; vx: number; vy: number } | null {
    const ship = this.source.get(bodyId);
    const e = this.state.entities.get(bodyId);
    if (!ship || !e) return null;
    const c = this.source.geometry(ship)[part]?.centroid;
    if (!c) return null;
    const cs = this.source.tuning.cellSize;
    const lx = (c[0] - ship.derived.com[0]) * cs, ly = (c[1] - ship.derived.com[1]) * cs;
    const a = e.renderAngle + Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    return { x: e.renderX + lx * ca - ly * sa, y: e.renderY + lx * sa + ly * ca, vx: e.vx, vy: e.vy };
  }
}
