/**
 * A den's vent floor (systems.json `den`, kind `vents`): a fixed cycle from the server tick, no dice. Vent
 * `order[k]` starts its tell k × `every` ticks into each cycle (`order.length` × `every` long), then burns for `burn`
 * ticks. Pure, so a client can draw the same cycle the server burns by.
 */

import type { DenVentsData } from '../data/schemas.js';

export type VentPhase = 'quiet' | 'tell' | 'burn';

/** A cycle's length (ticks) */
export const ventCycle = (v: Pick<DenVentsData, 'order' | 'every'>): number => v.order.length * v.every;

/** How far vent `i` is into its turn at `tick` (0 = its tell starts; -1: not one of the cycle's vents) */
export function ventAge(v: Pick<DenVentsData, 'order' | 'every'>, i: number, tick: number): number {
  const k = v.order.indexOf(i);
  if (k < 0) return -1;
  const n = ventCycle(v);
  return (((tick - k * v.every) % n) + n) % n;
}

/** What vent `i` is doing at `tick` */
export function ventPhase(v: Pick<DenVentsData, 'order' | 'every' | 'tell' | 'burn'>, i: number, tick: number): VentPhase {
  const age = ventAge(v, i, tick);
  if (age < 0) return 'quiet';
  return age < v.tell ? 'tell' : age < v.tell + v.burn ? 'burn' : 'quiet';
}
