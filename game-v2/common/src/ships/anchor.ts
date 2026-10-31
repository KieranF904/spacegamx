/**
 * The Stabiliser Anchor (a part: functions `anchor`): the pilot braces the
 * ship, and while it's braced it gives up moving for steadiness.
 *
 *   braced    no thrust (the ship holds where it is: strong damping), turning
 *             at `turn` of its usual; pulls and knockback don't move it
 *             (`pull`; collisions push it `contact` as far); guns reach
 *             `range` further and scatter `spread` less; shields recharge
 *             `shieldRegen` faster and a hit takes `shieldSoak` less of them.
 *   spooling  going into the brace (braceTicks) and out of it (releaseTicks):
 *             no thrust and none of the benefits. The vulnerable window.
 *
 * Its whole state is one counter on the body (`brace`), stepped from the
 * pilot's latched brace control like the jump drive's, so it rides keyframes
 * and prediction replays it exactly:
 *
 *   0                                   free
 *   1 .. braceTicks-1                   bracing (counts down again if the brace is let go)
 *   braceTicks                          braced (held while the brace is wanted)
 *   braceTicks+1 .. +releaseTicks-1     releasing (committed: runs out, then 0)
 *
 * It needs a powered anchor (ShipDerived.anchor, its best one's satisfaction,
 * at least MIN_ANCHOR_POWER). It draws as a steady consumer (`demand`), like a
 * shield or a scanner, so it fits whatever the power model is.
 */

import type { ShipTuning, WeaponTuning } from './tuning.js';
import type { WeaponMods } from './types.js';

export interface AnchorTuning {
  /** Ticks to brace, and to let go */
  braceTicks: number;
  releaseTicks: number;
  /** Velocity kept per tick (× friction) while braced, and while spooling either way */
  hold: number;
  spoolHold: number;
  /** Turning acceleration × this while the anchor is out (braced or spooling) */
  turn: number;
  /** Braced: guns' range × (1 + range), their scatter × (1 - spread) */
  range: number;
  spread: number;
  /** Braced: shields recharge × (1 + shieldRegen); a hit takes ÷ (1 + shieldSoak) of the shield */
  shieldRegen: number;
  shieldSoak: number;
  /** Braced: share of a pull or a knockback the ship still feels, and of a collision's push */
  pull: number;
  contact: number;
}

export const DEFAULT_ANCHOR: AnchorTuning = {
  braceTicks: 45, releaseTicks: 60,
  hold: 0.8, spoolHold: 0.93, turn: 0.5,
  range: 0.25, spread: 0.5,
  shieldRegen: 0.6, shieldSoak: 0.2,
  pull: 0, contact: 0.2,
};

/** The anchor needs at least this much of its power to brace */
export const MIN_ANCHOR_POWER = 0.5;

const cache = new WeakMap<object, AnchorTuning>();

/** A tuning's anchor settings (tuning.json `anchor` over the defaults) */
export function anchorTuning(t: ShipTuning): AnchorTuning {
  const over = (t as { anchor?: Partial<AnchorTuning> }).anchor;
  if (!over) return DEFAULT_ANCHOR;
  let a = cache.get(over);
  if (!a) cache.set(over, (a = { ...DEFAULT_ANCHOR, ...over }));
  return a;
}

export type BracePhase = 'free' | 'bracing' | 'braced' | 'releasing';

/** Phase of a brace counter, and progress through it in [0, 1] (braced and free: 1) */
export function bracePhase(c: number | undefined, t: AnchorTuning = DEFAULT_ANCHOR): { phase: BracePhase; progress: number } {
  const v = c ?? 0;
  if (v <= 0) return { phase: 'free', progress: 1 };
  if (v < t.braceTicks) return { phase: 'bracing', progress: v / t.braceTicks };
  if (v === t.braceTicks) return { phase: 'braced', progress: 1 };
  return { phase: 'releasing', progress: (v - t.braceTicks) / t.releaseTicks };
}

/** Fully braced (the benefits apply) */
export function isBraced(c: number | undefined, t: AnchorTuning = DEFAULT_ANCHOR): boolean {
  return (c ?? 0) === t.braceTicks;
}

/** How far out the anchor is, 0 (stowed) .. 1 (braced): for the look */
export function braceAmount(c: number | undefined, t: AnchorTuning = DEFAULT_ANCHOR): number {
  const { phase, progress } = bracePhase(c, t);
  return phase === 'free' ? 0 : phase === 'bracing' ? progress : phase === 'braced' ? 1 : 1 - progress;
}

/** Can this ship brace (a powered anchor) */
export function canBrace(d: { anchor?: number }): boolean {
  return (d.anchor ?? 0) >= MIN_ANCHOR_POWER;
}

/**
 * Advance the counter one tick. `want`: the pilot's brace control; `able`:
 * the ship has a working anchor (lose it and a brace under way collapses; a
 * held one lets go).
 */
export function stepBrace(c: number, want: boolean, able: boolean, t: AnchorTuning): number {
  if (c <= 0) return want && able ? 1 : 0;
  if (c < t.braceTicks) return !able ? 0 : want ? c + 1 : c - 1;
  if (c === t.braceTicks) return want && able ? c : c + 1;
  return c + 1 >= t.braceTicks + t.releaseTicks ? 0 : c + 1;
}

const bracedMods = new WeakMap<AnchorTuning, WeaponMods>();

/** What bracing does to a gun, as mods (launch.ts gunDef): the same object each time */
export function bracedWeaponMods(t: AnchorTuning = DEFAULT_ANCHOR): WeaponMods {
  let m = bracedMods.get(t);
  // (As `set`, not `mul`: a gun whose tuning leaves its life or scatter to the defaults is braced too; launch.ts launchShot reads them)
  if (!m) bracedMods.set(t, (m = { set: { reach: 1 + t.range, steady: 1 - t.spread } }));
  return m;
}

/** A gun's reach in world units (shells: speed × life; beams: range), for readouts */
export function gunReach(def: WeaponTuning): number {
  return (def.type === 'beam' ? def.range ?? 800 : (def.speed ?? 48) * (def.life ?? 150)) * (def.reach ?? 1);
}
