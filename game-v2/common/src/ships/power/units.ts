/**
 * Energy units (docs/design/energy-routing-impl.md §1.2). All energy state is integer **eu**, 1/256 of an E, so the
 * server, the wire and the pilot's prediction hold the very same numbers. Budgets are converted once, at layout time.
 */

/** eu in one E */
export const EU = 256;
/** Ticks a second */
const TPS = 60;

/** E to eu (capacities, a shot's cost) */
export function toEu(e: number): number {
  return Math.round(e * EU);
}

/** eu to E (display only) */
export function fromEu(eu: number): number {
  return eu / EU;
}

/** A rate in E a second to eu a tick, rounded (generators, Gives/Takes, thruster burns and intakes, tools) */
export function perTick(eps: number): number {
  return Math.round((eps * EU) / TPS);
}

/**
 * A rate in E a second to eu a tick, rounded up: a weapon's intake. A shot is `intake × beat / 60` E, so rounding the
 * intake down would make a gun at full supply miss its beat by a tick (Pip: 85 × 15 = 1275 eu against a 1280 eu shot).
 * Rounded up, it always has its shot on the beat (D3), for at most 1 eu a tick more
 */
export function perTickUp(eps: number): number {
  return Math.ceil((eps * EU) / TPS - 1e-9);
}
