/**
 * Material packs (docs/design/field-fabrication.md, "Packs"): made only at stations, each from a mix of materials (its
 * `pack` field in data/items.json, the same as its craft recipe's inputs). They stack like any item.
 *
 *   In the field (fieldPay): a pack in the hold pays ONE unit of any one of its constituents (deliberately dear: a sink
 *   for surplus), and work paid with packs goes FIELD.packSpeed faster (rules.ts jobTicks, by packShare).
 *   In the repair bank (bankPay): a deposited pack used on a part gives up to ALL of its constituents to that part; any it
 *   doesn't need is wasted.
 *
 * Pure and deterministic (everything in item id order), so the client shows what the server will take.
 */

import type { ItemCatalog } from '../items.js';
import type { Bag } from '../stacks.js';

export interface PackDef { id: string; covers: Bag }

/** Every pack in the catalogue, by id */
export function packDefs(items: ItemCatalog): PackDef[] {
  const out: PackDef[] = [];
  for (const d of items.all()) if (d.pack && Object.keys(d.pack).length) out.push({ id: d.id, covers: { ...d.pack } });
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How a fabricator may use packs from the hold: never; only for what loose materials can't pay; or first, for speed */
export type PackMode = 'off' | 'fill' | 'prefer';
export const PACK_MODES: readonly PackMode[] = ['off', 'fill', 'prefer'];

export interface FieldPay {
  /** Loose items it takes from the hold */
  take: Bag;
  /** Packs it takes from the hold (one unit of a constituent each) */
  packs: Bag;
  /** Units of the bill the packs paid, and the bill's units in all */
  packUnits: number;
  units: number;
  /** What neither could pay (empty: the job can start) */
  short: Bag;
}

const sortedIds = (b: Bag) => Object.keys(b).filter((id) => b[id] > 0).sort();

/**
 * How a field job's bill is paid from the hold (`have`: what the hold holds of an item). All or nothing is the caller's:
 * take `take` and `packs` only when `short` is empty
 */
export function fieldPay(need: Bag, have: (id: string) => number, packs: readonly PackDef[], mode: PackMode): FieldPay {
  const take: Bag = {}, used: Bag = {}, short: Bag = {};
  let packUnits = 0, units = 0;
  const packLeft = (id: string) => have(id) - (used[id] ?? 0);
  const byPack = (id: string, n: number): number => {
    let got = 0;
    for (const p of packs) {
      if (!(p.covers[id] > 0)) continue;
      const k = Math.min(n - got, packLeft(p.id));
      if (k > 0) { used[p.id] = (used[p.id] ?? 0) + k; got += k; }
      if (got >= n) break;
    }
    return got;
  };
  const loose = (id: string, n: number): number => {
    const k = Math.max(0, Math.min(n, have(id) - (take[id] ?? 0)));
    if (k > 0) take[id] = (take[id] ?? 0) + k;
    return k;
  };
  for (const id of sortedIds(need)) {
    const n = Math.ceil(need[id]);
    units += n;
    let got = 0;
    if (mode === 'prefer') { const k = byPack(id, n); packUnits += k; got += k; got += loose(id, n - got); }
    else {
      got += loose(id, n);
      if (mode === 'fill' && got < n) { const k = byPack(id, n - got); packUnits += k; got += k; }
    }
    if (got < n) short[id] = n - got;
  }
  return { take, packs: used, packUnits, units, short };
}

/** The share of a job's units its packs paid (0..1): what jobTicks speeds it by */
export function packShare(pay: Pick<FieldPay, 'packUnits' | 'units'>): number {
  return pay.units > 0 ? pay.packUnits / pay.units : 0;
}

export interface BankPay {
  /** Deposit items used up (loose materials and packs) */
  used: Bag;
  /** The part of the bill they paid */
  paid: Bag;
  /** Pack constituents given that the part didn't need (lost) */
  wasted: Bag;
  /** What the deposits could not pay */
  short: Bag;
}

/**
 * Pay a part's bill from the bank's deposits: loose deposited materials first, then packs, each time the pack that pays
 * the most units still owed (ties: id order); a pack gives up to all of its constituents and the rest is wasted. A pack
 * that would pay nothing is never opened
 */
export function bankPay(need: Bag, deposits: Bag, packs: readonly PackDef[]): BankPay {
  const owe: Bag = {};
  for (const id of sortedIds(need)) owe[id] = Math.ceil(need[id]);
  const used: Bag = {}, paid: Bag = {}, wasted: Bag = {};
  const left = (id: string) => (deposits[id] ?? 0) - (used[id] ?? 0);
  for (const id of Object.keys(owe)) {
    const k = Math.max(0, Math.min(owe[id], left(id)));
    if (k > 0) { used[id] = (used[id] ?? 0) + k; paid[id] = (paid[id] ?? 0) + k; owe[id] -= k; }
  }
  for (;;) {
    let best: PackDef | null = null, bestUnits = 0;
    for (const p of packs) {
      if (left(p.id) <= 0) continue;
      let u = 0;
      for (const [id, n] of Object.entries(p.covers)) u += Math.min(n, owe[id] ?? 0);
      if (u > bestUnits) { best = p; bestUnits = u; }
    }
    if (!best) break;
    used[best.id] = (used[best.id] ?? 0) + 1;
    for (const id of Object.keys(best.covers).sort()) {
      const n = best.covers[id], k = Math.min(n, owe[id] ?? 0);
      if (k > 0) { paid[id] = (paid[id] ?? 0) + k; owe[id] -= k; }
      if (n - k > 0) wasted[id] = (wasted[id] ?? 0) + n - k;
    }
  }
  const short: Bag = {};
  for (const [id, n] of Object.entries(owe)) if (n > 0) short[id] = n;
  return { used, paid, wasted, short };
}
