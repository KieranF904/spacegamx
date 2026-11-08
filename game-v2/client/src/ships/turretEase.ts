/**
 * A drawn turret's angle eased towards the simulated one (visual only: ShipRenderer.drawTurrets). The simulation
 * (common ships/guns.ts stepGuns) points an idle turret straight at the aim and fires every shell from the exact angle;
 * an exact aim arriving (another pilot's distance at trigger-down, after only rough idle updates: server GunNet) or
 * the cursor flicked would otherwise jump the drawn barrel. So the barrel chases the simulated angle with a short time
 * constant (EASE_FRAMES), and on a shot it's pulled within FIRE_GAP of it at once: a shell never visibly leaves a barrel
 * pointing elsewhere by more than that (the muzzle flash and the shell come from the exact barrel: WeaponFx).
 */
import { wrapPi } from '@space-game/common';

/** Time constant of the chase, in 60 Hz frames (~50 ms: most of a gap gone in 3 frames, nearly all in 10) */
export const EASE_FRAMES = 3;
/** On a shot, the drawn barrel is pulled at once to within this of the angle it fired at (radians: 3°) */
export const FIRE_GAP = 3 * (Math.PI / 180);

/** The gap from drawn to target (a full-circle turret's the short way round; a limited one's within its window) */
function gapOf(drawn: number, target: number, full: boolean): number {
  return full ? wrapPi(target - drawn) : target - drawn;
}

/** One frame's ease (`frames` of 60 Hz: dt × 60) from `drawn` towards `target`. NaN drawn (first sight): the target */
export function easeTurret(drawn: number, target: number, frames: number, full: boolean): number {
  if (!Number.isFinite(drawn)) return target;
  const gap = gapOf(drawn, target, full);
  if (Math.abs(gap) < 1e-4) return target;
  const k = 1 - Math.exp(-Math.max(0, frames) / EASE_FRAMES);
  const out = drawn + gap * k;
  return full ? wrapPi(out) : out;
}

/** A shot fired: the drawn barrel pulled to within FIRE_GAP of the angle it fired at (unchanged if already within) */
export function fireCatch(drawn: number, target: number, full: boolean): number {
  if (!Number.isFinite(drawn)) return target;
  const gap = gapOf(drawn, target, full);
  if (Math.abs(gap) <= FIRE_GAP) return drawn;
  const out = target - Math.sign(gap) * FIRE_GAP;
  return full ? wrapPi(out) : out;
}
