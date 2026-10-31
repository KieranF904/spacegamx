/**
 * What one part does, in plain numbers, for the fabricator, the hangar and
 * tooltips: its grade and size, hit points and mass, and (by function) its
 * damage per second and reach, the power it makes or draws, its thrust,
 * shield or cargo space; plus its score towards the ship's rating
 * (ships/rating.ts): firepower, toughness or power.
 *
 * Numbers are for the part at full power. A weapon's real damage depends on
 * the generators behind it: under-powered, it fires slower and softer.
 */

import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';
import { fnOutput, isEngine, markName, partDemand, partGrade, partMaterial, partSupply, partThrust, weaponBaseArea, weaponSizeFactor, weaponStrength } from './grades.js';
import { gunDef, gunRate } from './launch.js';
import { pointDefenceOf } from './support.js';
import { effectiveRange } from './pulse.js';
import type { WeaponMods } from './types.js';
import { baseWeaponDps } from './rating.js';
import { towTuning, DEFAULT_TOW } from './tow.js';
import { partArmour, weaponHit, DAMAGE_TYPES, type DamageType } from './damage.js';

export interface PartStats {
  grade: number;
  /** "Mk III" */
  mark: string;
  /** "Small" / "Medium" / "Large" / "Heavy" (weapons and generators; empty for the rest) */
  size: string;
  /** Cells it covers */
  area: number;
  hp: number;
  mass: number;
  /** Weapons: damage per second at full power, and how far it reaches (world units) */
  dps?: number;
  range?: number;
  /** Beams that fade with distance: full strength out to here, `range` being where they give out */
  effectiveRange?: number;
  /** Pulse lasers: a pulse's damage, and the seconds it takes to charge one */
  pulse?: { damage: number; seconds: number };
  /** A Repair Beam: HP a second it mends into a friendly ship (support.ts; no damage, no firepower) */
  heal?: number;
  /** Point defence: shots a second it fires at incoming shots, and its reach (support.ts; no damage, no firepower) */
  intercept?: { perSec: number; range: number };
  /** Power made (generators) or drawn (everything that runs on it) */
  supply?: number;
  draw?: number;
  thrust?: number;
  /** Engines, while boosting: × push, and × battery drain */
  boost?: number;
  boostDrain?: number;
  shield?: number;
  cargo?: number;
  /** Burst Strafer (strafer.ts): its push away from its nozzle while a burst runs (force), the burst's seconds, the seconds from one burst to the next, and the energy a burst (pushing straight out) */
  dodge?: { force: number; secs: number; cooldown: number; energy: number };
  /** Tow Beam (tow.ts): how far past the hull it takes hold, and how far it stretches before it snaps */
  tow?: { range: number; snap: number };
  /** Towards the ship's rating */
  firepower: number;
  toughness: number;
  /** Its armour (damage.ts), and the damage types its material takes more or less of (× each) */
  armour: number;
  resist?: Partial<Record<DamageType, number>>;
  /** Weapons: what they hit with, and how hard they punch through */
  damageType?: DamageType;
  pen?: number;
}

const SIZE_NAMES: [number, string][] = [[1, 'Small'], [2, 'Medium'], [4, 'Large'], [9, 'Heavy']];

/** "Small" for a base-size weapon, up to "Heavy" for 9× (wedges and odd shapes: the nearest) */
export function sizeName(ratio: number): string {
  let best = SIZE_NAMES[0];
  for (const s of SIZE_NAMES) if (Math.abs(Math.log(ratio / s[0])) < Math.abs(Math.log(ratio / best[0]))) best = s;
  return ratio < 0.75 ? 'Light' : best[1];
}

export function partStats(catalog: Catalog, tuning: ShipTuning | undefined, p: { material: string; fn: string; piece: string }): PartStats | null {
  const fn = catalog.functions.get(p.fn), mat = partMaterial(catalog, p), v = catalog.variants.get(p.piece)?.[0];
  if (!fn || !mat || !v) return null;
  const area = v.area;
  const grade = partGrade(catalog, p);
  const hp = area * mat.toughness * fn.hpScale;
  const out: PartStats = { grade, mark: markName(grade), size: '', area, hp, mass: area * mat.density * (fn.massScale ?? 1), firepower: 0, toughness: hp, armour: partArmour(catalog, p) };
  const resist: Partial<Record<DamageType, number>> = {};
  for (const t of DAMAGE_TYPES) if (mat.resist?.[t] !== undefined && mat.resist[t] !== 1) resist[t] = mat.resist[t];
  if (Object.keys(resist).length) out.resist = resist;
  if (fn.weapon) {
    // (A model is its own size: named by its piece, a square Small, a panel Medium, a block Large)
    out.size = fn.model ? sizeName(Math.max(1, area)) : sizeName(weaponSizeFactor(catalog, fn, area) ** (1 / 1.15));
    // Its own tuning: its kind's, with its grade's character and its size's (launch.ts gunDef)
    // (A model is its own size, with its own changes)
    const size = fn.model ? 1 : area / weaponBaseArea(catalog, fn);
    const model = fn.model ? fn.weaponMods ?? {} : undefined;
    const gun = tuning?.weapons?.[fn.weapon] ? gunDef(tuning, fn.weapon, { grade, size, mods: (p as { mods?: WeaponMods }).mods, model }) : undefined;
    const def = gun as { type?: string; range?: number; speed?: number; life?: number; maxSpeed?: number } | undefined;
    if (tuning) {
      const interval = (fn.fireInterval ?? 10) / (fn.model ? 1 : gunRate(tuning, fn.weapon, grade, size));
      out.dps = baseWeaponDps(tuning, fn.weapon, interval, gun) * weaponStrength(catalog, fn, area, mat);
      out.firepower = out.dps;
      if (gun?.pulse) out.pulse = { damage: (gun.damage ?? 0) * weaponStrength(catalog, fn, area, mat), seconds: interval / 60 };
      // (Support weapons do no damage and count nothing towards firepower: support.ts)
      if (gun?.heal) { out.heal = gun.heal * weaponStrength(catalog, fn, area, mat); out.dps = 0; out.firepower = 0; }
      if (gun?.pointDefence) { out.intercept = { perSec: 60 / interval, range: pointDefenceOf(gun).range }; out.dps = 0; out.firepower = 0; }
    }
    // (A bigger cannon's shells fly faster for less long: the same reach)
    if (def) out.range = def.type === 'beam' ? def.range : (def.maxSpeed ?? def.speed ?? 0) * (def.life ?? 0);
    if (gun?.pointDefence) out.range = pointDefenceOf(gun).range;
    if (gun?.falloff) out.effectiveRange = effectiveRange(gun);
    const hit = weaponHit(fn.weapon, gun, grade);
    out.damageType = hit.type;
    out.pen = hit.pen;
  }
  if ((fn.produce ?? 0) > 0) { out.supply = partSupply(fn, area, mat); out.size = sizeName(fn.model ? Math.max(1, area) : area); }
  if ((fn.demand ?? 0) > 0) out.draw = partDemand(fn, area, mat);
  if (isEngine(fn)) {
    out.thrust = partThrust(catalog, fn, area, mat);
    out.size = fn.model ? sizeName(Math.max(1, area)) : sizeName(weaponSizeFactor(catalog, fn, area) ** (1 / 1.15));
    out.boost = fn.boost ?? 2.2;
    out.boostDrain = fn.boostDrain ?? 1;
  }
  if ((fn.shield ?? 0) > 0) out.shield = fn.shield! * area * fnOutput(fn, mat);
  if ((fn.capacity ?? 0) > 0) out.cargo = fn.capacity! * area;
  // (A Burst Strafer: a dodge, not thrust: strafer.ts)
  if (fn.strafe) {
    const st = fn.strafe;
    out.size = sizeName(Math.max(1, area));
    out.dodge = { force: st.kick * area * fnOutput(fn, mat), secs: st.ticks / 60, cooldown: st.cooldown / 60, energy: (partDemand(fn, area, mat) * st.ticks) / 60 };
  }
  if (fn.tow) {
    const t = tuning ? towTuning(tuning) : DEFAULT_TOW;
    out.tow = { range: t.range, snap: t.snap };
  }
  return out;
}
