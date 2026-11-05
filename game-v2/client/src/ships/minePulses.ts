/**
 * A ports ship's mining lasers (power/ports.ts portsMineStep): each runs fixed pulses of its own length and cuts by its
 * fulfilment, the share of its draw it got. Your own from your predicted ports state, tick for tick; another ship's from
 * the tick the server started each pulse (a TELL_MINE_PULSE fire event, which carries the fulfilment it started at), on
 * the timeline that ship is drawn on. MiningBeamFx draws them. No Pixi here.
 */

import { miningPulse, portsMinePhase, pulseProfile, type PortsState, type PulseProfile, type ShipState } from '@space-game/common';
import type { GameState } from '../state/GameState';

/** One ship's miners this frame (by miner index): ticks into its pulse (-1 none), fulfilment 0..1, its pulse's length and curve */
export interface MineFrame { any: boolean; phase: number[]; fill: number[]; ticks: number[]; prof: PulseProfile[] }

export class MinePulses {
  private at = new Map<number, { tick: number; fill: number }>();
  private frame: MineFrame = { any: false, phase: [], fill: [], ticks: [], prof: [] };

  /** A pulse started on `tick` at `fill` (a TELL_MINE_PULSE fire event) */
  start(owner: number, part: number, tick: number, fill: number): void {
    this.at.set(owner * 256 + part, { tick, fill: Math.max(0, Math.min(1, fill)) });
    while (this.at.size > 256) this.at.delete(this.at.keys().next().value!);
  }

  /** The ship's miners now (a shared record, rewritten each call) */
  read(ship: ShipState, id: number, own: boolean, state: GameState): MineFrame {
    const L = ship.derived.ports!, f = this.frame, ms = ship.derived.miners;
    f.any = false;
    f.phase.length = f.fill.length = f.ticks.length = f.prof.length = ms.length;
    const e = own ? (state.charge?.e as PortsState | undefined) : undefined;
    const present = state.getRawServerTick(), now = state.predictionEnabled ? present - state.interpDelayMs / (1000 / 60) : present;
    for (let i = 0; i < ms.length; i++) {
      const p = ms[i].part, T = Math.max(1, L.minePulse[p] || 54);
      f.ticks[i] = T;
      f.prof[i] = pulseProfile(miningPulse(T));
      if (own) {
        const ok = !!e && e.held.length === L.n;
        f.phase[i] = ok ? portsMinePhase(L, e!, p) : -1;
        f.fill[i] = ok ? e!.sat[p] / 255 : 1;
      } else {
        const s = this.at.get(id * 256 + p), ph = s ? now - s.tick : -1;
        f.phase[i] = s && ph >= 0 && ph < T ? ph : -1;
        f.fill[i] = s ? s.fill : 1;
      }
      if (f.phase[i] >= 0) f.any = true;
    }
    return f;
  }
}
