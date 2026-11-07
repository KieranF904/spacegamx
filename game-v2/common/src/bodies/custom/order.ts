/**
 * A custom enemy's engage order (bodies/aiPilot.ts AI_ORDER.CUSTOM), whole numbers only: the enemy AI's ENGAGE with its
 * design, the pieces it has lost and the move under way in fixed places before its pack's mates
 *
 *   [4, range, reach, hitBy, errMax, seed, strafe, flank, design, gone, move + 1, arg, mseed, mstart, ...mates]
 *
 * design: its index in bodies/custom/roster.json; gone: its groups gone (one byte, a bit each: groups.ts); move + 1: the
 * move under way (0: none), from tick mstart, with its argument (an angle q13, or a small number) and an 8-bit seed for
 * any rolls in it (the commander rolled it: decision-inputs rule 2). A move is one WANT: it holds until the next.
 */

import type { WantRec } from '../decisions.js';
import { ENGAGE_MATES } from '../aiLead.js';

/** The order's places */
export const CO = { RANGE: 1, REACH: 2, HIT_BY: 3, ERR: 4, SEED: 5, STRAFE: 6, FLANK: 7, DESIGN: 8, GONE: 9, MOVE: 10, ARG: 11, MSEED: 12, MSTART: 13, MATES: 14 } as const;

/** A move under way: its index in its design's moves, its argument, seed and start tick */
export interface MoveOrder { move: number; arg: number; seed: number; start: number }

/** An enemy AI ENGAGE order ([2, ...7 places, lead (3), ...mates]) as a custom one: its design, pieces gone and move put in (no lead: it fires no part guns) */
export function customOrder(engage: WantRec, kind: number, design: number, gone: number, m: MoveOrder | null): WantRec {
  const out = [kind, ...engage.slice(1, 8), design, gone & 255, m ? m.move + 1 : 0, m ? m.arg : 0, m ? m.seed & 255 : 0, m ? Math.max(0, m.start) : 0];
  for (let i = ENGAGE_MATES; i < engage.length; i++) out.push(engage[i]);
  return out;
}

/** The move an order has under way at tick t (null: none, or it's over: `ticks` its length) */
export function moveAt(w: WantRec, t: number, ticks: (move: number) => number): { move: number; k: number } | null {
  const m = (w[CO.MOVE] ?? 0) - 1;
  if (m < 0) return null;
  const k = t - w[CO.MSTART];
  return k >= 0 && k < ticks(m) ? { move: m, k } : null;
}
