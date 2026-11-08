/**
 * @contract client.ship.render.flak-aim
 * owns:       where each of your flak turrets' shells will burst along its drawn aim (the aim distance, within the shell's
 *             reach), for the burst markers (rendering/weapons/fx/FlakAimFx.ts)
 * needs:      the views map (BodyView, Turret), common partWeaponDef/aimReach/lifeToReach/gunSelected/partWeaponGroups
 * invariants: only guns that end at the aim and burst (endAtAim with a splash) get a mark, at the distance the shell's life allows — client/src/ships/render/flakAim.test.ts
 * extend:     another gun that ends at the aim and bursts is already covered; a different marker shape is FlakAimFx's
 */

import { aimReach, gunSelected, lifeToReach, partWeaponDef, partWeaponGroups, type ShipTuning, type WeaponTuning } from '@space-game/common';
import type { BodyView } from './viewTypes';

/** The mark a gun's shell makes, written into `out` */
export interface FlakMark { x: number; y: number; r: number; firing: number }

/** How far along its aim a shell of this gun flies for a cursor `dist` from the ship (the server's cut of its life), or 0 if it does not burst at the aim */
export function burstTravel(def: WeaponTuning, dist: number): number {
  if (!def.endAtAim || !def.splash || !def.speed || !def.life) return 0;
  return lifeToReach(def.life, def.speed, aimReach(dist, def)) * def.speed;
}

/**
 * Your ship's flak turrets' burst marks into `out` (as many as it holds); returns how many. `sel` is the weapon group
 * selection (groupSelection.packed), `dist` the cursor's distance from the ship, `firing` 1 while the trigger is held.
 */
export function flakMarks(views: ReadonlyMap<number, BodyView>, tuning: ShipTuning, owner: number, dist: number, sel: number, firing: number, out: FlakMark[]): number {
  const view = views.get(owner), ship = view?.ship;
  if (!view || !ship || !view.turrets.length || !view.container.visible) return 0;
  const c = view.container, cos = Math.cos(c.rotation), sin = Math.sin(c.rotation), hasMiners = ship.derived.miners.length > 0;
  let n = 0;
  for (const t of view.turrets) {
    if (n >= out.length) break;
    const w = ship.derived.weapons[t.weapon];
    if (!w) continue;
    const part = ship.blueprint.parts[w.part];
    if (!gunSelected(partWeaponGroups(part), sel, hasMiners)) continue;
    const def = partWeaponDef(tuning, w.kind, part, w);
    const travel = burstTravel(def, dist);
    if (travel <= 0) continue;
    // The barrel's tip as drawn, then along its aim
    const a = c.rotation + t.barrel.rotation;
    const lx = t.x0 + Math.cos(t.barrel.rotation) * t.len, ly = t.y0 + Math.sin(t.barrel.rotation) * t.len;
    const m = out[n++];
    m.x = c.x + lx * cos - ly * sin + Math.cos(a) * travel;
    m.y = c.y + lx * sin + ly * cos + Math.sin(a) * travel;
    m.r = def.splash!.radius;
    m.firing = firing;
  }
  return n;
}
