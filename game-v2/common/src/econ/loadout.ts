/**
 * Ammunition loadouts and the hold's quick storage controls.
 *
 * Each ship in the hangar carries a loadout (ShipRecord.ammo): how many of
 * each crate its guns take to load, and which crate each gun opens first.
 * Docking, launching and switching ships top the hold up from storage to it
 * (server/src/game/Ammo.ts). A gun kind with nothing chosen carries its
 * standard crate, DEFAULT_CRATES of them (guns that fire free carry none).
 *
 * The quick storage controls sort the hold by what each stack is for
 * (holdClass): ore and refined materials, loot, ammunition, utility
 * (consumables and the quick bar), job items, and the loadout's own crates.
 * Only "everything" ever sweeps the last four.
 */

import type { Blueprint } from '../ships/types.js';
import type { Catalog } from '../ships/catalog.js';
import type { ShipTuning } from '../ships/tuning.js';
import { cratesFor } from '../ships/launch.js';
import type { ItemDef } from './items.js';
import type { Bag } from './stacks.js';

/** Crates of the standard kind a gun carries until its pilot chooses otherwise */
export const DEFAULT_CRATES = 2;
/** The most of any one crate a loadout asks for */
export const MAX_LOADOUT_CRATES = 20;

/** A ship's loadout as saved: crates to carry (by item; 0 = none) and the crate each gun kind opens first */
export interface ShipLoadout { load: Record<string, number>; first?: Record<string, string> }

/** The gun kinds on a design that fire crates, each once, in the order they're first fitted */
export function loadoutKinds(catalog: Catalog, tuning: ShipTuning, bp: Blueprint): string[] {
  const out: string[] = [];
  for (const q of bp.parts) {
    const kind = catalog.functions.get(q.fn)?.weapon;
    if (kind && !out.includes(kind) && cratesFor(tuning, kind).length) out.push(kind);
  }
  return out;
}

/**
 * What a design carries: each gun kind's crates as saved, or (a kind with
 * nothing saved for any of its crates) its standard crate, DEFAULT_CRATES of
 * them if the gun needs ammunition. Crates for guns it doesn't have are dropped.
 */
export function shipLoadout(catalog: Catalog, tuning: ShipTuning, bp: Blueprint, saved?: ShipLoadout): Bag {
  const out: Bag = {};
  for (const kind of loadoutKinds(catalog, tuning, bp)) {
    const crates = cratesFor(tuning, kind);
    if (saved && crates.some((c) => saved.load[c] !== undefined)) {
      for (const c of crates) if ((saved.load[c] ?? 0) > 0) out[c] = saved.load[c];
    } else if (tuning.weapons?.[kind]?.ammo) out[crates[0]] = DEFAULT_CRATES;
  }
  return out;
}

/** What a stack in the hold is for, as the storage controls see it */
export type HoldClass = 'ore' | 'loot' | 'ammo' | 'utility' | 'quest' | 'loadout';

export function holdClass(id: string, def: ItemDef | undefined, ctx: { loadout?: Bag; quickbar?: (string | null)[] }): HoldClass {
  if ((ctx.loadout?.[id] ?? 0) > 0) return 'loadout';
  const cat = def?.category;
  if (cat === 'ammo' || def?.ammoFor) return 'ammo';
  if (cat === 'consumable' || ctx.quickbar?.includes(id)) return 'utility';
  if (cat === 'quest') return 'quest';
  if (cat === 'mineral' || cat === 'gem' || cat === 'volatile' || cat === 'refined') return 'ore';
  return 'loot';
}

/** The quick storage controls: ore and materials; loot and salvage; everything but ammunition, utility and job items (the safe one); everything */
export type StoreSweep = 'ores' | 'loot' | 'safe' | 'all';
export const STORE_SWEEPS: readonly StoreSweep[] = ['ores', 'loot', 'safe', 'all'];

export function sweeps(mode: StoreSweep, c: HoldClass): boolean {
  switch (mode) {
    case 'ores': return c === 'ore';
    case 'loot': return c === 'loot';
    case 'safe': return c === 'ore' || c === 'loot';
    case 'all': return true;
  }
}

/** The order a gun opens its crates in: the loadout's first, then the rest (each in its standard order); server and pilot's client agree */
export function crateOrder(crates: string[], load: Bag | undefined): string[] {
  if (!load) return crates;
  return [...crates.filter((c) => (load[c] ?? 0) > 0), ...crates.filter((c) => !((load[c] ?? 0) > 0))];
}
