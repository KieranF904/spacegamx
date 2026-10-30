/**
 * The seam for the later roguelike modifier system: buildShot() decides what a
 * weapon part fires. For now it is the game's base shot, scaled by satisfaction.
 */

import type { Vec2 } from './types.js';
import type { WeaponInfo } from './rebuild.js';
import type { ShipState } from './state.js';
import type { ShipTuning } from './tuning.js';
import { localToWorldDir } from './flight.js';
import { shotSeed } from './rng.js';

export interface ProjectileSpec {
  /** 'base' = the engine's standard blaster shot */
  kind: 'base';
  x: number;
  y: number;
  angle: number;
  /** Multiplier on the base shot's damage */
  damageScale: number;
  /** Multipliers on the base shot's speed and size (legacy fixed cannons fire slower, bigger shells) */
  speedScale: number;
  sizeScale: number;
  mount: 'fixed' | 'turret';
  /** hash(shipId, weaponUid, tick): lets networking send one fire event later instead of every projectile */
  seed: number;
  weaponUid: number;
}

export interface ShipPose { x: number; y: number; angle: number }

/** Grid point on the ship → world position (the ship's world position is its centre of mass). */
export function shipPointToWorld(ship: ShipState, pose: ShipPose, p: Vec2, cellSize: number): Vec2 {
  const com = ship.derived.com;
  const [wx, wy] = localToWorldDir([(p[0] - com[0]) * cellSize, (p[1] - com[1]) * cellSize], pose.angle);
  return [pose.x + wx, pose.y + wy];
}

export function buildShot(weapon: WeaponInfo, ship: ShipState, pose: ShipPose, tick: number, tuning: ShipTuning): ProjectileSpec {
  let muzzle = weapon.muzzle;
  let dir = weapon.dir;
  if (weapon.mount === 'turret' && weapon.window) {
    // Turrets fire along their current aim, from the end of the barrel
    const w = weapon.window;
    const a = w.center + ship.aim[weapon.part];
    dir = [Math.cos(a), Math.sin(a)];
    muzzle = [w.pivot[0] + dir[0] * w.barrel, w.pivot[1] + dir[1] * w.barrel];
  } else if (ship.aim[weapon.part]) {
    // Fixed guns fire along their facing, turned by their small gimbal
    const a = Math.atan2(dir[1], dir[0]) + ship.aim[weapon.part];
    dir = [Math.cos(a), Math.sin(a)];
  }
  const [x, y] = shipPointToWorld(ship, pose, muzzle, tuning.cellSize);
  const [dx, dy] = localToWorldDir(dir, pose.angle);
  return {
    kind: 'base',
    x,
    y,
    angle: Math.atan2(dy, dx),
    // Grade and size: a bigger, better gun throws bigger, faster, harder shells
    damageScale: Math.max(weapon.satisfaction, tuning.flow.minWeaponSatisfaction) * (weapon.strength ?? 1),
    // (A legacy fixed gun's shells are slower and bigger: tuning.fixedGun. A model's are its own, its weaponMods)
    speedScale: (weapon.mount === 'fixed' && !weapon.model ? tuning.fixedGun?.speedScale ?? 1 : 1) * Math.pow(weapon.size ?? 1, 0.12),
    sizeScale: (weapon.mount === 'fixed' && !weapon.model ? tuning.fixedGun?.sizeScale ?? 1 : 1) * Math.sqrt(weapon.size ?? 1),
    mount: weapon.mount,
    seed: shotSeed(ship.id, weapon.uid, tick),
    weaponUid: weapon.uid,
  };
}
