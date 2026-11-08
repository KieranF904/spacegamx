/**
 * @contract server.gameserver.faults
 * owns:       crash isolation: logging and counting errors by place
 * needs:      GameServer (type), activity
 * invariants: behaviour is unchanged from the class it was split from — none pinned
 * extend:      n/a
 */

import { activity } from '../activity/index.js';
import type { GameServer } from '../GameServer.js';

export function fault(gs: GameServer, where: string, e: unknown): void {
  const now = Date.now();
  let f = gs.faults.get(where);
  if (!f) { f = { count: 0, unlogged: 0, loggedAt: 0 }; gs.faults.set(where, f); }
  f.count++;
  activity.error(where, e);
  if (now - f.loggedAt < 10_000) { f.unlogged++; return; }
  const more = f.unlogged ? ` (and ${f.unlogged} more since the last report)` : '';
  f.loggedAt = now;
  f.unlogged = 0;
  console.error(`[Fault] ${where} threw at tick ${gs.currentTick}${more}:`, e);
}

/** Errors caught so far, by where (admin stats, tests) */
export function faultCounts(gs: GameServer): Record<string, number> {
  return Object.fromEntries([...gs.faults].map(([k, f]) => [k, f.count]));
}
