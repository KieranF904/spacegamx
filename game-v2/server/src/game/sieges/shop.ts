/**
 * The day's shop: patching the bastion and turrets, building a turret on a
 * pad, upgrading one (three marks), scrapping one for some of it back.
 */

import type { PilotConn } from '../Pilots.js';
import { DEFAULT_SIEGE_RULES, type SiegeRules } from './rules.js';
import type { Run, SiegeCtx } from './types.js';

export interface ShopItem { id: string; label: string; cost: number; note: string }

/** The day's shop: patching, and building each kind of turret */
export function siegeShop(rules: SiegeRules): ShopItem[] {
  const { id, label, cost, note } = rules.repair;
  return [
    { id, label, cost, note },
    ...Object.entries(rules.turrets).map(([k, t]) => ({ id: `turret_${k}`, label: t.label, cost: t.marks[0].cost, note: t.note })),
  ];
}
export const SIEGE_SHOP = siegeShop(DEFAULT_SIEGE_RULES);

export function buy(ctx: SiegeCtx, run: Run, conn: PilotConn, id: string): void {
  const { host, rules, t } = ctx;
  const repair = rules.repair;
  if (id === repair.id) {
    if (run.supplies < repair.cost) return host.toast(conn, t('sieges.shortOfSupplies', { cost: repair.cost }), 'warn');
    const worn = [run.bastion, ...run.turrets.map((tu) => tu?.eid ?? -1)].filter((e) => (host.shipAt(e)?.hull ?? 1) < 0.999);
    if (!worn.length) return host.toast(conn, t('sieges.nothingToPatch'), 'info');
    for (const e of worn) host.healStructure(e, repair.heal);
    run.supplies -= repair.cost;
    return ctx.announce(run, conn, repair.label);
  }
  const kind = id.replace(/^turret_/, '');
  const def = rules.turrets[kind];
  if (!def) return;
  const cost = def.marks[0].cost;
  if (run.supplies < cost) return host.toast(conn, t('sieges.shortOfSupplies', { cost }), 'warn');
  const slot = run.turrets.findIndex((tu) => tu === null);
  if (slot < 0) return host.toast(conn, t('sieges.padsFull'), 'warn');
  if (!place(ctx, run, slot, kind, 0, cost)) return;
  run.supplies -= cost;
  ctx.announce(run, conn, ctx.turretName(def.label, 0));
}

/** The next mark for the turret on a pad, at full hull */
export function upgrade(ctx: SiegeCtx, run: Run, conn: PilotConn, slot: number): void {
  const { host, rules, t } = ctx;
  const tu = run.turrets[slot];
  if (!tu) return;
  const def = rules.turrets[tu.kind], next = def.marks[tu.mark + 1];
  if (!next) return host.toast(conn, t('sieges.fullyUpgraded'), 'info');
  if (run.supplies < next.cost) return host.toast(conn, t('sieges.shortOfSupplies', { cost: next.cost }), 'warn');
  host.removeStructure(tu.eid);
  run.turrets[slot] = null;
  if (!place(ctx, run, slot, tu.kind, tu.mark + 1, tu.spent + next.cost)) return;
  run.supplies -= next.cost;
  ctx.announce(run, conn, ctx.turretName(def.label, tu.mark + 1));
}

/** Take a turret down for some of what it cost back (to build something else there) */
export function scrap(ctx: SiegeCtx, run: Run, conn: PilotConn, slot: number): void {
  const tu = run.turrets[slot];
  if (!tu) return;
  const back = Math.floor(tu.spent * ctx.rules.scrapBack);
  ctx.host.removeStructure(tu.eid);
  run.turrets[slot] = null;
  run.supplies += back;
  ctx.announce(run, conn, ctx.t('sieges.scrapped', { turret: ctx.rules.turrets[tu.kind].label.toLowerCase(), back }));
}

/** A turret of a kind and mark on a pad, armed */
export function place(ctx: SiegeCtx, run: Run, slot: number, kind: string, mark: number, spent: number): boolean {
  const def = ctx.rules.turrets[kind];
  const b = run.sys.surface!.bastion!, pad = b.slots[slot];
  const eid = ctx.host.spawnStructure(def.marks[mark].design, run.num, b.x + pad.x, b.y + pad.y, ctx.turretName(def.label, mark), ctx.fortGrade(run.grade));
  if (eid < 0) return false;
  ctx.host.arm(eid, { range: def.range, shot: def.shot, damage: def.damage });
  run.turrets[slot] = { eid, kind, mark, spent };
  return true;
}
