/**
 * Shared modular-ship physics step: the server simulation and client
 * prediction both call this, so their results agree bit for bit.
 *
 * After each step the body is rounded to exactly the precision snapshots
 * carry (SHIP_PRECISION). The server's state then equals what it sends, so a
 * client reconciling from a snapshot and replaying its inputs lands on the
 * same numbers as the server.
 */

import type { Charge } from './energy.js';
import { FRICTION, BOOST_FACTOR, WORLD_SIZE } from '../constants.js';
import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import { stepFlight, FlightBody, FlightControls, GravityWell, type FlightConstants } from './flight.js';
import { collideTerrain, terrainRadius, type Terrain } from '../terrain.js';

export const SHIP_FLIGHT_CONSTANTS = { friction: FRICTION, boostFactor: BOOST_FACTOR, worldSize: WORLD_SIZE };

/** Decimal places snapshots carry for ship bodies */
export const SHIP_PRECISION = { pos: 2, vel: 4, angle: 5, angVel: 6, fuel: 3 } as const;

const round = (v: number, places: number) => {
  const k = 10 ** places;
  const r = Math.round(v * k) / k;
  return r === 0 ? 0 : r; // no -0
};

export function quantizeShipValue(kind: keyof typeof SHIP_PRECISION, v: number): number {
  return round(v, SHIP_PRECISION[kind]);
}

export function quantizeShipBody(b: FlightBody): void {
  b.x = round(b.x, SHIP_PRECISION.pos);
  b.y = round(b.y, SHIP_PRECISION.pos);
  b.vx = round(b.vx, SHIP_PRECISION.vel);
  b.vy = round(b.vy, SHIP_PRECISION.vel);
  b.angle = round(b.angle, SHIP_PRECISION.angle);
  b.angVel = round(b.angVel, SHIP_PRECISION.angVel);
}

export function stepShipPhysics(
  body: FlightBody,
  input: FlightControls,
  derived: ShipDerived,
  tuning: ShipTuning,
  /** The charge, whether it's accounted (drainRate 0: not), and what the guns and mining lasers draw this tick per feed group (energy.ts gunLoad) */
  boost: { charge: Charge; drainRate: number; load?: ArrayLike<number> },
  gravity: GravityWell | null = null,
  jumpBoost = 1,
  hazard?: FlightConstants['hazard'],
  terrain?: Terrain | null,
): { charge: Charge; isBoosting: boolean; power: number } {
  const k = gravity || jumpBoost !== 1 || hazard ? { ...SHIP_FLIGHT_CONSTANTS, gravity, jumpBoost, hazard } : SHIP_FLIGHT_CONSTANTS;
  const res = stepFlight(body, input, derived, tuning, boost, k);
  // A surface's rock: pushed out of it, alike on every side (terrain.ts)
  if (terrain) collideTerrain(body, terrainRadius(derived.radius), terrain);
  quantizeShipBody(body);
  // (The charge comes back rounded alike on server and client: energy.ts)
  return { charge: res.charge, isBoosting: res.isBoosting, power: res.power };
}
