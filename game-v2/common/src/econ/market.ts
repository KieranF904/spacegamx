/**
 * Market prices and recipe access rules, shared so the client shows exactly
 * what the server will charge and allow.
 *
 * Markets move. What a station pays for an item is its base value, times the
 * station's standing demand, times this market cycle's shift (every few hours
 * each station wants a few things badly and is glutted with others), times
 * saturation: every unit sold there lately pushes its price down, and the
 * market recovers over time. So hauling goods to where they're wanted pays,
 * and dumping a thousand of one ore at one station doesn't.
 */

import type { ItemCatalog } from './items.js';
import { parsePartItemId } from './items.js';
import type { CraftRecipe } from './recipes.js';
import { unlocks } from './unlocks.js';
import { registeredFunction } from '../ships/blueprint.js';
import type { FunctionDef } from '../ships/types.js';
import type { Outpost } from './outpost.js';

/** What a station pays for an item (its demand raises or lowers the base) */
export function sellPrice(items: ItemCatalog, id: string, demand: Record<string, number> = {}): number {
  const v = items.get(id)?.value ?? 0;
  if (v <= 0) return 0;
  return Math.max(1, Math.floor(v * 0.6 * (demand[id] ?? 1)));
}

/** What a station charges for an item it sells */
export function buyPrice(items: ItemCatalog, id: string): number {
  const v = items.get(id)?.value ?? 0;
  return Math.max(1, Math.ceil(v * 1.35));
}

/** Materials and structure every pilot can build with from the start */
export const STARTER_MATERIALS = ['alloy'];
export const STARTER_FUNCTIONS = ['hull', 'armor', 'cargo'];

/**
 * The pilot level each structure material unlocks at (docs/parts-redesign.md §3),
 * and nothing opens one earlier. The main line by grade; a special (hazard)
 * material at the level its plate can be refined (recipes.json refining), so
 * it opens when you can make it. Not here: not a player's to build with (the
 * bosses' own, dev).
 */
export const MATERIAL_LEVEL: Record<string, number> = {
  alloy: 0, composite: 3, steel: 5, titanium: 12, cobalt: 22, neutronium: 32,
  insulated_polymer: 10, leestone: 12, dense_ferrite: 30, conductive_steel: 35, leaded_iridium: 45, ceramic_laminate: 45, sealed_composite: 45,
};

/** Materials a job must also teach (its licence, material:<id>), on top of their level: leestone, the Ark's (ark_06) */
export const JOB_MATERIALS: readonly string[] = ['leestone'];

/** May a pilot build in this material: at its level (and, for a job's material, with that job's licence) */
export function materialLicensed(material: string, learned: string[], level = 0): boolean {
  if (STARTER_MATERIALS.includes(material)) return true;
  const at = MATERIAL_LEVEL[material];
  if (at === undefined || level < at) return false;
  return !JOB_MATERIALS.includes(material) || learned.includes(`material:${material}`);
}

/**
 * May a pilot fabricate this model: at its unlock level, and never earlier
 * (Kieran, 2026-10-30: no schematic, job or licence opens anything early).
 * The boss legendaries' further gate is the artefact their recipe needs.
 * (`learned` is unused: kept so callers needn't change.)
 */
export function modelLicensed(fn: FunctionDef, _learned: readonly string[] = [], level = 0): boolean {
  return !!fn.unlock && level >= fn.unlock.level;
}

/** May a pilot put a new one of these on a ship: a model at its level, structure by its material (and the core with its licence: First Light teaches it) */
export function partLicensed(q: { material: string; fn: string }, learned: string[], level = 0): boolean {
  const fn = registeredFunction(q.fn);
  if (!fn || fn.legacy || fn.exclusive) return false;
  if (fn.model) return q.material === fn.material && modelLicensed(fn, learned, level);
  return materialLicensed(q.material, learned, level) && (STARTER_FUNCTIONS.includes(q.fn) || learned.includes(`fn:${q.fn}`));
}

/**
 * Can a pilot of this level with these learned recipes fabricate this? A
 * listed recipe needs its level (`level`); then a starter or a levelled one
 * is open, and a job's kit (`quest`) also has to have been taught. Parts are
 * partLicensed (models by level, the core by its licence and its material's).
 */
export function canCraft(recipe: CraftRecipe, learned: string[], level = 0): boolean {
  const part = parsePartItemId(recipe.id);
  if (part) return partLicensed(part, learned, level);
  if (recipe.level !== undefined && level < recipe.level) return false;
  if (recipe.quest) return learned.includes(recipe.id);
  return !!recipe.starter || recipe.level !== undefined || learned.includes(recipe.id);
}

/** Human name for a licence or recipe id */
export function licenceName(id: string, items: ItemCatalog): string {
  if (id.startsWith('material:')) return `${cap(id.slice(9))} part fabrication`;
  if (id.startsWith('fn:')) return `${cap(id.slice(3))} fabrication`;
  return items.name(id);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Fabricator queue slots (econ/unlocks.ts) */
export function queueSlots(p: { level: number; skills?: Record<string, number>; outpost?: Outpost }): number {
  return unlocks(p).fabSlots;
}

// ---------------------------------------------------------------------------
// Moving markets
// ---------------------------------------------------------------------------

/** Each station's wants change this often */
export const MARKET_CYCLE_MS = 4 * 60 * 60 * 1000;
/** Saturation halves in this long */
export const MARKET_RECOVERY_MS = 30 * 60 * 1000;
/** Categories a market cycle can want or be glutted with */
export const TRADE_CATEGORIES = ['mineral', 'gem', 'volatile', 'refined', 'component'];

/** How many units of an item a station absorbs before its price sags (cheap ores: lots; rare goods: few) */
export function marketDepth(items: ItemCatalog, id: string): number {
  const v = items.get(id)?.value ?? 1;
  return Math.max(12, Math.round(2400 / Math.max(1, v)));
}

/** Price multiplier after `sat` units were sold here lately: a depth's worth knocks a third off */
export function saturationFactor(sat: number, depth: number): number {
  return 1 / (1 + (0.5 * Math.max(0, sat)) / depth);
}

/** What the next unit sells for, with `demand` (standing × cycle) and `sat` units sold lately */
export function unitSellPrice(items: ItemCatalog, id: string, demand: number, sat: number): number {
  const v = items.get(id)?.value ?? 0;
  if (v <= 0) return 0;
  return Math.max(1, Math.floor(v * 0.6 * demand * saturationFactor(sat, marketDepth(items, id))));
}

/** Total for selling `n` units in one go: each one a little cheaper than the last */
export function saleTotal(items: ItemCatalog, id: string, n: number, demand: number, sat: number): number {
  if (n <= 0) return 0;
  // Big stacks go in up to 200 slices
  const slices = Math.min(n, 200);
  let total = 0, done = 0;
  for (let i = 0; i < slices; i++) {
    const k = Math.round(((i + 1) * n) / slices) - done;
    total += unitSellPrice(items, id, demand, sat + done + k / 2) * k;
    done += k;
  }
  return total;
}

function mhash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * This cycle's shifts at a station: a few goods it wants (pays 35-80% more) and
 * a couple it's glutted with (pays 25-40% less). The same for everyone.
 */
export function marketShift(stationId: string, nowMs: number, items: ItemCatalog): { wanted: Record<string, number>; glut: Record<string, number> } {
  const cycle = Math.floor(nowMs / MARKET_CYCLE_MS);
  const pool = [...items.all()].filter((d) => TRADE_CATEGORIES.includes(d.category) && d.value > 0 && d.rarity !== 'legendary').map((d) => d.id).sort();
  const pick = (salt: string, n: number, taken: Set<string>) => {
    const out: string[] = [];
    for (let i = 0; out.length < n && i < 40; i++) {
      const id = pool[mhash(`${stationId}:${cycle}:${salt}:${i}`) % pool.length];
      if (!taken.has(id)) { taken.add(id); out.push(id); }
    }
    return out;
  };
  const taken = new Set<string>();
  const wanted: Record<string, number> = {};
  const glut: Record<string, number> = {};
  for (const id of pick('want', 3, taken)) wanted[id] = 1.35 + (mhash(`${stationId}:${cycle}:w:${id}`) % 46) / 100;
  for (const id of pick('glut', 2, taken)) glut[id] = 0.6 + (mhash(`${stationId}:${cycle}:g:${id}`) % 16) / 100;
  return { wanted, glut };
}

// ---------------------------------------------------------------------------
// Faction quartermasters
// ---------------------------------------------------------------------------

/** A faction's quartermaster: where they trade, and what they'll sell you at which rank */
export interface VendorDef {
  stations: string[];
  stock: { item: string; rank: number }[];
}

/** Discount by reputation rank (0 Unknown … 5 Exalted) */
export const RANK_DISCOUNT = [0, 0.03, 0.06, 0.1, 0.15, 0.2];

export function vendorPrice(items: ItemCatalog, id: string, rank: number): number {
  return Math.max(1, Math.ceil(buyPrice(items, id) * (1 - (RANK_DISCOUNT[Math.max(0, Math.min(5, rank))] ?? 0))));
}
