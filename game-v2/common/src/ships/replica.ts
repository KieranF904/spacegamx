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
import type { FlightConstants } from './flight.js';
import { ReplicaMode, type ReplicaControls } from './replicaControls.js';
import type { FieldEnv } from './jumpFields.js';
// (A cycle: sim/step.ts imports this file; neither reads the other while loading)
import { stepShipMotion, stepHazards, type StepHazards } from '../sim/step.js';
import { SimShipView, aimQ } from '../sim/a-adapt.js';
import type { SimInput } from '../sim/input.js';
import type { SimEnv, PullSource } from '../sim/env.js';
import { stepPulls } from '../sim/pulls.js';
import type { ClampSource } from '../sim/clampPair.js';
import type { ShipDerived } from './rebuild.js';
import type { ShipTuning } from './tuning.js';
import { getPlan } from './features/plan.js';

export { ReplicaMode, CTL, controlBits, flightControls, type ReplicaControls } from './replicaControls.js';

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
  /**
   * The pulls on pilots here (sim/pullFields.ts: fields both ends work out, or the pulls told for a tick): a pilot's
   * replica step takes them after its motion, as its own step does (sim/pulls.ts). Absent: none
   */
  pulls?: PullSource;
  /** Docking Clamps' links (sim/clampPair.ts): a pilot locked to another flies as the pair, or rides its leader. Absent: none */
  clamp?: ClampSource;
}

/**
 * One tick of a replicated ship, exactly as the server moves it when nothing
 * else interferes: the motion of the one stepper (sim/step.ts stepShipMotion),
 * on a replica's view (no stores, the authority's power and hazard bits, the
 * aim put back on its grid). Docked ships aren't stepped (they ride their
 * station). `tick` is the tick being stepped into (lodestones move with it).
 * A stillstone's priming is state here too: kept on the body (`jumpPrime`).
 */
export function replicaStep(mode: ReplicaMode, body: FlightBody, c: ReplicaControls, derived: ShipDerived, tuning: ShipTuning, env: ReplicaEnv, tick = 0, id = -1): void {
  if (mode === ReplicaMode.Docked) return;
  const s = (VIEW ??= new SimShipView()).load(id < 0 ? 0 : id, mode, body, derived, undefined, FULL_CHARGE, false, body.jumpPrime ?? 0);
  IN.bits = c.bits;
  IN.q = aimQ(c.targetAngle);
  IN.jumpDist = c.jumpDist ?? -1;
  ENV.tick = tick; ENV.tuning = tuning; ENV.gravity = env.gravity; ENV.terrain = env.terrain ?? null; ENV.hazard = env.hazard;
  FIELDS.central = env.central; FIELDS.lodestones = env.lodestones;
  ENV.clamp = id >= 0 ? env.clamp : undefined;
  const m = stepShipMotion(s, IN, ENV, stepHazards(s, IN, tick, HZ));
  if (s.jumpPrime || body.jumpPrime !== undefined) body.jumpPrime = s.jumpPrime;
  // (A pilot's pulls, after its motion: the step's pull phase, sim/pulls.ts; `id` names it to its source)
  if (mode === ReplicaMode.Player && env.pulls && id >= 0 && !m.follow) { ENV.pulls = env.pulls; stepPulls(id, body, ENV); ENV.pulls = undefined; }
}

/** (replicaStep's scratch: the view, its input (where a jump lands isn't replicated: -1, the charge waits), env, hazards) */
let VIEW: SimShipView | undefined;
const IN: SimInput = { bits: 0, q: 0, jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 };
const FIELDS: FieldEnv = { central: null, lodestones: undefined };
const ENV: SimEnv = { tick: 0, tuning: undefined as unknown as ShipTuning, gravity: null, fields: FIELDS, terrain: null };
const HZ: StepHazards = { emp: false, slowed: false, numb: 1 };
