/**
 * Deterministic randomness for ship logic. Never use Math.random in ships/.
 */

import { hashInts } from '../math/rng.js';

// (The generators live in math/rng.ts, shared by everything that draws deterministically)
export { hashInts, seededRng } from '../math/rng.js';

/** Shot seed: hash(shipId, weaponUid, tick). */
export function shotSeed(shipId: number, weaponUid: number, tick: number): number {
  return hashInts(shipId, weaponUid, tick);
}
