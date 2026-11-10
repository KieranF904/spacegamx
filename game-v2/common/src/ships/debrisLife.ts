/**
 * A piece of debris's life after its spawn, worked out alike on the server and on a client running the piece itself
 * (CAPS.DEBRIS, docs/areas/networking/crowd-structs-cargo-debris.md "Debris"): when each part crumbles away, and what a crumble leaves. Nothing
 * else changes a piece's structure without the server saying so (a shot, a blast, a tow: the piece is told from then).
 *
 *   decay     each part's crumble tick, fixed at its spawn: seeded by the piece and its spawn tick (debrisDecay), or
 *             its parent's for those parts (a piece breaking up further), or a shed's (shedCrumble, ships/debris.ts)
 *   crumble   on its tick a part goes (step 1, before the drift); the piece rebuilds at the tick's rebuild point: what
 *             no longer joins breaks off as pieces of its own, and what's left is recentred where it was
 */
import { hashInts, seededRng } from './rng.js';
import { damagePart, splitRebuild, type ShipState } from './state.js';
import type { Catalog } from './catalog.js';
import type { ShipTuning } from './tuning.js';

/** When each of a new piece's `n` parts crumbles away: seeded by the piece and its spawn tick, from its first step on */
export function debrisDecay(id: number, born: number, n: number, tuning: ShipTuning): number[] {
  const life = tuning.debris.decayTicks ?? 1200;
  const rng = seededRng(hashInts(id, born, 77));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(born + 1 + Math.round(life * (0.25 + rng())));
  return out;
}

/** The parts of a piece that crumble on `tick` (still there, and their time has come) */
export function crumblingParts(ship: ShipState, decay: readonly number[], tick: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < decay.length; i++) if (tick >= decay[i] && ship.hp[i] > 0 && !ship.detached[i]) out.push(i);
  return out;
}

/**
 * Those parts crumbled and the piece rebuilt, as the server's rebuild point does it (ShipBridge rebuildNow): the
 * groups that broke off (their parts are detached), in the order their pieces spawn. Its structure is the new one
 */
export function crumbleRebuild(ship: ShipState, parts: readonly number[], catalog: Catalog, tuning: ShipTuning): number[][] {
  for (const i of parts) damagePart(ship, i, Infinity, tuning);
  return splitRebuild(ship, catalog, tuning);
}
