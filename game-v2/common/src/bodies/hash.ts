/**
 * A body's check (docs/design/decision-inputs.md 5): a mix of the boss's state as rounded at a tick's end and its body
 * state then. A client sums it over the bodies it runs at a snapshot's tick and sends the low byte up (BodyCheck);
 * the server works out the same sum for that snapshot and puts the client right when they differ.
 */

import type { FlightBody } from '../ships/flight.js';
import { SHIP_PRECISION } from '../ships/physics.js';
import { dpow } from '../math/detTrig.js';
import type { BodyState } from './decisions.js';

const q = (v: number, places: number) => Math.round(v * dpow(10, places));
const mix = (h: number, v: number) => Math.imul(h ^ (v | 0), 0x9e3779b1) ^ (Math.imul(h, 0x85ebca6b) >>> 13);

/** One body at a tick (32 bits) */
export function bodyHash(id: number, b: FlightBody, s: BodyState): number {
  let h = 0x6a09e667 ^ id;
  h = mix(h, q(b.x, SHIP_PRECISION.pos)); h = mix(h, q(b.y, SHIP_PRECISION.pos));
  h = mix(h, q(b.vx, SHIP_PRECISION.vel)); h = mix(h, q(b.vy, SHIP_PRECISION.vel));
  h = mix(h, q(b.angle, SHIP_PRECISION.angle)); h = mix(h, q(b.angVel, SHIP_PRECISION.angVel));
  h = mix(h, s.kind); h = mix(h, s.stage); h = mix(h, s.side); h = mix(h, s.target); h = mix(h, s.on ? 1 : 0);
  for (const v of s.want) h = mix(h, v);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  return (h ^ (h >>> 12)) >>> 0;
}

/** What a body check says: the low byte of the sum of every body's hash it covers */
export function bodyCheckByte(sum: number): number {
  return (sum >>> 0) & 0xff;
}
