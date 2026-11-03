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

/** One candidate, reused (pickTarget runs for every turret every tick: no allocation per hostile) */
const cand: Candidate = { eid: -1, d: 0, x: 0, y: 0, cost: 0, boss: false };

/** How turret at (x, y) ranks hostile `e` by `orders` (Infinity: dead or out of reach) */
function rankOf(ctx: SiegeCtx, run: Run, orders: TurretOrders, x: number, y: number, range: number, e: number, cost: number, boss: boolean): number {
  if (!ctx.host.hostileAlive(e)) return Infinity;
  const ex = Position.x[e], ey = Position.y[e], d = Math.hypot(ex - x, ey - y);
  if (d > range) return Infinity;
  cand.eid = e; cand.d = d; cand.x = ex; cand.y = ey; cand.cost = cost; cand.boss = boss;
  return orders.rank(cand, run, ctx);
}

/** What the turret on pad `slot` fires on now (-1: nothing in reach) */
export function pickTarget(ctx: SiegeCtx, run: Run, slot: number, range: number, now: number): number {
  const t = run.turrets[slot];
  if (!t) return -1;
  const x = Position.x[t.eid], y = Position.y[t.eid];
  const f = run.focus;
  if (f.target >= 0 && now < f.until && ctx.host.hostileAlive(f.target) && Math.hypot(Position.x[f.target] - x, Position.y[f.target] - y) <= range) return f.target;
  const orders = TURRET_ORDERS[t.orders] ?? TURRET_ORDERS[DEFAULT_ORDERS];
  let best = -1, br = Infinity;
  for (const [e, i] of run.info) {
    const r = rankOf(ctx, run, orders, x, y, range, e, i.cost, !!i.boss);
    if (r < br) { br = r; best = e; }
  }
  const o = run.objective;
  if (o && o.eid >= 0) {
    const r = rankOf(ctx, run, orders, x, y, range, o.eid, 1, false);
    if (r < br) { br = r; best = o.eid; }
  }
  return best;
}
