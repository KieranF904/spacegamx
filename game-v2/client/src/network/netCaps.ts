/**
 * The server's `netCaps` message, the client's side. Every client joins with the full set (common network/hits.ts
 * DEFAULT_CAPS, Game.ts's join); there are no per-cap switches. The message only says how much later frames may come
 * (coalescing: `hold` ticks) and how closely its hits are checked (`lvl`, adaptive validation).
 */
import { TICK_MS, confirmRules } from '@space-game/common';

/**
 * How much later frames may come (coalescing: the server's netCaps.hold says how many ticks they may wait), and how much
 * later its confirmation level wants them shown (netCaps.lvl: STRICT's two ticks, so every hit's record is in before
 * the frames that show it): the interpolation delay grows by as much (ms)
 */
export function coalesceDelayMs(hold = 0, lvl?: number): number {
  const coalesce = Math.max(0, Math.min(30, hold));
  return (coalesce + confirmRules(lvl).delayTicks) * TICK_MS;
}
