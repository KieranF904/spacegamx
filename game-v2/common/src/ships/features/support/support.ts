/**
 * Support weapons (docs/design/build-archetypes.md §5 #6 and #7): the Repair Beam and the Point Defence Turret.
 *
 * Repair Beam (tuning.json weapons.repair, `heal`): a held beam, aimed like any turret at the cursor and fired with
 * the guns. It passes through every ship it may not heal and stops on the first friendly hull it meets (a party
 * member, any pilot outside a PvP zone, a ward). There it mends `heal` HP a second (× the gun's strength and power),
 * spread over the damaged parts nearest where it lands, the nearest first (repairAt). It never heals the ship it's
 * on, never a destroyed part (that's a station's or a kit's job), and never a shield. It draws its power while it's on,
 * like any held beam; it doesn't heat.
 *
 * Point Defence (weapons.point_defence, `pointDefence`): a turret that fires on its own, never on the trigger. It looks
 * for projectiles within its range that it can shoot down (their kind's `intercept`: hits to bring one down; a boss's
 * nova never, whatever its kind) fired by ships that may hurt its own, turns to the nearest at `slew` × a turret's
 * rate, and fires when on it: each shot takes one of its hits, instantly. It never hurts a ship. Its shots draw their
 * power over the reload, as any gun's. The server runs it (features/support pointDefence); clients see an `intercept` event.
 */

import type { ShipState } from '../../state.js';
import { healPart } from '../../state.js';
import type { ShipTuning, WeaponTuning } from '../../tuning.js';
import type { PlacedGeom } from '../../grid.js';
import { partDistance } from '../../collide.js';
import { stepTurretAim, type TurretWindow } from '../../turret.js';

/** Weapon role ids of the support feature (features/support/index.ts); the server's hooks hang on these */
export const REPAIR_BEAM = 'repairBeam';
export const POINT_DEFENCE = 'pointDefence';

/** A point-defence gun's own settings (WeaponTuning.pointDefence), every default filled in */
export interface PointDefenceTuning {
  /** How far it reaches (world units, from its pivot) */
  range: number;
  /** × a turret's slew rate: it turns this much faster than a gun on the trigger */
  slew: number;
}

export const DEFAULT_POINT_DEFENCE: PointDefenceTuning = { range: 560, slew: 3 };

/** A kind that fires itself at incoming projectiles (and never on the trigger) */
export function isPointDefence(tuning: ShipTuning, kind: string): boolean {
  return !!tuning.weapons?.[kind]?.pointDefence;
}

/** A weapon's tuning that fires itself at incoming projectiles (the Point Defence feature's role) */
export function pointDefenceDef(def: WeaponTuning | undefined): boolean {
  return !!def?.pointDefence;
}

/** A weapon's tuning whose beam mends instead of hurting (the Repair Beam feature's role; any heal at all, as the beam dispatch has always read it) */
export function repairBeamDef(def: WeaponTuning | undefined): boolean {
  return !!def?.heal;
}

/** A kind whose beam mends instead of hurting */
export function isRepairBeam(tuning: ShipTuning, kind: string): boolean {
  return (tuning.weapons?.[kind]?.heal ?? 0) > 0;
}

/** A point-defence gun's settings */
export function pointDefenceOf(def: WeaponTuning | undefined): PointDefenceTuning {
  return { ...DEFAULT_POINT_DEFENCE, ...(def?.pointDefence ?? {}) };
}

/** Hits it takes a point-defence gun to shoot down a shot of this kind (0: it can't) */
export function interceptHits(def: WeaponTuning | undefined): number {
  return Math.max(0, Math.round(def?.intercept ?? 0));
}

/**
 * Mend `amount` HP into the damaged parts nearest grid point (gx, gy): the nearest first, whatever it can't take
 * going on to the next, at most `spread` parts. Destroyed and lost parts are left alone. Returns the HP mended.
 */
export function repairAt(ship: ShipState, geoms: readonly PlacedGeom[], gx: number, gy: number, amount: number, tuning: ShipTuning, spread = 3): number {
  if (amount <= 0) return 0;
  const near: { i: number; d: number }[] = [];
  for (let i = 0; i < ship.hp.length; i++) {
    if (!ship.derived.alive[i] || ship.detached[i] || ship.hp[i] <= 0 || ship.hp[i] >= ship.maxHp[i] - 1e-6 || !geoms[i]) continue;
    near.push({ i, d: partDistance(geoms[i], gx, gy) });
  }
  near.sort((a, b) => a.d - b.d || a.i - b.i);
  let left = amount, healed = 0;
  for (let k = 0; k < near.length && k < spread && left > 1e-9; k++) {
    const got = healPart(ship, near[k].i, left, tuning);
    healed += got;
    left -= got;
  }
  return healed;
}

/** The tuning a point-defence turret slews with (`slew` × the turret rate), built once a tuning */
const fastTurret = new WeakMap<ShipTuning, Map<number, ShipTuning>>();
function slewing(tuning: ShipTuning, slew: number): ShipTuning {
  let byK = fastTurret.get(tuning);
  if (!byK) fastTurret.set(tuning, (byK = new Map()));
  let t = byK.get(slew);
  if (!t) byK.set(slew, (t = { ...tuning, turret: { ...tuning.turret, slewRate: tuning.turret.slewRate * slew } }));
  return t;
}

/**
 * One tick of a point-defence turret's aim: towards `desiredLocal` (grid frame, as stepTurretAim), or back to rest
 * (straight out) when there's nothing (undefined). Whether it's on target and clear to fire.
 */
export function stepPointDefenceAim(w: TurretWindow, current: number, desiredLocal: number | undefined, tuning: ShipTuning, slew: number): { offset: number; canFire: boolean } {
  const res = stepTurretAim(w, current, desiredLocal ?? w.center, slewing(tuning, slew));
  return desiredLocal === undefined ? { offset: res.offset, canFire: false } : res;
}
