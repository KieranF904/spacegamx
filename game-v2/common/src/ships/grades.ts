/**
 * Grades and sizes: what makes one part better than another of the same kind.
 *
 * A part's material is its grade (Mk I alloy and composite, Mk II steel,
 * Mk III titanium, Mk IV cobalt, Mk V neutronium: data/ships/materials.json).
 * Higher grades are tougher, and their `output` multiplies what graded parts
 * do: weapon damage, generator power and shield strength. Graded consumers
 * (weapons, shields) draw `output` times the power too, so better guns need
 * better generators behind them. Each grade of gun has a character of its own
 * on top (tuning.json weaponGrades: a Mk II cannon throws heavier, slower
 * shells, a Mk III one fast slugs...).
 *
 * A weapon's size is its piece: a bigger piece is a bigger gun. Damage grows a
 * little faster than the cells (and the power) it takes, (area / base)^1.15,
 * base being the smallest whole-cell piece the weapon comes in. Some kinds
 * change in other ways as they grow (tuning.json weapons.<kind>.bySize: a big
 * flak gun's bursts are wider, and it loads slower).
 *
 * A model (functions marked `model`: data/ships/models.json) is none of that:
 * its numbers are its own, at its own size, whatever it's built of. Its
 * material is only its HP, mass and resistances; its `grade` is its tier.
 */

import type { Catalog } from './catalog.js';
import type { Blueprint, FunctionDef, MaterialDef } from './types.js';
import { dpow } from '../math/detTrig.js';

export const MARKS = ['', 'I', 'II', 'III', 'IV', 'V'];
export const MAX_GRADE = 5;

/** Weapon damage per cell grows by this power of the size */
const WEAPON_SIZE_EXP = 1.15;

export function gradeOf(m: MaterialDef | undefined): number {
  return Math.max(1, Math.min(MAX_GRADE, Math.round(m?.grade ?? 1)));
}

export function outputOf(m: MaterialDef | undefined): number {
  return m?.output ?? 1;
}

/** What a part's material multiplies: its output, or nothing for a model (its numbers are its own) */
export function fnOutput(fn: FunctionDef, m: MaterialDef | undefined): number {
  return fn.model ? 1 : outputOf(m);
}

/** The material a part is made of: a model's own, else the part's */
export function partMaterial(catalog: Catalog, p: { fn: string; material: string }): MaterialDef | undefined {
  const fn = catalog.functions.get(p.fn);
  return catalog.materials.get(fn?.model && fn.material ? fn.material : p.material);
}

/** A part's grade (Mk I-V): a model's tier, else its material's */
export function partGrade(catalog: Catalog, p: { fn: string; material: string }): number {
  const fn = catalog.functions.get(p.fn);
  return fn?.model ? Math.max(1, Math.min(MAX_GRADE, Math.round(fn.grade ?? 1))) : gradeOf(catalog.materials.get(p.material));
}

/** "Mk III" */
export function markName(grade: number): string {
  return `Mk ${MARKS[Math.max(1, Math.min(MAX_GRADE, grade))]}`;
}

/** Does this function's output (and power draw) scale with grade: weapons, generators, shields */
export function isGraded(fn: FunctionDef): boolean {
  return !!fn.weapon || (fn.produce ?? 0) > 0 || (fn.shield ?? 0) > 0;
}

/** The area of the size a weapon (or engine) comes in at its smallest (1 for most, 2 for the long guns and plasma drives) */
export function weaponBaseArea(catalog: Catalog, fn: FunctionDef): number {
  // (A model is its own size: its smallest piece is its base)
  if (fn.model && fn.pieces !== '*') return Math.min(...fn.pieces.map((id) => catalog.variants.get(id)?.[0]?.area ?? 1));
  const pieces = fn.pieces === '*' ? catalog.pieceIds : fn.pieces;
  // Whole-cell pieces only: a wedge is a smaller (weaker) version of the square, not the base size
  const areas = pieces.map((id) => catalog.variants.get(id)?.[0]?.area ?? 1).filter((a) => a >= 1 - 1e-9);
  return areas.length ? Math.min(...areas) : 1;
}

/** How much harder a weapon of this size hits than its base size */
export function weaponSizeFactor(catalog: Catalog, fn: FunctionDef, area: number): number {
  if (fn.model) return 1;
  return dpow(area / weaponBaseArea(catalog, fn), WEAPON_SIZE_EXP);
}

/** A weapon part's strength: grade × size (1 for a base-size Mk I) */
export function weaponStrength(catalog: Catalog, fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  return fnOutput(fn, m) * weaponSizeFactor(catalog, fn, area);
}

/** Engine thrust grows a little faster than its size; better grades push harder (√output) */
const THRUST_SIZE_EXP = 0.15;

/** Is this an engine (it pushes the ship) */
export function isEngine(fn: FunctionDef | undefined): boolean {
  return (fn?.thrust ?? 0) > 0;
}

/** An engine's thrust at full power (0 for anything else) */
export function partThrust(catalog: Catalog, fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  if (!isEngine(fn)) return 0;
  if (fn.model) return fn.thrust! * area;
  return fn.thrust! * area * dpow(area / weaponBaseArea(catalog, fn), THRUST_SIZE_EXP) * Math.sqrt(outputOf(m));
}

/** Power a part makes (generators; 0 for everything else), at full health */
/**
 * A better gun draws more power by as much as it hits harder, so for the power
 * it's never worse than the gun it replaces: on a ship short of power (guns
 * wait on the battery) a Mk II gun still out-damages a Mk I one. (It was
 * output^2.2 once, and an upgraded gun on the same generators fired so much
 * less often that it did less damage.) Better generators make more than that
 * (output^1.5), so an all-Mk II ship has power to spare over an all-Mk I one.
 */
const WEAPON_DRAW_EXP = 1;
const GENERATOR_EXP = 1.5;

export function partSupply(fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  if (!(fn.produce ?? 0)) return 0;
  return fn.produce! * area * dpow(fnOutput(fn, m), GENERATOR_EXP);
}

/**
 * Build points: what a ship costs against a pilot's budget (unlocks.json
 * complexity, more as they level). Every cell counts, and better grades count
 * for more: a big Mk I ship and a small Mk III one cost about the same.
 */
export const GRADE_BUILD_COST = [1, 1.6, 2.5, 3.8, 5.5];

export function partBuildPoints(catalog: Catalog, p: { piece: string; material: string; fn?: string }): number {
  const area = catalog.variants.get(p.piece)?.[0]?.area ?? 1;
  const fn = p.fn !== undefined ? catalog.functions.get(p.fn) : undefined;
  // (A model's own points a cell)
  if (fn?.model && fn.points !== undefined) return area * fn.points;
  const grade = fn ? partGrade(catalog, { fn: p.fn!, material: p.material }) : gradeOf(catalog.materials.get(p.material));
  return area * GRADE_BUILD_COST[Math.max(1, Math.min(GRADE_BUILD_COST.length, grade)) - 1];
}

export function buildPoints(catalog: Catalog, bp: { parts: { piece: string; material: string; fn?: string }[] }): number {
  return Math.round(bp.parts.reduce((n, p) => n + partBuildPoints(catalog, p), 0));
}

/** Power a part draws (consumers; 0 for everything else) */
export function partDemand(fn: FunctionDef, area: number, m: MaterialDef | undefined): number {
  if (!(fn.demand ?? 0)) return 0;
  if (fn.model) return fn.demand! * area;
  return fn.demand! * area * (fn.weapon ? dpow(outputOf(m), WEAPON_DRAW_EXP) : isGraded(fn) ? outputOf(m) : isEngine(fn) ? Math.sqrt(outputOf(m)) : 1);
}

/** The material of a grade (the main one: Mk I is alloy, not composite) */
export function gradeMaterial(catalog: Catalog, grade: number): string {
  let best: MaterialDef | undefined;
  for (const m of catalog.materials.values()) {
    if (gradeOf(m) !== grade || m.exclusive) continue;
    if (!best || m.toughness > best.toughness) best = m;
  }
  return best?.id ?? 'alloy';
}

/**
 * The same design built in another grade: every part in that grade's material
 * (parts already of that grade keep theirs: composite stays composite at Mk I).
 * Enemies are spawned this way, a system's grade setting how tough its ships are.
 */
export function regrade(catalog: Catalog, bp: Blueprint, grade: number): Blueprint {
  const g = Math.max(1, Math.min(MAX_GRADE, Math.round(grade)));
  const mat = gradeMaterial(catalog, g);
  return {
    ...bp,
    // (A model is what it is)
    parts: bp.parts.map((p) => (catalog.functions.get(p.fn)?.model || gradeOf(catalog.materials.get(p.material)) === g ? p : { ...p, material: mat })),
  };
}

/**
 * A design built in `grade`, its armour plates `plating` grades better (a
 * boss's or an elite's): its plate shrugs off guns of its own grade, so it's
 * taken apart at its weak points (damage.ts).
 */
export function plated(catalog: Catalog, bp: Blueprint, grade: number, plating: number): Blueprint {
  const out = regrade(catalog, bp, grade);
  if (plating <= 0) return out;
  const plate = gradeMaterial(catalog, Math.max(1, Math.min(MAX_GRADE, Math.round(grade + plating))));
  return { ...out, parts: out.parts.map((p) => (p.fn === 'armor' ? { ...p, material: plate } : p)) };
}

/** A ship's grade: the most common grade among its parts, by hit points */
export function blueprintGrade(catalog: Catalog, bp: Blueprint): number {
  const w = new Array(MAX_GRADE + 1).fill(0);
  for (const p of bp.parts) {
    const m = partMaterial(catalog, p);
    w[partGrade(catalog, p)] += (catalog.variants.get(p.piece)?.[0]?.area ?? 1) * (m?.toughness ?? 1);
  }
  let best = 1;
  for (let g = 1; g <= MAX_GRADE; g++) if (w[g] > w[best]) best = g;
  return best;
}

/** What killing a ship of a grade pays, against Mk I: output^1.6 (×1.5 at Mk II, ×4.6 at Mk V) */
export function gradeReward(catalog: Catalog, grade: number): number {
  return dpow(outputOf(catalog.materials.get(gradeMaterial(catalog, grade))), 1.6);
}
