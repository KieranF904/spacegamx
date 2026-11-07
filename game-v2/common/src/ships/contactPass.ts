/**
 * Which pairs of ships a tick's contact pass takes, and in what order: the server's pass (bridge/flight.ts
 * resolveContacts) and a client's tick layer (CAPS.CONTACTS: client ships/causes/ContactWorld.ts) find them with this
 * one function, so a client holding both ships of a pair finds every pair the server took, in the server's order.
 *
 * A pair is a candidate when its bounding circles, padded by CONTACT_MARGIN, meet on the x sweep and in y, from the
 * bodies as they were before the pass (nothing a pair does changes which pairs are taken). Pairs go in order of the
 * lower id, then the higher (the list is sorted by id; a pair's first body is its lower id). Each candidate is then
 * resolved in that order (contact.ts contactPair) from the bodies as the pairs before it left them.
 */
import { jumpPhase, jumpTuning } from './flight.js';
import type { ShipTuning } from './tuning.js';

/** Bounding circles are padded by this much for the pushes earlier pairs in the pass make */
export const CONTACT_MARGIN = 256;

/**
 * A body in the pass: its id, its centre before the pass, and its reach (ShipDerived.radius); `link`, the ship it is
 * clamped to this tick (Docking Clamps, sim/clampPair.ts): the two fly as one body and never touch each other
 */
export interface ContactEntry { id: number; x: number; y: number; r: number; link?: number }

/**
 * The pass's candidate pairs among `list` (sorted by id, one system), as index pairs [i, j] (i < j) flat in `out`, in
 * the pass's order. Swept along x by left edge: everything after a body whose left edge is past this one's padded right
 * edge is further still.
 */
export function contactCandidates(list: readonly ContactEntry[], out: number[] = []): number[] {
  out.length = 0;
  const n = list.length;
  if (n < 2) return out;
  const order: number[] = [];
  const lefts: number[] = [];
  for (let i = 0; i < n; i++) { order.push(i); lefts.push(list[i].x - list[i].r); }
  order.sort((p, q) => lefts[p] - lefts[q]);
  const keys: number[] = [];
  for (let a = 0; a < n; a++) {
    const i = order[a], ei = list[i];
    const ri = ei.r + CONTACT_MARGIN;
    const right = ei.x + ri, yi = ei.y;
    for (let b = a + 1; b < n; b++) {
      const j = order[b];
      if (lefts[j] > right) break;
      if (Math.abs(list[j].y - yi) > ri + list[j].r) continue;
      if (ei.link !== undefined && ei.link === list[j].id) continue;
      keys.push(i < j ? i * n + j : j * n + i);
    }
  }
  keys.sort((p, q) => p - q);
  for (const k of keys) { const i = Math.floor(k / n); out.push(i, k - i * n); }
  return out;
}

/** Is a ship mid-jump (its burn: the pass leaves it out, as it does shots) by its body's jump counter? */
export function contactJumping(jump: number | undefined, tuning: ShipTuning): boolean {
  return jumpPhase(jump ?? 0, jumpTuning(tuning)).phase === 'burn';
}

/**
 * A pair's sparks: drawn when it closed faster than `fxMinSpeed`, at most once per pair every `fxCooldownTicks` (the
 * server's notifyContact; a client deriving the pair draws its own, ContactWorld)
 */
export function contactFxDue(closing: number, last: number | undefined, tick: number, tuning: ShipTuning): boolean {
  const ct = tuning.collision;
  return closing > (ct?.fxMinSpeed ?? 0.6) && tick - (last ?? -1e9) >= (ct?.fxCooldownTicks ?? 8);
}
