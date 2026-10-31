/**
 * The pilot's controls as one flight step reads them (FlightControls), built in one place from whatever carries the
 * held keys: the server's Input component (read into a FlightInputSource by ShipBridge.stepMovement) or, later, the
 * client's input message for prediction. Shared so the two sides normalise every field alike:
 *   - a jump only starts when the drive isn't EMPed (jump && !emp)
 *   - jumpDist is the cursor distance as given (undefined or 0: as far as the drive goes)
 *   - dodge is a held flag (false when absent)
 *
 * Per-tick use: pass `out` (one scratch object, reused) so nothing is allocated; stepShipPhysics never keeps it.
 * The same built object also feeds controlBits (replica.ts), which reads only the flags.
 */

import type { FlightControls } from './flight.js';

/** The held keys, structurally (the server's Input fields read as booleans, or the client's input message) */
export interface FlightInputSource {
  forward: boolean; backward: boolean; left: boolean; right: boolean;
  boost: boolean;
  targetAngle: number;
  helm?: boolean;
  strafeLeft?: boolean;
  strafeRight?: boolean;
  jump?: boolean;
  /** Ship-to-cursor distance (world units): how far a jump goes */
  cursorDist?: number;
  dodge?: boolean;
}

/** A fresh FlightControls to reuse as `out` */
export function newFlightControls(): FlightControls {
  return {
    forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0,
    helm: false, strafeLeft: false, strafeRight: false, jump: false, jumpDist: 0, dodge: false,
  };
}

/** Fill `out` (or a new object) with the controls a flight step reads, from the held keys and whether the drive is EMPed */
export function buildFlightInputs(src: FlightInputSource, emp: boolean, out: FlightControls = newFlightControls()): FlightControls {
  out.forward = src.forward;
  out.backward = src.backward;
  out.left = src.left;
  out.right = src.right;
  out.boost = src.boost;
  out.targetAngle = src.targetAngle;
  out.helm = !!src.helm;
  out.strafeLeft = !!src.strafeLeft;
  out.strafeRight = !!src.strafeRight;
  out.jump = !!src.jump && !emp;
  out.jumpDist = src.cursorDist;
  out.dodge = !!src.dodge;
  return out;
}
