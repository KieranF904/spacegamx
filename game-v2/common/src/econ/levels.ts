/**
 * Pilot levels, 1 to 100: a milestone clock. Total XP to reach level L is
 * 120 × (L^2.2 − 1), so levels come often early and stretch out smoothly,
 * never more than ~1.3× the step before past the first few. A save's level is
 * always recomputed from its XP.
 *
 *   level   5     10     15     30     45      100
 *   XP      4.0k  18.9k  46.3k  213k   520k    3.01M
 */

import { dpow } from '../math/detTrig.js';


export const LEVEL_CAP = 100;
const XP_BASE = 120, XP_EXP = 2.2;

/** Total XP to reach a level */
export function xpToReach(level: number): number {
  return level <= 1 ? 0 : Math.round(XP_BASE * (dpow(Math.min(level, LEVEL_CAP), XP_EXP) - 1));
}

/** The level a total of XP makes a pilot */
export function levelAt(xp: number): number {
  let level = 1;
  while (level < LEVEL_CAP && xp >= xpToReach(level + 1)) level++;
  return level;
}

/**
 * The level each grade opens at (nothing opens one earlier): Mk I from the start, then its
 * main-line structure material's (econ/market.ts MATERIAL_LEVEL: steel 5,
 * titanium 12, cobalt 22, neutronium 32)
 */
export const GRADE_LEVEL = [0, 1, 5, 12, 22, 32];
