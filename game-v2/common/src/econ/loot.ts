/**
 * @contract common.econ.loot
 * owns:       drop tables (data/loot.json): one weighted roll per table roll ("nothing" an entry like the rest), the always kind, who rolls what (faction, design, a design in one system), and each item's chance per kill
 * needs:      econ/stacks (Bag); no I/O, no randomness of its own (the caller's dice: the server's payout dice)
 * invariants: a roll picks exactly one entry or nothing, by weight; an always table drops every entry — common/src/econ/loot.test.ts
 *             dropChances is the chance of at least one of an item per kill, worked out from the same tables rollDrops rolls — common/src/econ/loot.test.ts
 * extend:     a new table kind is one case in rollTable and in tableChances
 */

import type { Bag } from './stacks.js';

/** One entry of a table: `min..max` of `item` (both default 1); `weight` its share of a roll (an always table ignores it) */
export interface LootEntry { item: string; weight?: number; min?: number; max?: number }

/**
 * A named table. A weighted roll picks one entry by weight, or nothing (`nothing` is its weight); `always`: every entry
 * drops on every roll (bosses' guaranteed drops)
 */
export interface LootTable { kind?: 'always'; nothing?: number; entries: LootEntry[] }

/** data/loot.json */
export interface LootFile { tables: Record<string, LootTable> }

/** Roll a table this many times */
export interface DropLine { table: string; rolls: number }

/** Who rolls what: the tables and their rolls, and the table an elite rolls once more */
export interface DropSpec { drops?: DropLine[]; eliteDrop?: string }

/** A random number in [0, 1) (the server's payout dice) */
export type LootDice = () => number;

const amount = (e: LootEntry, dice: LootDice) => {
  const lo = e.min ?? 1, hi = Math.max(lo, e.max ?? lo);
  return lo + Math.floor(dice() * (hi - lo + 1));
};

/** One roll of a table into `bag` */
export function rollTable(t: LootTable | undefined, dice: LootDice, bag: Bag = {}): Bag {
  if (!t) return bag;
  const add = (e: LootEntry) => { const n = amount(e, dice); if (n > 0) bag[e.item] = (bag[e.item] ?? 0) + n; };
  if (t.kind === 'always') { for (const e of t.entries) add(e); return bag; }
  const total = (t.nothing ?? 0) + t.entries.reduce((s, e) => s + (e.weight ?? 0), 0);
  if (!(total > 0)) return bag;
  let r = dice() * total - (t.nothing ?? 0);
  if (r < 0) return bag;
  for (const e of t.entries) {
    r -= e.weight ?? 0;
    if (r < 0) { add(e); return bag; }
  }
  return bag;
}

/** Every line's rolls, and `extra` more rolls of `eliteDrop` (an elite: 1) */
export function rollDrops(tables: Record<string, LootTable>, spec: DropSpec, dice: LootDice, extra = 0, bag: Bag = {}): Bag {
  for (const l of spec.drops ?? []) for (let r = 0; r < l.rolls; r++) rollTable(tables[l.table], dice, bag);
  if (spec.eliteDrop) for (let r = 0; r < extra; r++) rollTable(tables[spec.eliteDrop], dice, bag);
  return bag;
}

/** The most specific say wins, `drops` and `eliteDrop` each on its own: a design in this system, then the design, then its faction */
export function dropSpecFor(...specs: (DropSpec | undefined)[]): DropSpec {
  const out: DropSpec = {};
  for (const s of specs) {
    if (!s) continue;
    if (out.drops === undefined && s.drops) out.drops = s.drops;
    if (out.eliteDrop === undefined && s.eliteDrop) out.eliteDrop = s.eliteDrop;
  }
  return out;
}

/** Per item: the chance one roll of the table gives any, and the amounts it can give */
function tableChances(t: LootTable): Map<string, { p: number; min: number; max: number }> {
  const out = new Map<string, { p: number; min: number; max: number }>();
  const total = t.kind === 'always' ? 1 : (t.nothing ?? 0) + t.entries.reduce((s, e) => s + (e.weight ?? 0), 0);
  for (const e of t.entries) {
    const p = t.kind === 'always' ? 1 : total > 0 ? (e.weight ?? 0) / total : 0;
    const lo = e.min ?? 1, hi = Math.max(lo, e.max ?? lo);
    const was = out.get(e.item);
    // (One item twice in a table: either entry gives it)
    out.set(e.item, was ? { p: Math.min(1, was.p + p), min: Math.min(was.min, lo), max: Math.max(was.max, hi) } : { p, min: lo, max: hi });
  }
  return out;
}

/** An item's odds per kill: the chance of at least one (0..1), and the least and most one roll gives */
export interface DropChance { item: string; chance: number; min: number; max: number }

/**
 * Per kill, the chance of getting at least one of each item, from every roll in `spec` (and `extra` elite rolls).
 * What the field guide shows as a tier (never as a number) and the site's catalogue lists
 */
export function dropChances(tables: Record<string, LootTable>, spec: DropSpec, extra = 0): DropChance[] {
  const miss = new Map<string, { q: number; min: number; max: number }>();
  const roll = (id: string | undefined, times: number) => {
    const t = id ? tables[id] : undefined;
    if (!t || times <= 0) return;
    for (const [item, c] of tableChances(t)) {
      const m = miss.get(item) ?? { q: 1, min: c.min, max: c.max };
      for (let k = 0; k < times; k++) m.q *= 1 - c.p;
      m.min = Math.min(m.min, c.min); m.max = Math.max(m.max, c.max);
      miss.set(item, m);
    }
  };
  for (const l of spec.drops ?? []) roll(l.table, l.rolls);
  roll(spec.eliteDrop, extra);
  return [...miss].map(([item, m]) => ({ item, chance: 1 - m.q, min: m.min, max: m.max })).filter((d) => d.chance > 0).sort((a, b) => b.chance - a.chance);
}
