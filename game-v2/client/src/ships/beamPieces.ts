/**
 * Beams in pieces (power/ports.ts portsBeamStep; FunctionDef.profile.pieces): how a piece's pulse looks. A piece lights
 * for its fixed time, swells to a peak at its centre (where its damage spikes: the layout's spike window), and goes out
 * or hands straight on to the next. Your own beam's phase comes from your predicted ports state; another ship's from the
 * tick the server spent the piece (a TELL_BEAM_PIECE fire event), on the timeline that ship is drawn on. Pure: no Pixi.
 */

import { PF_LIT, type PortsLayout, type PortsState } from '@space-game/common';

/** What a piece's moment does to a beam's look: x its width and x its brightness */
export interface PieceLook { width: number; gain: number }

const look: PieceLook = { width: 1, gain: 1 };

/**
 * A piece's look `phase` ticks in (fractional; -1 or past its end: not lit, gain 0). The swell is a smooth bump on the
 * damage spike's window, as tall as the spike is sharp (spikeIn over spikeOut), with a quick fade in and out at its ends.
 * Returns a shared record
 */
export function pieceLook(L: PortsLayout, p: number, phase: number): PieceLook {
  const T = L.pieceT[p];
  if (phase < 0 || phase >= T + 1 || T <= 0) { look.width = 1; look.gain = 0; return look; }
  const lo = L.spikeLo[p], hi = L.spikeHi[p], c = (lo + hi) / 2, half = Math.max(1, (hi - lo) / 2);
  const sharp = L.spikeOut[p] > 0 ? Math.min(4, L.spikeIn[p] / L.spikeOut[p]) : 1;
  const bump = Math.exp(-(((phase - c) / (half * 1.3)) ** 2));
  const edge = Math.min(1, phase / 1.5, (T + 1 - phase) / 2.5);
  look.width = (0.8 + 0.35 * (sharp - 1) * bump) * (0.6 + 0.4 * edge);
  look.gain = Math.min(1.35, 0.78 + 0.6 * bump) * edge;
  return look;
}

/** Your own beam's phase now (ticks, fractional with `frac` of a tick since the last), or -1: from your predicted state */
export function ownPiecePhase(L: PortsLayout, e: PortsState | undefined, p: number, frac: number): number {
  if (!e || e.held.length !== L.n || !L.pieces[p] || !(e.flags[p] & PF_LIT)) return -1;
  return L.pieceT[p] - e.closed[p] + Math.max(0, Math.min(1, frac));
}

/** Other ships' pieces: when each beam (ship × 256 + part) last spent one, by the server's tick */
export class PieceStarts {
  private at = new Map<number, number>();

  /** A piece spent on `tick` (a TELL_BEAM_PIECE fire event) */
  start(owner: number, part: number, tick: number): void {
    this.at.set(owner * 256 + part, tick);
    while (this.at.size > 256) this.at.delete(this.at.keys().next().value!);
  }

  /** Ticks into its newest piece at `now` (the tick that ship is drawn at), or -1 when it has none under way */
  phase(owner: number, part: number, now: number, T: number): number {
    const s = this.at.get(owner * 256 + part);
    if (s === undefined) return -1;
    const ph = now - s;
    if (ph > T + 600) this.at.delete(owner * 256 + part);
    return ph >= 0 && ph < T + 1 ? ph : -1;
  }
}
