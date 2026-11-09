/**
 * @contract server.gameserver.wake-gap
 * owns:       what the loop does when the wall clock jumps (a Fly machine suspended and resumed, a laptop slept)
 * needs:      TICK_MS from @space-game/common
 * invariants: a gap over WAKE_GAP_MS is never simulated: the tick counter jumps by the gap's ticks, so tick-based timers
 *             (boss respawns, nests, world memory's world tick) advance by wall clock as for an empty system
 *             — server/src/gameServer/wakeGap.test.ts
 * extend:      none
 */

import { TICK_MS } from '@space-game/common';

/** A loop wakeup later than this since the last is a suspend/resume, not a slow tick (ms) */
export const WAKE_GAP_MS = 2000;

/** What the loop needs of the server */
export interface WakeGapHost {
  currentTick: number;
  tickAccumulator: number;
}

/**
 * Called with the ms since the loop last ran. Over WAKE_GAP_MS: skip it (no catch-up ticks, no accumulated time),
 * move the tick counter on by the ticks it spans, log, and return the ticks skipped; else 0.
 */
export function skipWakeGap(gs: WakeGapHost, deltaMs: number, log: (msg: string) => void = (m) => console.log(`[Loop] ${m}`)): number {
  if (!(deltaMs > WAKE_GAP_MS)) return 0;
  const ticks = Math.floor(deltaMs / TICK_MS);
  gs.currentTick += ticks;
  gs.tickAccumulator = 0;
  log(`woke after a ${Math.round(deltaMs / 1000)} s gap: skipped ${ticks} ticks (no catch-up)`);
  return ticks;
}
