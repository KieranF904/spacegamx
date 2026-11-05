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
import { CTL_NO_BOOST, CTL_POWER_MASK, CTL_SHARE_MASK, type FlightConstants } from './flight.js';
import type { FieldEnv } from './jumpFields.js';
// (A cycle: sim/step.ts imports this file; neither reads the other while loading)
import { stepShipMotion, stepHazards, type StepHazards } from '../sim/step.js';
import { SimShipView, aimQ } from '../sim/a-adapt.js';
import type { SimInput } from '../sim/input.js';
import type { SimEnv } from '../sim/env.js';
import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import { getPlan } from './features/plan.js';

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
  /** Slowed (a Frostbite beam, features/weaponry: thrust and turning × SLOW_CONTROL, flight.ts withSlowed); pinned in features.wire.json */
  slowed: 4096,
  /** Burst Strafer: dodge held (its way comes from the movement bits): features/strafer, whose input owns it (features.wire.json). (16384 is free) */
  dodge: 8192,
  /** The stores refused a boost this step (flight.ts CTL_NO_BOOST). Above it, from bit 15, the engines' power (flight.ts ctlOfPower) */
  noBoost: CTL_NO_BOOST,
  /** The engines' power (6 bits from bit 15: flight.ts ctlOfPower), a mask */
  power: CTL_POWER_MASK,
  /** What the part features' bursts got (6 bits from bit 21: flight.ts ctlOfShare), a mask */
  share: CTL_SHARE_MASK,
} as const;

export interface ReplicaControls {
  bits: number;
  targetAngle: number;
}

export function controlBits(c: Partial<FlightControls>): number {
  let bits = (c.forward ? CTL.forward : 0) | (c.backward ? CTL.backward : 0) | (c.left ? CTL.left : 0) | (c.right ? CTL.right : 0)
    | (c.boost ? CTL.boost : 0) | (c.helm ? CTL.helm : 0) | (c.strafeLeft ? CTL.strafeLeft : 0) | (c.strafeRight ? CTL.strafeRight : 0)
    | (c.jump ? CTL.jump : 0);
  // (Part features' held inputs with a control bit: the Burst Strafer's dodge, features/plan.ts controls)
  const X = getPlan().controls, held = c as Record<string, unknown>;
  for (let i = 0; i < X.length; i++) if (held[X[i].name]) bits |= X[i].bit;
  return bits;
}

export function flightControls(c: ReplicaControls, body: FlightBody): FlightControls {
  const b = c.bits;
  const out: FlightControls = {
    forward: (b & CTL.forward) !== 0, backward: (b & CTL.backward) !== 0, left: (b & CTL.left) !== 0, right: (b & CTL.right) !== 0,
    boost: (b & CTL.boost) !== 0, helm: (b & CTL.helm) !== 0, strafeLeft: (b & CTL.strafeLeft) !== 0, strafeRight: (b & CTL.strafeRight) !== 0,
    jump: (b & CTL.jump) !== 0,
    targetAngle: (b & CTL.hold) !== 0 ? body.angle : c.targetAngle,
    // Where a jump lands isn't replicated, nor so how long a short one charges (flight.ts jumpChargeNeed): -1, not
    // known, so the charge waits, and the burn's start brings a keyframe
    jumpDist: -1,
  };
  // (Part features' held inputs from their control bits: the Burst Strafer's dodge)
  const X = getPlan().controls, held = out as unknown as Record<string, boolean>;
  for (let i = 0; i < X.length; i++) held[X[i].name] = (b & X[i].bit) !== 0;
  return out;
}

/** What a ship's flight depends on: two structures with the same signature fly identically */
export function flightSignature(d: ShipDerived): string {
  const t = d.thrusters.map((x) => `${x.force[0]},${x.force[1]}`).join(';');
  // (Part features with flight hooks it has: features/plan.ts flightMask; nothing added for a ship with none. And what of
  // the rebuild their hooks read, each its flight key: the Burst Strafer's pushes, burst and cooldown)
  const P = getPlan();
  const fx = d.fxMask ? d.fxMask & P.flightMask : 0;
  let keys = '';
  for (let i = 0; i < P.flightKeys.length; i++) keys += (i ? '|' : '') + P.flightKeys[i](d);
  return `${d.mass}|${d.inertia}|${d.fullMass}|${d.fullInertia}|${d.drive}|${d.maneuverForce}|${d.maxTorque.cw}|${d.maxTorque.ccw}|${d.jumpRange}|${d.jumpCooldown}|${t}|${keys}${fx ? `|fx${fx}` : ''}`;
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
 * else interferes: the motion of the one stepper (sim/step.ts stepShipMotion),
 * on a replica's view (no stores, the authority's power and hazard bits, the
 * aim put back on its grid). Docked ships aren't stepped (they ride their
 * station). `tick` is the tick being stepped into (lodestones move with it).
 * A stillstone's priming is state here too: kept on the body (`jumpPrime`).
 */
export function replicaStep(mode: ReplicaMode, body: FlightBody, c: ReplicaControls, derived: ShipDerived, tuning: ShipTuning, env: ReplicaEnv, tick = 0): void {
  if (mode === ReplicaMode.Docked) return;
  const s = (VIEW ??= new SimShipView()).load(0, mode, body, derived, undefined, FULL_CHARGE, false, body.jumpPrime ?? 0);
  IN.bits = c.bits;
  IN.q = aimQ(c.targetAngle);
  ENV.tick = tick; ENV.tuning = tuning; ENV.gravity = env.gravity; ENV.terrain = env.terrain ?? null; ENV.hazard = env.hazard;
  FIELDS.central = env.central; FIELDS.lodestones = env.lodestones;
  stepShipMotion(s, IN, ENV, stepHazards(s, IN, tick, HZ));
  if (s.jumpPrime || body.jumpPrime !== undefined) body.jumpPrime = s.jumpPrime;
}

/** (replicaStep's scratch: the view, its input (where a jump lands isn't replicated: -1, the charge waits), env, hazards) */
let VIEW: SimShipView | undefined;
const IN: SimInput = { bits: 0, q: 0, jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 };
const FIELDS: FieldEnv = { central: null, lodestones: undefined };
const ENV: SimEnv = { tick: 0, tuning: undefined as unknown as ShipTuning, gravity: null, fields: FIELDS, terrain: null };
const HZ: StepHazards = { emp: false, slowed: false, numb: 1 };
