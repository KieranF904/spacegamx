/**
 * @contract ships.damage
 * owns:       the damage rules for a block a hit lands on: penetration against armour, material resist by damage type
 * needs:      ShipTuning (tuning.json damage), material and function defs from the catalog
 * invariants: a gun does full damage to equal-grade blocks and falls off by whole grade steps — common/src/ships/invariants.test.ts
 * extend:     a new damage type is a resist entry in materials.json and a name in DAMAGE_TYPES, not a branch here
 */

/**
 * What a hit does to the block it lands on. Damage isn't absolute: it depends
 * on the weapon and on what it hits.
 *
 *   penetration  a weapon's: its own grade (Mk I-V), plus its type's bonus
 *                (tuning.json weapons.<kind>.pen: a railgun pierces, flak
 *                doesn't)
 *   armour       a block's: its material's grade, plus its function's own
 *                (armour plate: +1)
 *
 * The gap between them sets the damage (tuning.json damage.penetration, by
 * whole steps, in between interpolated): a Mk I gun does full damage to Mk I
 * components, about half to Mk I plate or Mk II components, a quarter to Mk
 * II plate, and barely scratches Mk III. Then each material takes its own
 * share of each damage type (materials.json resist: ceramic shrugs off heat
 * but cracks under shells, insulated polymer turns energy but melts...).
 *
 * So a better gun matters most for what it can get through, fights between
 * equals last longer, and a better-armoured enemy has to be taken apart at
 * its weak points.
 */

import type { Catalog } from './catalog.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';
import type { PlacedPart, MaterialDef } from './types.js';
import { partGrade, partMaterial } from './grades.js';

export type DamageType = 'kinetic' | 'explosive' | 'thermal' | 'energy' | 'cryo' | 'exotic';
export const DAMAGE_TYPES: DamageType[] = ['kinetic', 'explosive', 'thermal', 'energy', 'cryo', 'exotic'];

export const DAMAGE_NAMES: Record<DamageType, string> = {
  kinetic: 'Kinetic', explosive: 'Explosive', thermal: 'Thermal', energy: 'Energy', cryo: 'Cryo', exotic: 'Exotic',
};

/** A hit's kind and how hard it punches through */
export interface HitInfo { type: DamageType; pen: number }

/** Damage × this at each (penetration − armour), when the data gives none */
const DEFAULT_PENETRATION: Record<string, number> = { '-4': 0.05, '-3': 0.1, '-2': 0.25, '-1': 0.55, '0': 1, '1': 1.15 };

function table(tuning: ShipTuning | undefined): Record<string, number> {
  return (tuning as { damage?: { penetration?: Record<string, number> } } | undefined)?.damage?.penetration ?? DEFAULT_PENETRATION;
}

/** Damage × this for a hit `gap` steps of penetration over (or, negative, under) the armour */
export function penetrationMul(gap: number, tuning?: ShipTuning): number {
  const t = table(tuning);
  const steps = Object.keys(t).map(Number).sort((a, b) => a - b);
  if (gap <= steps[0]) return t[String(steps[0])];
  if (gap >= steps[steps.length - 1]) return t[String(steps[steps.length - 1])];
  const lo = Math.floor(gap), hi = Math.ceil(gap);
  const a = t[String(lo)] ?? 1, b = t[String(hi)] ?? 1;
  return lo === hi ? a : a + (b - a) * (gap - lo);
}

/**
 * A block's armour: its grade (its material's, or a model's tier), and its function's own (armour plate +1); a
 * bespoke piece with an `armour` of its own has that outright (a boss's limbs)
 */
export function partArmour(catalog: Catalog, p: { material: string; fn: string; piece?: string }): number {
  const own = p.piece !== undefined ? catalog.pieces.get(p.piece)?.armour : undefined;
  if (own !== undefined) return own;
  return partGrade(catalog, p) + (catalog.functions.get(p.fn)?.armour ?? 0);
}

/** A material's share of a damage type (1: all of it) */
export function resistOf(m: MaterialDef | undefined, type: DamageType): number {
  return m?.resist?.[type] ?? 1;
}

/** The damage type a weapon deals when its data doesn't say */
const TYPE_BY_KIND: Record<string, DamageType> = {
  cannon: 'kinetic', railgun: 'kinetic', autocannon: 'kinetic',
  flak: 'explosive', missile: 'explosive', torpedo: 'explosive', mortar: 'explosive', hive: 'explosive', charge: 'explosive',
  laser: 'thermal', lance: 'thermal', cinder_bloom: 'thermal', magma: 'thermal', heart_spark: 'thermal', heart_seeker: 'thermal', seam_seeker: 'energy',
  pulse: 'energy', arc: 'energy', emp: 'energy', prism: 'energy', prism_shard: 'energy',
  frostbite: 'cryo',
  phase: 'exotic', singularity: 'exotic',
};

/** What a weapon of `grade` hits with */
export function weaponHit(kind: string, def: WeaponTuning | undefined, grade: number): HitInfo {
  return { type: (def?.damageType as DamageType | undefined) ?? TYPE_BY_KIND[kind] ?? 'kinetic', pen: grade + (def?.pen ?? 0) };
}

/** Damage × this for `hit` landing on part `p` */
export function hitMultiplier(catalog: Catalog, tuning: ShipTuning | undefined, p: { material: string; fn: string; piece?: string }, hit: HitInfo): number {
  return penetrationMul(hit.pen - partArmour(catalog, p), tuning) * resistOf(partMaterial(catalog, p), hit.type);
}

/** The grade of the part that fired (its material's, or a model's tier) */
export function shooterGrade(catalog: Catalog, p: PlacedPart | undefined): number {
  return p ? partGrade(catalog, p) : 1;
}
