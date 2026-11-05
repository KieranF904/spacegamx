/**
 * Shared shot behaviours and weapon statuses (docs/design/rework-2026-11.md, the shot-behaviours unit): generic
 * options a weapon model switches on in its tuning (WeaponTuning `endAtAim`, `walk`, `guided`, `mark`, `slow`;
 * scripts/econ/models.mjs SHOT), each a weapon role of the `weaponry` feature (index.ts):
 *
 *   endAtAim  the shell bursts (splash, emp) or splits (split) at the aim distance, or earlier on its fuse or on impact:
 *             the mortar's land-at-cursor maths (launch.ts aimReach, lifeToReach)
 *   walk      a salvo whose shells land at listed fractions of the aim distance, `gap` ticks apart
 *   guided    while its gun's trigger is held the shell steers toward the cursor (the server's aim each tick); let go,
 *             it flies straight
 *   mark      a beam: what it lights takes MARK_TAKEN × damage from every source while lit and `mark.ticks` after
 *   slow      a beam: what it lights flies slowed (flight.ts SLOW_CONTROL) while lit and `slow.ticks` after
 *
 * The shells of endAtAim, walk and guided guns are sent as they fly (launch.ts firesStraight), their projectile row
 * carrying the tick they end on (data[9], 0 none). The statuses reach clients as bits in the status row and as ticks
 * left in the pilot's own row (features.wire.json); slowed also as the replica control bit CTL.slowed.
 *
 * Pure: no imported value is used at module scope.
 */

import type { WeaponTuning } from '../../tuning.js';
import { datan2, dcos, dsin } from '../../../math/detTrig.js';

/** Weapon role ids */
export const ROLE_END_AT_AIM = 'endAtAim';
export const ROLE_WALK = 'walk';
export const ROLE_GUIDED = 'guided';
export const ROLE_MARK = 'mark';
export const ROLE_SLOW = 'slow';

/** A marked ship takes this × the damage of every hit (rework 2026-11: +20%) */
export const MARK_TAKEN = 1.2;

/** The status-row bits (features.wire.json status "statuses"): seen by every pilot */
export const STATUS_MARKED = 1;
export const STATUS_SLOWED = 2;

export const endsAtAimRole = (d: WeaponTuning | undefined): boolean => !!d && d.type !== 'beam' && !!(d.endAtAim || d.walk || d.hold);
export const walksRole = (d: WeaponTuning | undefined): boolean => !!d && d.type !== 'beam' && !!d.walk && d.walk.at.length > 0;
export const guidedRole = (d: WeaponTuning | undefined): boolean => !!d && d.type !== 'beam' && !!d.guided;
export const marksRole = (d: WeaponTuning | undefined): boolean => !!d && d.type === 'beam' && !!d.mark;
export const slowsRole = (d: WeaponTuning | undefined): boolean => !!d && d.type === 'beam' && !!d.slow;

/** The status bits of a ship marked / slowed */
export function statusBits(marked: boolean, slowed: boolean): number {
  return (marked ? STATUS_MARKED : 0) | (slowed ? STATUS_SLOWED : 0);
}

/**
 * One tick of a guided shell's steering: its heading turned toward (tx, ty) by at most `turn` rad, written into `out`
 * as a unit vector (allocation-free). Server only today: a guided shell is sent as it flies.
 */
export function steerToward(x: number, y: number, vx: number, vy: number, tx: number, ty: number, turn: number, out: { x: number; y: number }): void {
  let a = datan2(vy, vx);
  let d = datan2(ty - y, tx - x) - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  a += Math.max(-turn, Math.min(turn, d));
  out.x = dcos(a);
  out.y = dsin(a);
}
