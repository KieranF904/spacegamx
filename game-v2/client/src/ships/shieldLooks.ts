/**
 * What a ship's shield bubble looks like (rework 2026-11 section 5): the look of whichever shield model it carries the
 * most cells of. The bubble is one sprite pool entry (DamageFx.drawShields); this is its colours and extras.
 *
 *   deflector  blue, rim ripples (the old look)
 *   flicker    thin, pale and shimmering
 *   bulwark    thick, amber over blue, with a slowly turning honeycomb
 *   flash      pale white; blooms white when it re-forms
 */

import type { ShipState } from '@space-game/common';

export interface ShieldLook {
  /** The bubble's tint, and when it's just been hit */
  tint: number;
  hit: number;
  /** Alpha: a floor, plus this × the shield level */
  base: number;
  fill: number;
  /** Shimmer depth 0..1 (the thin screen blinks) */
  shimmer: number;
  /** A second bubble inside, in this colour */
  inner?: number;
  /** A honeycomb over it, in this colour */
  hex?: number;
  /** Blooms white when it comes back */
  reform: boolean;
}

export const DEFLECTOR: ShieldLook = { tint: 0x7fd6fa, hit: 0xc8f4ff, base: 0.12, fill: 0.26, shimmer: 0, reform: false };

export const SHIELD_LOOKS: Record<string, ShieldLook> = {
  shield_deflector: DEFLECTOR,
  shield_flicker_screen: { tint: 0xa8f0ff, hit: 0xf0ffff, base: 0.05, fill: 0.14, shimmer: 0.6, reform: false },
  shield_bulwark_projector: { tint: 0xffb454, hit: 0xffe2b0, base: 0.2, fill: 0.34, shimmer: 0, inner: 0x5a9bff, hex: 0xffd9a0, reform: false },
  shield_flash_screen: { tint: 0xeaf4ff, hit: 0xffffff, base: 0.12, fill: 0.26, shimmer: 0.08, reform: true },
};

const cache = new WeakMap<ShipState, { rebuilds: number; look: ShieldLook }>();

/** The look of a ship's shield: its most numerous shield model, else the old blue */
export function shieldLookOf(ship: ShipState): ShieldLook {
  const hit = cache.get(ship);
  if (hit && hit.rebuilds === ship.rebuilds) return hit.look;
  let best = DEFLECTOR, n = 0;
  for (const id in SHIELD_LOOKS) {
    let c = 0;
    for (let i = 0; i < ship.blueprint.parts.length; i++) if (ship.blueprint.parts[i].fn === id && ship.derived.alive[i]) c++;
    if (c > n) { n = c; best = SHIELD_LOOKS[id]; }
  }
  cache.set(ship, { rebuilds: ship.rebuilds, look: best });
  return best;
}
