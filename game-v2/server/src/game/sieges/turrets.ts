/**
 * What a turret fires on: a hostile a pilot marked (focus fire), if it's in
 * reach; else the best in reach by the turret's orders (TURRET_ORDERS: a new
 * priority is an entry here). Given to the host as the turret's `pick`.
 */

import { Position, Velocity } from '@space-game/common';
import type { Run, SiegeCtx } from './types.js';

interface Candidate { eid: number; d: number; x: number; y: number; cost: number; boss: boolean }

export interface TurretOrders {
  id: string;
  /** Lower is better */
  rank(c: Candidate, run: Run, ctx: SiegeCtx): number;
}

const bastionDist = (c: Candidate, run: Run) => { const b = run.sys.surface!.bastion!; return Math.hypot(c.x - b.x, c.y - b.y); };

export const TURRET_ORDERS: Record<string, TurretOrders> = {
  nearest: { id: 'nearest', rank: (c) => c.d },
  bastion: { id: 'bastion', rank: (c, run) => bastionDist(c, run) },
  toughest: { id: 'toughest', rank: (c) => -(c.boss ? 1e6 : 0) - c.cost * 1000 + c.d * 0.01 },
  fastest: { id: 'fastest', rank: (c) => -Math.hypot(Velocity.x[c.eid], Velocity.y[c.eid]) * 1000 + c.d * 0.01 },
};

export const DEFAULT_ORDERS = 'nearest';

/** The orders a pad can be given, for the panel */
export function ordersList(ctx: SiegeCtx): { id: string; label: string }[] {
  return Object.keys(TURRET_ORDERS).map((id) => ({ id, label: ctx.t(`sieges.orders.${id}` as never) }));
}

/** What the turret on pad `slot` fires on now (-1: nothing in reach) */
export function pickTarget(ctx: SiegeCtx, run: Run, slot: number, range: number, now: number): number {
  const t = run.turrets[slot];
  if (!t) return -1;
  const x = Position.x[t.eid], y = Position.y[t.eid];
  const inReach = (e: number) => ctx.host.hostileAlive(e) && Math.hypot(Position.x[e] - x, Position.y[e] - y) <= range;
  const f = run.focus;
  if (f.target >= 0 && now < f.until && inReach(f.target)) return f.target;
  const orders = TURRET_ORDERS[t.orders] ?? TURRET_ORDERS[DEFAULT_ORDERS];
  let best = -1, br = Infinity;
  const consider = (e: number, cost: number, boss: boolean) => {
    if (!ctx.host.hostileAlive(e)) return;
    const ex = Position.x[e], ey = Position.y[e], d = Math.hypot(ex - x, ey - y);
    if (d > range) return;
    const r = orders.rank({ eid: e, d, x: ex, y: ey, cost, boss }, run, ctx);
    if (r < br) { br = r; best = e; }
  };
  for (const [e, i] of run.info) consider(e, i.cost, !!i.boss);
  if (run.objective && run.objective.eid >= 0) consider(run.objective.eid, 1, false);
  return best;
}
