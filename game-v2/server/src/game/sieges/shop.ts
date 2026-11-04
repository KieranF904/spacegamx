/**
 * The day's shop: patching the bastion and turrets, building a turret on the
 * pad you pick, upgrading one (three marks), scrapping one for some of it
 * back, and any time, a turret's orders. At night: building on a pad you're
 * near (dearer), and mending what you stay beside.
 */

import type { PilotConn } from '../Pilots.js';
import { DEFAULT_SIEGE_RULES, SECOND, type SiegeRules } from './rules.js';
import { DEFAULT_ORDERS, TURRET_ORDERS, pickTarget } from './turrets.js';
import type { PilotAt, Run, SiegeCtx } from './types.js';
import { dhypot } from '@space-game/common';

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

/** A pad number that's real (or -1) */
function padOf(run: Run, pad: unknown): number {
  const n = Number(pad);
  return pad !== undefined && pad !== null && Number.isInteger(n) && n >= 0 && n < run.turrets.length ? n : -1;
}

/** By day: patch, or build a turret on `pad` (absent: the first free one) */
export function buy(ctx: SiegeCtx, run: Run, conn: PilotConn, id: string, pad?: unknown): void {
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
  let slot = padOf(run, pad);
  if (slot >= 0 && run.turrets[slot]) return host.toast(conn, t('sieges.padTaken', { pad: slot + 1 }), 'warn');
  if (slot < 0) slot = run.turrets.findIndex((tu) => tu === null);
  if (slot < 0) return host.toast(conn, t('sieges.padsFull'), 'warn');
  if (!place(ctx, run, slot, kind, 0, cost)) return;
  run.supplies -= cost;
  ctx.announce(run, conn, ctx.turretName(def.label, 0));
}

/** At night: a turret on a pad the pilot is near, at the night price */
export function buildAtNight(ctx: SiegeCtx, run: Run, conn: PilotConn, id: string, pad: unknown, me: PilotAt | undefined): void {
  const { host, rules, t } = ctx;
  const kind = id.replace(/^turret_/, '');
  const def = rules.turrets[kind];
  if (!def) return host.toast(conn, t('sieges.onlyByDay'), 'warn');
  const slot = padOf(run, pad);
  if (slot < 0) return;
  if (run.turrets[slot]) return host.toast(conn, t('sieges.padTaken', { pad: slot + 1 }), 'warn');
  const b = run.sys.surface!.bastion!, p = b.slots[slot];
  if (!me || dhypot(me.x - (b.x + p.x), me.y - (b.y + p.y)) > rules.night.buildReach) return host.toast(conn, t('sieges.tooFarToBuild', { pad: slot + 1 }), 'warn');
  const cost = nightCost(rules, def.marks[0].cost);
  if (run.supplies < cost) return host.toast(conn, t('sieges.shortOfSupplies', { cost }), 'warn');
  if (!place(ctx, run, slot, kind, 0, cost)) return;
  run.supplies -= cost;
  ctx.announce(run, conn, t('sieges.nightBuild', { turret: ctx.turretName(def.label, 0), pad: slot + 1 }));
}

/** What a turret costs to build at night */
export function nightCost(rules: SiegeRules, cost: number): number {
  return Math.round(cost * rules.night.buildCost);
}

/** What a pad's turret fires on first (TURRET_ORDERS) */
export function setOrders(ctx: SiegeCtx, run: Run, conn: PilotConn, pad: unknown, orders: string): void {
  const slot = padOf(run, pad), tu = slot >= 0 ? run.turrets[slot] : null;
  if (!tu || !TURRET_ORDERS[orders] || tu.orders === orders) return;
  tu.orders = orders;
  ctx.host.toast(conn, ctx.t('sieges.orders', { turret: ctx.turretName(ctx.rules.turrets[tu.kind].label, tu.mark), pad: slot + 1, orders: ctx.t(`sieges.orders.${orders}` as never) }), 'info');
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
  if (!place(ctx, run, slot, tu.kind, tu.mark + 1, tu.spent + next.cost, tu.orders)) return;
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

/** A turret of a kind and mark on a pad, armed (firing as its orders say) */
export function place(ctx: SiegeCtx, run: Run, slot: number, kind: string, mark: number, spent: number, orders = DEFAULT_ORDERS): boolean {
  const def = ctx.rules.turrets[kind];
  const b = run.sys.surface!.bastion!, pad = b.slots[slot];
  const eid = ctx.host.spawnStructure(def.marks[mark].design, run.num, b.x + pad.x, b.y + pad.y, ctx.turretName(def.label, mark), ctx.fortGrade(run.grade));
  if (eid < 0) return false;
  ctx.host.arm(eid, { range: def.range, shot: def.shot, damage: def.damage, pick: () => pickTarget(ctx, run, slot, def.range, ctx.host.tick()) });
  run.turrets[slot] = { eid, kind, mark, spent, orders };
  run.mend.delete(slot);
  run.tally.padsLost = run.tally.padsLost.filter((q) => q !== slot);
  return true;
}

/**
 * Mending at night (a step: 10 ticks): a pilot staying within reach of a damaged turret (or the bastion) long enough
 * mends it, for supplies (the bastion's first mend in a last stand is free).
 */
export function stepMending(ctx: SiegeCtx, run: Run, pilots: PilotAt[]): void {
  const { host, rules, t } = ctx;
  const b = run.sys.surface!.bastion!;
  const jobs: { key: number; eid: number; x: number; y: number; what: string; m: SiegeRules['night']['mend'] }[] = [];
  run.turrets.forEach((tu, i) => {
    if (tu) jobs.push({ key: i, eid: tu.eid, x: b.x + b.slots[i].x, y: b.y + b.slots[i].y, what: ctx.turretName(rules.turrets[tu.kind].label, tu.mark), m: rules.night.mend });
  });
  jobs.push({ key: -1, eid: run.bastion, x: b.x, y: b.y, what: t('sieges.banner.meter'), m: rules.night.bastionMend });
  for (const j of jobs) {
    const hull = host.shipAt(j.eid)?.hull ?? 1;
    const near = hull < 0.999 ? pilots.filter((p) => dhypot(p.x - j.x, p.y - j.y) <= j.m.reach) : [];
    if (!near.length) { run.mend.delete(j.key); continue; }
    const held = (run.mend.get(j.key) ?? 0) + 10;
    if (held < j.m.seconds * SECOND) { run.mend.set(j.key, held); continue; }
    run.mend.delete(j.key);
    const free = j.key === -1 && run.breach && run.freeMend;
    if (!free && run.supplies < j.m.cost) {
      for (const p of near) host.toast(p.conn, t('sieges.mendShort', { cost: j.m.cost }), 'warn');
      continue;
    }
    host.healStructure(j.eid, j.m.heal);
    if (free) run.freeMend = false;
    else run.supplies -= j.m.cost;
    ctx.announce(run, near[0].conn, free ? t('sieges.mendedFree', { what: j.what }) : t('sieges.mended', { what: j.what, heal: Math.round(j.m.heal * 100), cost: j.m.cost }));
    ctx.sendState(run, true);
  }
}
