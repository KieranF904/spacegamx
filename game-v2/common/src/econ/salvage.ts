/**
 * Structure, modules and salvage.
 *
 * A ship is structure and modules. Structure (hull, armour, conduits, cargo
 * holds) isn't made in the fabricator: you place it in the hangar and it's
 * paid for there and then in refined materials (plate, wire), so all it takes
 * is refining. Modules (the core, generators, thrusters, weapons, shields,
 * miners, scanners, jump coils) are fabricated, and sit in storage as items
 * until a ship takes them.
 *
 * Salvage is what comes back from a ship (lost in battle, or scrapped in the
 * hangar) or a module scrapped from storage: SALVAGE of its minerals, as raw
 * ore to be refined again, and every component it was made with (power
 * couplings, targeting chips, boss parts) in full, so lost high-grade gear can
 * always be fabricated again.
 */

import type { Blueprint, PlacedPart } from '../ships/types.js';
import type { Economy } from './economy.js';
import { parsePartItemId, partItemId } from './items.js';
import type { Bag } from './stacks.js';

/** Of a lost or scrapped ship's minerals, this much comes back as ore */
export const SALVAGE = 0.7;

export const STRUCTURAL_FNS = ['hull', 'armor', 'conduit', 'cargo'];

export function isStructural(fn: string): boolean {
  return STRUCTURAL_FNS.includes(fn);
}

/** Is this item id a structural part (never kept as an item: it's paid in materials when placed) */
export function isStructuralItem(id: string): boolean {
  const p = parsePartItemId(id);
  return !!p && isStructural(p.fn);
}

/** What placing a part takes from storage: structure its materials, a module its fabricated item */
export function placeCost(econ: Economy, p: { material: string; fn: string; piece: string }): Bag {
  return isStructural(p.fn) ? econ.recipes.partInputs(p) : { [partItemId(p)]: 1 };
}

/** What a design's unbuilt parts (ghosts) take, all told: modules as items, structure as materials */
export function ghostBill(econ: Economy, bp: Blueprint, ghosts: number[]): Bag {
  const g = new Set(ghosts);
  const out: Bag = {};
  for (const p of bp.parts) {
    if (!g.has(p.uid)) continue;
    for (const [id, n] of Object.entries(placeCost(econ, p))) out[id] = (out[id] ?? 0) + n;
  }
  return out;
}

/**
 * What a set of items breaks down to: minerals (through refining) at
 * `fraction` as raw ore, components in full. Parts are broken down into what
 * they're made of first.
 */
export function salvageOf(econ: Economy, items: Bag, fraction = SALVAGE): Bag {
  const made: Bag = {};
  const add = (id: string, n: number) => { made[id] = (made[id] ?? 0) + n; };
  for (const [id, n] of Object.entries(items)) {
    const part = parsePartItemId(id);
    if (part) for (const [i, k] of Object.entries(econ.recipes.partInputs(part))) add(i, k * n);
    else add(id, n);
  }
  const raw = econ.recipes.raw(made);
  const out: Bag = {};
  for (const [id, n] of Object.entries(raw)) {
    const mineral = econ.items.get(id)?.category === 'mineral';
    const k = mineral ? Math.round(n * fraction) : Math.round(n);
    if (k > 0) out[id] = k;
  }
  return out;
}

/** Salvage of placed parts (a ship, or some of it) */
export function salvageParts(econ: Economy, parts: PlacedPart[], fraction = SALVAGE): Bag {
  const bag: Bag = {};
  for (const p of parts) { const id = partItemId(p); bag[id] = (bag[id] ?? 0) + 1; }
  return salvageOf(econ, bag, fraction);
}
