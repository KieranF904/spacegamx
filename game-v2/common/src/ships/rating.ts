/**
 * Ship rating: one number for how strong a ship is, the same sum for every
 * ship (players' and enemies'), so systems, sieges and enemies can say what
 * they're pitched at and a pilot can see whether their ship is up to it.
 *
 * Every part scores in one of three ways:
 *   firepower  weapons: damage per second, at the power they actually get
 *   toughness  every part: its hit points (and shields: what they soak)
 *   power      generators: what they make (it counts through the weapons it feeds)
 *
 * The rating balances the two that fight: √(firepower × toughness) / SCALE.
 * A glass cannon or a brick rates lower than a ship with both. A starter
 * ship is about 10; each grade of parts is worth about a third more than the last.
 */

import type { Catalog } from './catalog.js';
import type { ShipTuning, WeaponTuning } from './tuning.js';
import type { ShipState } from './state.js';
import { partSupply, partGrade, partMaterial, fnOutput } from './grades.js';
import { penetrationMul, partArmour, weaponHit } from './damage.js';
import { partWeaponDef } from './launch.js';
import { averageInterval } from './guns.js';
import type { FireSpec } from './types.js';

/** Shields soak this many hit points per point of capacity (they come back) */
const SHIELD_WORTH = 2;
/** Splash damage counts this much (it doesn't always land on something) */
const SPLASH_WORTH = 0.6;
const SCALE = 35;
/** The reference fight a rating is scored against: Mk I guns, Mk I components (damage.ts) */
const REF_PEN = 1;
const REF_ARMOUR = 1;

export interface PartScore {
  /** Damage per second this part adds */
  firepower: number;
  /** Hit points (and shield) this part adds */
  toughness: number;
  /** Power it makes */
  power: number;
}

export interface ShipRating {
  rating: number;
  /** Damage per second, every weapon together */
  firepower: number;
  /** Hit points plus what the shields soak */
  toughness: number;
  parts: PartScore[];
}

type WeaponDef = { type?: string; damage?: number; dps?: number; burst?: number; walk?: { at: number[] }; salvo?: { count: number }; splash?: { damage: number; radius: number } };

/**
 * A weapon's sustained damage per second at full power, before grade and size (`gun`: one gun's own tuning, launch.ts
 * gunDef; `fire`: its firing model, guns.ts: a clip's reload and a charge's charge and cooldown count, a held beam burns its dps)
 */
export function baseWeaponDps(tuning: ShipTuning, kind: string, interval: number, gun?: WeaponTuning, fire?: FireSpec): number {
  const def = (gun ?? tuning.weapons?.[kind]) as WeaponDef | undefined;
  if (!def) return 0;
  if (fire?.model === 'beam') return (def as WeaponTuning).ramp?.to ?? def.dps ?? 0;
  interval = averageInterval(fire, interval);
  // A pulse laser: a pulse's damage every charge
  if ((def as WeaponTuning).pulse) return ((def.damage ?? 0) * 60) / Math.max(1, interval);
  // A beam burns as long as the power lasts (no heat: rework 2026-11)
  if (def.type === 'beam') return (def as WeaponTuning).ramp?.to ?? def.dps ?? 0;
  // A wider burst than its kind's own (a bigger flak gun's) lands on that many more parts
  const base = tuning.weapons?.[kind]?.splash?.radius;
  const wide = def.splash && base ? def.splash.radius / base : 1;
  return (((def.damage ?? 0) + (def.splash?.damage ?? 0) * SPLASH_WORTH * wide) * (def.burst ?? 1) * (def.walk?.at.length ?? def.salvo?.count ?? 1) * 60) / Math.max(1, interval);
}

/** The rating of a ship as built (its parts' current state: lost parts count nothing). `hpScale`: an enemy faction's toughness */
export function rateShip(catalog: Catalog, tuning: ShipTuning, ship: ShipState, hpScale = 1): ShipRating {
  const d = ship.derived;
  const n = ship.blueprint.parts.length;
  const parts: PartScore[] = Array.from({ length: n }, () => ({ firepower: 0, toughness: 0, power: 0 }));
  let firepower = 0, toughness = 0;
  // Guns fire as fast as the energy lasts: what the engines leave of the spare power, plus the stores over a fight's first twenty seconds or so
  const e = d.energy;
  const spare = e ? Math.max(0, e.supply - e.demand) : 0;
  const sustain = e && e.weaponDraw > 0 ? Math.max(0.25, Math.min(1, (Math.max(0, spare - e.engineDraw * 0.5) + e.max / 20) / e.weaponDraw)) : 1;
  for (const w of d.weapons) {
    // (What it gets through: against Mk I components; damage.ts)
    const p = ship.blueprint.parts[w.part];
    const def = partWeaponDef(tuning, w.kind, p, w);
    const pen = weaponHit(w.kind, def, partGrade(catalog, p)).pen;
    const dps = baseWeaponDps(tuning, w.kind, w.interval, def, w.fire) * w.strength * sustain * penetrationMul(pen - REF_ARMOUR, tuning);
    parts[w.part].firepower += dps;
    firepower += dps;
  }
  for (let i = 0; i < n; i++) {
    if (!d.alive[i]) continue;
    const p = ship.blueprint.parts[i];
    // (How long it lasts against Mk I guns: better armour shrugs off more of each hit)
    const hp = (ship.maxHp[i] * hpScale) / penetrationMul(REF_PEN - partArmour(catalog, p), tuning);
    parts[i].toughness += hp;
    toughness += hp;
    const fn = catalog.functions.get(p.fn);
    if (fn && (fn.produce ?? 0) > 0) parts[i].power = partSupply(fn, catalog.variants.get(p.piece)?.[0]?.area ?? 1, partMaterial(catalog, p));
    if (fn && (fn.shield ?? 0) > 0 && d.shieldMax > 0) {
      // What this shield generator adds to the ship's shield
      const share = fn.shield! * (catalog.variants.get(p.piece)?.[0]?.area ?? 1) * fnOutput(fn, partMaterial(catalog, p));
      parts[i].toughness += share * SHIELD_WORTH;
      toughness += share * SHIELD_WORTH;
    }
  }
  return { rating: ratingOf(firepower, toughness), firepower, toughness, parts };
}

export function ratingOf(firepower: number, toughness: number): number {
  return Math.sqrt(Math.max(0, firepower) * Math.max(0, toughness)) / SCALE;
}

/** How a ship of `mine` fares against something pitched at `theirs`: 'easy' | 'fair' | 'hard' | 'deadly' */
export function threatLevel(mine: number, theirs: number): 'easy' | 'fair' | 'hard' | 'deadly' {
  const k = mine / Math.max(1e-6, theirs);
  return k >= 1.5 ? 'easy' : k >= 0.85 ? 'fair' : k >= 0.55 ? 'hard' : 'deadly';
}
