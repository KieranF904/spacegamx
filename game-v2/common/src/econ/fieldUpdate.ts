/**
 * (v6) The field update (docs/design/field-fabrication.md, "Profile changes and the migration"): repair kits, insurance
 * bonds and loaners are gone, replaced by the repair bank.
 *
 *  - Every kit and bond in storage and the hold (and any being crafted, or on order) is removed, and what its craft recipe
 *    took goes into the bank's deposits.
 *  - The bank's free part starts full.
 *  - Loaner records are dropped. If the ship flown was a loaner, the pilot's lost ship is flown instead (lost cleared, its
 *    ghosts kept: at login the free part pays for it, core outward), else a fresh starter.
 *  - The quick bar's kit slots are cleared.
 *  - A one-time notice.
 *
 * Idempotent: a profile that has been through it (or never had kits) changes nothing the second time. Junk never throws.
 */

import type { Blueprint } from '../ships/types.js';
import type { Economy } from './economy.js';
import type { PlayerProfile, ShipRecord, StarterKit } from './profile.js';
import { setActiveShip } from './profile.js';
import { bankCap, newBank } from './field/bank.js';
import { removeFrom, type Bag } from './stacks.js';
import { unlocks } from './unlocks.js';

/**
 * The retired kits, bonds and what each was crafted from (their recipes are gone from data/recipes.json; this table is
 * all that is left of them). Source: the recipes as they were on 2026-11-07
 */
export const RETIRED_KITS: Readonly<Record<string, Readonly<Bag>>> = Object.freeze({
  repair_kit: Object.freeze({ alloy_plate: 2, copper_wire: 2 }),
  field_repair_kit: Object.freeze({ steel_plate: 3, copper_wire: 4, servo_motor: 1 }),
  nanite_repair_kit: Object.freeze({ titanium_plate: 2, crystal_lens: 1, power_coupling: 1, servo_motor: 1 }),
  insurance_bond: Object.freeze({ steel_plate: 6, scrap_electronics: 4 }),
});

export const isRetiredKit = (id: unknown): boolean => typeof id === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_KITS, id);

export interface FieldUpdateReport {
  /** Kits and bonds turned into deposits */
  kits: number;
  /** What went into the deposits */
  deposited: Bag;
  /** Loaner records dropped; and what the flown loaner gave way to */
  loanersDropped: number;
  flies: 'unchanged' | 'lost' | 'starter';
  /** The bank was made now (the free part full) */
  bankMade: boolean;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const add = (bag: Bag, id: string, n: number) => { if (n > 0) bag[id] = (bag[id] ?? 0) + n; };

/** Put `n` of a retired kit's inputs in the deposits (and in `moved`, the report's) */
function deposit(deposits: Bag, moved: Bag, id: string, n: number): void {
  for (const [i, k] of Object.entries(RETIRED_KITS[id])) { add(deposits, i, k * n); add(moved, i, k * n); }
}

/**
 * Run the field update on a profile (migrateProfile's `was < 6` step). `kit` is the starter (the bank's cap and a fresh
 * ship); `now` is the wall clock the bank starts at. Returns what it did
 */
export function fieldUpdate(p: PlayerProfile, econ: Economy, kit: StarterKit, now = Date.now()): FieldUpdateReport {
  const report: FieldUpdateReport = { kits: 0, deposited: {}, loanersDropped: 0, flies: 'unchanged', bankMade: false };
  const bank = (p.bank ??= (report.bankMade = true, newBank(bankCap(econ, kit.blueprint), Number.isFinite(now) ? now : 0)));

  // Kits and bonds: storage, hold
  for (const list of [p.storage, p.cargo]) {
    if (!Array.isArray(list)) continue;
    for (const st of [...list]) {
      if (!st || !isRetiredKit(st.id)) continue;
      const n = Math.max(0, Math.floor(Number(st.n) || 0));
      removeFrom(list, st.id, st.n);
      if (n > 0) { deposit(bank.deposits, report.deposited, st.id, n); report.kits += n; }
    }
    // (removeFrom leaves a junk stack that isn't a number alone: drop any left)
    for (let i = list.length - 1; i >= 0; i--) if (list[i] && isRetiredKit(list[i].id)) list.splice(i, 1);
  }
  // Kits being crafted: the job goes, its inputs (the runs not yet delivered) to the deposits
  if (Array.isArray(p.jobs)) {
    p.jobs = p.jobs.filter((j) => {
      if (!j || !isRetiredKit(j.recipe)) return true;
      const runs = Math.max(0, Math.floor(Number(j.count) || 0) - Math.floor(Number(j.done) || 0));
      if (runs > 0) { deposit(bank.deposits, report.deposited, j.recipe, runs); report.kits += runs; }
      return false;
    });
  }
  if (Array.isArray(p.fabOrders)) p.fabOrders = p.fabOrders.filter((o) => !(o && isRetiredKit(o.item)));
  if (Array.isArray(p.quickbar)) p.quickbar = p.quickbar.map((id) => (isRetiredKit(id) ? null : id));

  fixLoaners(p, kit, report);

  if (report.kits > 0 || report.loanersDropped > 0 || report.bankMade) {
    (p.notices ??= []).push({
      text: report.kits > 0
        ? `Repair kits and insurance are gone: ${report.kits} item${report.kits === 1 ? '' : 's'} moved into your repair bank`
        : 'Repair kits and insurance are gone: your ship now comes back from your repair bank when it is destroyed',
    });
  }
  return report;
}

/** Loaner records go; a loaner flown gives way to the lost ship (lost cleared, ghosts kept), else a fresh starter */
function fixLoaners(p: PlayerProfile, kit: StarterKit, report: FieldUpdateReport): void {
  if (!Array.isArray(p.hangar)) return;
  const flown = p.hangar[p.activeSlot] ?? p.ship;
  const flyingLoaner = !!flown?.loaner;
  const anyLoaner = p.hangar.some((r) => r?.loaner) || p.roster?.some((r) => r?.loaner) || flyingLoaner;
  if (!anyLoaner) return;

  // The lost ship to fly instead (before any slot moves): the one marked lost, else one still being built, lowest rank first
  const rank = (r: ShipRecord) => (Number.isFinite(r.rank) ? (r.rank as number) : 1e9);
  const candidates = p.hangar.filter((r): r is ShipRecord => !!r && !r.loaner && !!r.blueprint?.parts);
  const lost = flyingLoaner
    ? [...candidates.filter((r) => r.lost), ...candidates.filter((r) => !r.lost && (r.ghosts ?? []).length > 0 && r.auto)].sort((a, b) => rank(a) - rank(b))[0]
    : undefined;

  // The records go (a slot past the pilot's bays goes altogether, as Hangar.dropSlot)
  const bays = unlocks(p).hangarSlots;
  for (let i = p.hangar.length - 1; i >= 0; i--) {
    if (!p.hangar[i]?.loaner) continue;
    report.loanersDropped++;
    if (i >= bays && p.hangar.length > bays) p.hangar.splice(i, 1);
    else p.hangar[i] = null;
  }
  if (Array.isArray(p.roster)) p.roster = p.roster.filter((r) => !r?.loaner);

  if (!flyingLoaner) {
    // (The flown ship was not a loaner: keep it, wherever its slot is now)
    const at = p.hangar.indexOf(p.ship);
    p.activeSlot = at >= 0 ? at : Math.max(0, Math.min(p.hangar.length - 1, p.activeSlot));
    return;
  }

  if (lost) {
    const core = lost.blueprint.parts.find((q) => q.fn === 'core');
    delete lost.lost;
    delete lost.auto;
    delete lost.paused;
    delete lost.rank;
    // (The core always comes back, free)
    if (core) lost.ghosts = (lost.ghosts ?? []).filter((u) => u !== core.uid);
    lost.hp = {};
    // Every ghost it has is owed (the bank pays for them as it can)
    lost.owed = [...(lost.ghosts ?? [])];
    setActiveShip(p, lost, p.hangar.indexOf(lost));
    report.flies = 'lost';
  } else {
    const fresh: ShipRecord = { blueprint: clone(kit.blueprint as Blueprint), hp: {}, ghosts: [], plan: kit.planFile };
    let slot = p.hangar.indexOf(null);
    if (slot < 0) { p.hangar.push(null); slot = p.hangar.length - 1; }
    setActiveShip(p, fresh, slot);
    report.flies = 'starter';
  }
}
