/**
 * Where a pilot's jump lands, worked out the way stepFlight flies it, so the
 * overlay's reticle is where the ship stops (the jump drive: flight.ts).
 *
 * While the drive spools the ship slides on: no thrust, its velocity damped by
 * friction × chargeDamping, pulled by a gravity well or a gravity hazard. Then
 * the burn carries it the aimed distance (within its reach: jumpReachAt) along
 * the aim, and ends at exitSpeed (0: dead still).
 */

import { applyGravity, jumpChargeNeed, jumpCoast, jumpDistance, jumpGoFor, jumpScaleFor, type FlightConstants, type JumpTuning } from './flight.js';
import { dhypot, dsincos } from '../math/detTrig.js';

const SC: [number, number] = [0, 0];

/** How far a jump asked for `dist` goes (0: as far as it reaches), the way the burn fixes it */
export function jumpGo(dist: number, reach: number, t: JumpTuning): number {
  return jumpGoFor(Math.max(0, dist), reach, t);
}

/**
 * Where the ship comes to rest, from where it is now (`body`, its drive's counter `jump` as stepped this tick) for
 * the aim `bearing` (radians) and `dist` (0: full reach). The spool's slide is stepped tick by tick as stepFlight
 * steps it; a charge waiting to be aimed (JUMP_ALIGN) slides a little longer than this, by then barely moving.
 */
export function jumpLanding(
  body: { x: number; y: number; vx: number; vy: number }, jump: number, bearing: number, dist: number, reach: number,
  t: JumpTuning, k: Pick<FlightConstants, 'friction' | 'gravity' | 'hazard'>, out: [number, number] = [0, 0],
): [number, number] {
  const p = { x: body.x, y: body.y, vx: body.vx, vy: body.vy };
  const damp = k.friction * t.chargeDamping;
  const drift = k.hazard?.driftAccel ?? 0;
  // (The charge left: the same for every jump, jumpChargeNeed)
  const go = jumpGo(dist, reach, t);
  for (let n = jumpChargeNeed(go, t) - 1 - Math.max(0, jump); n > 0; n--) {
    applyGravity(p, k.gravity);
    if (drift) {
      const r = dhypot(p.x, p.y);
      if (r > 1) { p.vx -= (p.x / r) * drift; p.vy -= (p.y / r) * drift; }
    }
    p.vx *= damp; p.vy *= damp;
    p.x += p.vx; p.y += p.vy;
  }
  const along = jumpDistance(t, jumpScaleFor(go, t, k.friction)) + (t.exitSpeed > 0 ? jumpCoast(t, k.friction) : 0);
  dsincos(bearing, SC);
  out[0] = p.x + SC[1] * along;
  out[1] = p.y + SC[0] * along;
  return out;
}
