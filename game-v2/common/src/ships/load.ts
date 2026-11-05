/**
 * Cargo has mass. What's in the hold (never what's in station storage) is
 * carried on top of the ship's own mass, so a full hold pushes, turns and
 * stops slower: thrust is shared over mass + cargo (flight.ts accelAlong),
 * and turning over an inertia that grows by half as much (the holds sit near
 * the middle: CARGO_TURN_SHARE).
 *
 * It's relative to the ship's own mass, so the same load hurts a light ship
 * far more than a big hauler; and since what's left is a share of the ship's
 * thrust, big engines keep a laden ship lively. Item masses are per unit
 * (econ/items.ts ItemCatalog.mass: items.json `mass`, else by category).
 *
 * The cargo mass rides on the flight body (FlightBody.cargo, rounded to
 * CARGO_PRECISION), so the server, the pilot's prediction and every replica
 * fly the same load.
 */

import { dpow } from '../math/detTrig.js';

/** Cargo's share in the ship's turning inertia, against its share in its mass */
export const CARGO_TURN_SHARE = 0.5;

/** Decimal places the cargo mass is carried at */
export const CARGO_PRECISION = 2;

export function quantizeCargo(m: number): number {
  const k = dpow(10, CARGO_PRECISION);
  return Math.max(0, Math.round(m * k) / k);
}

/** The ship's own mass flight divides by (as built: flight.ts) */
function ownMass(d: { mass: number; fullMass?: number }): number {
  return Math.max(d.mass, d.fullMass ?? d.mass);
}

/** Share of its acceleration a ship keeps carrying `cargo` (1: empty) */
export function cargoThrust(d: { mass: number; fullMass?: number }, cargo: number): number {
  const m = ownMass(d);
  return m > 0 && cargo > 0 ? m / (m + cargo) : 1;
}

/** Share of its turning a ship keeps carrying `cargo` */
export function cargoTurn(d: { mass: number; fullMass?: number }, cargo: number): number {
  const m = ownMass(d);
  return m > 0 && cargo > 0 ? m / (m + CARGO_TURN_SHARE * cargo) : 1;
}

/** What a load does, for readouts: mass, and the thrust and turning lost (0..1) */
export function cargoEffect(d: { mass: number; fullMass?: number }, cargo: number): { mass: number; thrustLoss: number; turnLoss: number } {
  return { mass: cargo, thrustLoss: 1 - cargoThrust(d, cargo), turnLoss: 1 - cargoTurn(d, cargo) };
}
