/**
 * Stage 1A adapters: how today's callers hand a ship to stepShip without copying it. Every caller (the server's
 * pilot and pilotless steps, SimLod, replicaStep, ShipClient.predict) keeps its own scratch SimShipView, loads it
 * from what it holds (an ECS body, a ShipState, a replica's body), steps it in place (`out === prev`) and reads the
 * result back. The views point at the caller's arrays (guns) and body; nothing is copied, nothing kept.
 *
 * Also the aim grid both ends put an angle on (aimQ) and a pilot's held keys as a SimInput (pilotInput), the same
 * on the server (Input component) and the client (the input message): Stage 3 swaps them for Stage 1D's sources.
 */

import type { FlightBody } from '../ships/flight.js';
import type { Charge } from '../ships/energy.js';
import type { ShipDerived } from '../ships/rebuild.js';
import type { ShipState } from '../ships/state.js';
import type { FlightInputSource } from '../ships/flightInputs.js';
import { buildFlightInputs, newFlightControls } from '../ships/flightInputs.js';
import { controlBits, ReplicaMode } from '../ships/replica.js';
import { FULL_CHARGE } from '../ships/energy.js';
import { dequantizeCursorAngle } from '../network/cursorState.js';
import { newGunState, type GunState, type SimShipState, type SimStructure } from './state.js';
import { simAimQ, type SimInput } from './input.js';

/** An angle onto the aim grid (input.ts simAimQ, canonical at the top step; the name callers had in Stage 1A) */
export function aimQ(angle: number): number {
  return simAimQ(angle);
}
// (a function, not `= simAimQ`: this file is in replica.ts's import cycle, so nothing here reads an import at load)

/** An angle as every ship steers on it: onto the grid and back (input.ts simAim) */
export function gridAim(angle: number): number {
  return Math.fround(dequantizeCursorAngle(aimQ(angle)));
}

/** A structure for the step, one per (ship, derived): a rebuild's new derived gets a new one, its version bumped */
const STRUCTURES = new WeakMap<object, SimStructure>();
export function simStructureOf(derived: ShipDerived, ship?: Readonly<ShipState>): SimStructure {
  const key: object = ship ?? derived;
  const had = STRUCTURES.get(key);
  if (had && had.derived === derived) return had;
  const s: SimStructure = { derived, ship, version: had ? had.version + 1 : 0 };
  STRUCTURES.set(key, s);
  return s;
}

/** A reusable SimShipState over a caller's own objects */
export class SimShipView {
  readonly state: SimShipState;
  private readonly noGuns = newGunState(0);
  constructor() {
    this.state = {
      id: 0, mode: ReplicaMode.Player, body: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angVel: 0 }, ctl: { bits: 0, q: 0 },
      charge: FULL_CHARGE, accounted: false, jumpPrime: 0, hazard: { empUntil: 0, slowUntil: 0, numb: 1 },
      guns: newGunState(0), structure: { derived: undefined as unknown as ShipDerived, version: 0 },
    };
  }

  /** Point the view at a ship: `body` is stepped in place; `ship` (when there is one) lends its gun arrays */
  load(id: number, mode: ReplicaMode, body: FlightBody, derived: ShipDerived, ship: ShipState | undefined, charge: Charge, accounted: boolean, jumpPrime = 0): SimShipState {
    const s = this.state;
    s.id = id; s.mode = mode; s.body = body; s.charge = charge; s.accounted = accounted; s.jumpPrime = jumpPrime;
    s.hazard.empUntil = 0; s.hazard.slowUntil = 0; s.hazard.numb = 1;
    s.structure = simStructureOf(derived, ship);
    s.guns = ship ? gunsOf(ship, s.guns === this.noGuns ? newGunState(0) : s.guns) : this.noGuns;
    return s;
  }
}

/** A ShipState's gun state as a GunState, by reference (its arrays, its scalars copied in) */
function gunsOf(ship: ShipState, out: GunState): GunState {
  out.cooldown = ship.cooldown; out.rounds = ship.rounds; out.reload = ship.reload; out.charge = ship.charge;
  out.spin = ship.spin; out.aim = ship.aim; out.triggerHeld = ship.triggerHeld; out.clickAt = ship.clickAt; out.clickMasks = ship.clickMasks; out.trig = ship.trig;
  out.minePaid = ship.minePaid; out.mineUntil = ship.mineUntil; out.mineShare = ship.mineShare; out.tow = ship.tow; out.heldDist = ship.heldDist;
  return out;
}

const PILOT_CTL = newFlightControls();

/**
 * A pilot's held keys as the step's input (today's logic, server Input component and client input message alike):
 * the keys' control bits (jump included: the step drops it under EMP), the aim on the grid, the cursor distance as
 * the jump's. Guns aren't in it yet (Stage 1B).
 */
export function pilotInput(src: FlightInputSource, out: SimInput = { bits: 0, q: 0, jumpDist: 0, fire: false, fireAlt: false, aimDist: 0 }): SimInput {
  out.bits = controlBits(buildFlightInputs(src, false, PILOT_CTL));
  out.q = aimQ(src.targetAngle);
  out.jumpDist = src.cursorDist ?? 0;
  out.impulse = undefined;
  return out;
}
