/**
 * Field fabrication's rules (docs/design/field-fabrication.md): what each machine tier can make and how fast, what a
 * build, repair, attachment or recycle costs and takes. The one place these numbers live: the server runs jobs by them
 * and the client predicts and shows them by the same functions, so both agree. Pure and deterministic.
 *
 * Work is measured in seconds at speed 1 ("work seconds"). A machine of speed s at full power gets through s of them a
 * second; short of power it gets through its share of that (a powered machine's progress is the energy it took in:
 * jobEu). The core's own fabricator and refiner draw nothing and run by the tick.
 */

import type { Catalog } from '../../ships/catalog.js';
import type { PlacedPart } from '../../ships/types.js';
import { gradeOf, partGrade } from '../../ships/grades.js';
import type { Economy } from '../economy.js';
import { isStructural } from '../salvage.js';
import type { Bag } from '../stacks.js';

export type MachineKind = 'fabricator' | 'refiner';

/** A machine tier's speed (work seconds a second, at full power) and the highest grade it can make (1..5) */
export interface TierRule { speed: number; gradeCap: number }

/** Tier 0 is the ship's core, which fabricates and refines slowly by itself */
export const CORE_TIER = 0;
export const MAX_TIER = 3;

/** Fabricators by tier (0: the core, only starter parts and the Field Fabricator: CORE_FAB_EXTRA) */
export const FAB_TIERS: readonly TierRule[] = Object.freeze([
  { speed: 0.25, gradeCap: 1 },
  { speed: 1, gradeCap: 2 },
  { speed: 1.6, gradeCap: 3 },
  { speed: 2.5, gradeCap: 5 },
]);
/** Refiners by tier (0: the core): speed is the share of a station's pace (a refining recipe's `time` is the station's) */
export const REFINE_TIERS: readonly TierRule[] = Object.freeze([
  { speed: 0.2, gradeCap: 1 },
  { speed: 0.4, gradeCap: 2 },
  { speed: 0.7, gradeCap: 3 },
  { speed: 1, gradeCap: 5 },
]);

/** What the core can fabricate beyond starter parts (unlock level 0 models and Mk I structure) */
export const CORE_FAB_EXTRA: readonly string[] = Object.freeze(['fabricator_field']);

export const FIELD_TPS = 60;

export const FIELD = Object.freeze({
  /** Fabricating a part: this many work seconds a cell x its grade's time factor (recipes.parts.timeByGrade), plus its station recipe time */
  fabSecondsPerCell: 6,
  /** Attaching a finished part (made here, or taken from the hold): work seconds a cell */
  attachSecondsPerCell: 3,
  /** Recycling a part: this share of its materials back (largest remainders: recycleReturn), in this share of its fabrication time */
  recycleReturn: 0.5,
  recycleTime: 0.5,
  /** Repairing a damaged part: this share of its inputs x the HP share missing, in this share of its fabrication time x the HP share missing */
  repairCost: 0.5,
  repairTime: 0.5,
  /** Work paid for with material packs goes this much faster (+60%), by the share of the job's units they paid */
  packSpeed: 0.6,
});

export function tierRule(kind: MachineKind, tier: number): TierRule {
  const t = kind === 'fabricator' ? FAB_TIERS : REFINE_TIERS;
  return t[Math.max(0, Math.min(MAX_TIER, Math.floor(tier)))];
}

const areaOf = (catalog: Catalog, piece: string): number => catalog.variants.get(piece)?.[0]?.area ?? 1;

/** A starter part: a model that opens at level 0, or structure in a Mk I material */
export function isStarterPart(catalog: Catalog, p: { fn: string; material: string }): boolean {
  const fn = catalog.functions.get(p.fn);
  if (!fn) return false;
  if (fn.model) return (fn.unlock?.level ?? 0) === 0;
  return isStructural(p.fn) && gradeOf(catalog.materials.get(p.material)) === 1;
}

/**
 * Can a fabricator of this tier (0: the core) make this part? The core is never made in the field; legacy functions
 * (enemy parts) never are; the core makes starter parts and the Field Fabricator; a tier makes anything up to its grade cap
 */
export function canFabricate(catalog: Catalog, tier: number, p: { fn: string; material: string }): boolean {
  const fn = catalog.functions.get(p.fn);
  if (!fn || p.fn === 'core' || fn.exclusive) return false;
  if (!fn.model && !isStructural(p.fn)) return false;
  if (tier <= CORE_TIER) return isStarterPart(catalog, p) || CORE_FAB_EXTRA.includes(p.fn);
  return partGrade(catalog, p) <= tierRule('fabricator', tier).gradeCap;
}

/** What fabricating one part in the field takes from the hold: its recipe's inputs (a module's, or structure's plate) */
export function fieldBuildInputs(econ: Economy, p: { fn: string; material: string; piece: string }): Bag {
  return econ.recipes.partInputs(p);
}

/** Work seconds to fabricate a part (before attaching it) */
export function fabWork(econ: Economy, p: { fn: string; material: string; piece: string }): number {
  const g = partGrade(econ.ships, p);
  const byGrade = econ.recipes.parts.timeByGrade?.[g] ?? 1;
  return FIELD.fabSecondsPerCell * areaOf(econ.ships, p.piece) * byGrade + econ.recipes.partTime(p);
}

/** Work seconds to attach a finished part to the ship */
export function attachWork(catalog: Catalog, p: { piece: string }): number {
  return FIELD.attachSecondsPerCell * areaOf(catalog, p.piece);
}

/** Work seconds to repair a damaged part (missing: the share of its HP gone, 0..1) */
export function repairWork(econ: Economy, p: { fn: string; material: string; piece: string }, missing: number): number {
  return fabWork(econ, p) * FIELD.repairTime * clamp01(missing);
}

/** Work seconds to recycle a part */
export function recycleWork(econ: Economy, p: { fn: string; material: string; piece: string }): number {
  return fabWork(econ, p) * FIELD.recycleTime;
}

/**
 * Scale a bill by `k` in whole units, by largest remainders (ties: item id order), so the total is round(total x k).
 * Half of {alloy 2, wire 1}: round(1.5) = 2 units; alloy's exact 1, and the spare unit to wire (remainder 0.5): {alloy 1, wire 1}
 */
export function scaleBill(bill: Bag, k: number): Bag {
  const ids = Object.keys(bill).filter((id) => bill[id] > 0).sort();
  const exact = ids.map((id) => bill[id] * k);
  const total = Math.round(exact.reduce((s, v) => s + v, 0) + 1e-9);
  const out: Bag = {};
  let given = 0;
  ids.forEach((id, i) => { const f = Math.floor(exact[i] + 1e-9); if (f > 0) out[id] = f; given += f; });
  const order = ids.map((id, i) => ({ id, r: exact[i] - Math.floor(exact[i] + 1e-9) })).sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : 1));
  for (let i = 0; given < total && i < order.length; i++, given++) out[order[i].id] = (out[order[i].id] ?? 0) + 1;
  return out;
}

/** What recycling a part gives back: FIELD.recycleReturn of its inputs, in whole units */
export function recycleReturn(econ: Economy, p: { fn: string; material: string; piece: string }): Bag {
  return scaleBill(fieldBuildInputs(econ, p), FIELD.recycleReturn);
}

/** What repairing a damaged part takes: FIELD.repairCost x the HP share missing of its inputs, at least one unit */
export function repairBill(econ: Economy, p: { fn: string; material: string; piece: string }, missing: number): Bag {
  const m = clamp01(missing);
  if (m <= 0) return {};
  const inputs = fieldBuildInputs(econ, p);
  const out = scaleBill(inputs, FIELD.repairCost * m);
  if (Object.keys(out).length) return out;
  // (At least one unit: the input it takes most of, ties by id)
  const top = Object.keys(inputs).sort((a, b) => inputs[b] - inputs[a] || (a < b ? -1 : 1))[0];
  return top ? { [top]: 1 } : {};
}

/** Ticks a job of `work` seconds takes at a machine's full speed (packShare: the share of its units packs paid, 0..1) */
export function jobTicks(work: number, speed: number, packShare = 0): number {
  if (!(work > 0)) return 0;
  const s = speed * (1 + FIELD.packSpeed * clamp01(packShare));
  return Math.max(1, Math.ceil((work * FIELD_TPS) / s - 1e-9));
}

/** Energy (eu) a powered machine's job takes: its ticks at full speed x the machine's draw a tick (PortsLayout.rate of its part) */
export function jobEu(work: number, speed: number, ratePerTick: number, packShare = 0): number {
  return jobTicks(work, speed, packShare) * Math.max(1, ratePerTick);
}

/** The grade of a refining recipe's output: a plate's material's, else by the level it opens at (none: Mk I) */
export function refineGrade(econ: Economy, recipeId: string): number {
  for (const [mat, plate] of Object.entries(econ.recipes.parts.plates)) if (plate === recipeId) return gradeOf(econ.ships.materials.get(mat));
  const lvl = econ.recipes.refining.get(recipeId)?.level ?? 0;
  return Math.max(1, Math.min(5, 1 + Math.floor(lvl / 10)));
}

/** Can a refiner of this tier (0: the core) run this refining recipe? */
export function canRefine(econ: Economy, tier: number, recipeId: string): boolean {
  if (!econ.recipes.refining.has(recipeId)) return false;
  return refineGrade(econ, recipeId) <= tierRule('refiner', tier).gradeCap;
}

/** Work seconds for one batch of a refining recipe (at speed 1 = a station's pace) */
export function refineWork(econ: Economy, recipeId: string): number {
  return econ.recipes.refining.get(recipeId)?.time ?? 2;
}

/**
 * Refilling a Mine Bay's magazine (docs/design/groups-mines-docking.md, "Mine bay"): a fabricator job (`rearm`) that
 * makes up to `batch` mines at a time for one bay. PLACEHOLDER numbers (Kieran 2026-11-07: "a placeholder cost for now,
 * we can adjust it later"): work seconds and hold materials per mine. Any fabricator tier, the core's own too
 */
export const REARM = Object.freeze({
  /** Work seconds a mine */
  secondsPerMine: 3,
  /** Hold materials a mine (whole units) */
  costPerMine: Object.freeze({ alloy_plate: 1, copper_wire: 1 }) as Readonly<Bag>,
  /** Mines one job makes at most (the rest wait for the next job) */
  perJob: 4,
});

/** What a rearm job of `n` mines takes from the hold, and its work seconds */
export function rearmBill(n: number): Bag {
  const k = Math.max(0, Math.floor(n)), out: Bag = {};
  for (const [id, u] of Object.entries(REARM.costPerMine)) if (u * k > 0) out[id] = u * k;
  return out;
}
export const rearmWork = (n: number): number => REARM.secondsPerMine * Math.max(0, Math.floor(n));

function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/** A placed part's spec (what the rules read) */
export const specOf = (p: PlacedPart): { fn: string; material: string; piece: string } => ({ fn: p.fn, material: p.material, piece: p.piece });
