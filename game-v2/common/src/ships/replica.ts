/**
 * Replicated ship motion. The server sends a ship's state once (a keyframe)
 * and then only the controls it flies with, as they change; every client runs
 * the same step on the same numbers and lands on the same state, tick for tick.
 *
 * The server runs this exact step too, on a shadow of each ship, and compares
 * it with the real thing every tick. Anything the controls don't explain (a
 * collision, a blast's shove, an EMP, running dry of boost, a rebuild) makes
 * them differ, and the next snapshot carries a fresh keyframe. So keyframes go
 * out only when a client would otherwise be wrong.
 */

import type { Terrain } from '../terrain.js';
import { FULL_CHARGE } from './energy.js';
import type { FlightBody, FlightControls, GravityWell } from './flight.js';
import { stepDrift, jumpTuning, inSolarRing, type FlightConstants } from './flight.js';
import { jumpFieldAt, fieldCooldown, fieldRangeBoost, type FieldEnv } from './jumpFields.js';
import { stepShipPhysics, quantizeShipBody, SHIP_FLIGHT_CONSTANTS } from './physics.js';
import { withEmp } from './hazards.js';
import { warmthStage, withNumb } from './warmth.js';

/** (What a numb drive flies with) */
const NUMB = warmthStage(1);
import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';

/** How a ship moves */
export enum ReplicaMode {
  /** A pilot's ship (charging fields speed up its jump drive: jumpFields.ts) */
  Player = 0,
  /** Flown by the AI or an autopilot */
  Pilotless = 1,
  /** Debris: drifts */
  Drift = 2,
  /** A wreck held in place: coasts and spins, no gravity */
  Anchored = 3,
  /** Berthed at a station: rides along with it (no physics) */
  Docked = 4,
}

/** Control bits */
export const CTL = {
  forward: 1, backward: 2, left: 4, right: 8, boost: 16, helm: 32, strafeLeft: 64, strafeRight: 128, jump: 256,
  /** EMP'd: the drive crippled (thrust and steering × EMP_CONTROL) */
  emp: 512,
  /** Nobody flying: hold the current heading */
  hold: 1024,
  /** Numb with cold: thrust and steering × the numb stage's (warmth.ts) */
  numb: 2048,
  /** Stabiliser Anchor: brace held (anchor.ts) */
  brace: 4096,
} as const;

export interface ReplicaControls {
  bits: number;
  targetAngle: number;
}

export function controlBits(c: Partial<FlightControls>): number {
  return (c.forward ? CTL.forward : 0) | (c.backward ? CTL.backward : 0) | (c.left ? CTL.left : 0) | (c.right ? CTL.right : 0)
    | (c.boost ? CTL.boost : 0) | (c.helm ? CTL.helm : 0) | (c.strafeLeft ? CTL.strafeLeft : 0) | (c.strafeRight ? CTL.strafeRight : 0)
    | (c.jump ? CTL.jump : 0) | (c.brace ? CTL.brace : 0);
}

export function flightControls(c: ReplicaControls, body: FlightBody): FlightControls {
  const b = c.bits;
  return {
    forward: (b & CTL.forward) !== 0, backward: (b & CTL.backward) !== 0, left: (b & CTL.left) !== 0, right: (b & CTL.right) !== 0,
    boost: (b & CTL.boost) !== 0, helm: (b & CTL.helm) !== 0, strafeLeft: (b & CTL.strafeLeft) !== 0, strafeRight: (b & CTL.strafeRight) !== 0,
    jump: (b & CTL.jump) !== 0,
    brace: (b & CTL.brace) !== 0,
    targetAngle: (b & CTL.hold) !== 0 ? body.angle : c.targetAngle,
    // Where a jump lands isn't replicated: the burn's start brings a keyframe
    jumpDist: 0,
  };
}

/** What a ship's flight depends on: two structures with the same signature fly identically */
export function flightSignature(d: ShipDerived): string {
  const t = d.thrusters.map((x) => `${x.force[0]},${x.force[1]}`).join(';');
  return `${d.mass}|${d.inertia}|${d.fullMass}|${d.fullInertia}|${d.drive}|${d.maneuverForce}|${d.maxTorque.cw}|${d.maxTorque.ccw}|${d.jumpRange}|${d.jumpCooldown}|${d.anchor ?? 0}|${t}`;
}

/** (The fields: the central body's charging ring and the stillstones) */
export interface ReplicaEnv extends FieldEnv {
  gravity: GravityWell | null;
  /** What hazards do to a piloted ship there (ships/hazards.ts hazardFlight): the same on every side */
  hazard?: (derived: ShipDerived, x: number, y: number) => FlightConstants['hazard'];
  /** The system's central body (its charging ring) */
  central: { type?: string; radius?: number } | null;
  /** A surface's rock (terrain.ts): ships are pushed out of it */
  terrain?: Terrain | null;
}

/**
 * One tick of a replicated ship, exactly as the server moves it when nothing
 * else interferes. Docked ships aren't stepped (they ride their station).
 * `tick` is the tick being stepped into (lodestones move with it).
 */
export function replicaStep(mode: ReplicaMode, body: FlightBody, c: ReplicaControls, derived: ShipDerived, tuning: ShipTuning, env: ReplicaEnv, tick = 0): void {
  const k = env.gravity ? { ...SHIP_FLIGHT_CONSTANTS, gravity: env.gravity } : SHIP_FLIGHT_CONSTANTS;
  switch (mode) {
    case ReplicaMode.Player: {
      const jt = jumpTuning(tuning);
      // (A stillstone's priming isn't replicated: a burn's start brings a keyframe anyway)
      const boost = fieldRangeBoost(inSolarRing(body.x, body.y, env.central, jt), 0, jt);
      const hazard = env.hazard?.(derived, body.x, body.y);
      const flown = c.bits & CTL.numb ? withNumb(hazard, NUMB) : hazard;
      stepShipPhysics(body, flightControls(c, body), derived, tuning, { charge: FULL_CHARGE, drainRate: 0 }, env.gravity, boost, c.bits & CTL.emp ? withEmp(flown) : flown, env.terrain);
      // A charging field (a star's ring, a stillstone's): the drive cools down faster
      body.jump = fieldCooldown(body.jump ?? 0, derived.jumpCooldown || jt.cooldownTicks, jumpFieldAt(body.x, body.y, env, tick, jt), jt, tick);
      return;
    }
    case ReplicaMode.Pilotless:
      stepShipPhysics(body, flightControls(c, body), derived, tuning, { charge: FULL_CHARGE, drainRate: 0 }, env.gravity, 1, c.bits & CTL.emp ? withEmp(undefined) : undefined, env.terrain);
      return;
    case ReplicaMode.Drift:
      stepDrift(body, k);
      quantizeShipBody(body);
      return;
    case ReplicaMode.Anchored: {
      const spin = body.angVel;
      stepDrift(body, SHIP_FLIGHT_CONSTANTS);
      body.angVel = spin;
      quantizeShipBody(body);
      return;
    }
    case ReplicaMode.Docked:
      return;
  }
}
