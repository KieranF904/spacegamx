/**
 * stepShip: one tick of one ship (sim foundation; Stage 1A owns this file, the signature is env.ts StepShipFn).
 *
 * The one path every ship moves by, on every end: the server's pilots (bridge/flight.ts stepMovement) and pilotless
 * ships (bridge/pilotless.ts stepPilotless), the distant tier's measurements (SimLod.ts), every replica
 * (ships/replica.ts replicaStep: the server's shadows and every client's ShipReplicaSet) and the pilot's own
 * prediction (ShipClient.predict). The step owns, in this order:
 *   1. the hazard chain: env hazard, then numb, then slowed, then EMP (here and nowhere else)
 *   2. a decided source's impulse (unless EMP'd)
 *   3. the motion (stepShipMotion): pilotJumpStep (range boost, fields' cooldown, stillstone priming) round
 *      stepShipPhysics (stepFlight, terrain, quantisation), steering on the one aim rule (input.ts simAim)
 *   4. guns (guns.ts, Stage 1B): fire events (skipped when the host runs the ship's guns itself, env.gunsByHost: the
 *      server's fireWeapons and the client's predictGuns, through gunsTick; never both)
 *   5. pulls (pulls.ts, Stage 1C): forces both ends derive, then the body is quantised again
 *   6. the controls it flew (`ctl`), as the replicated row carries them
 *
 * ## Who gets what (decided in Stage 1A)
 * - Hazards come from state (`hazard`), or, in a replica's view, from the authority's row bits (CTL.emp, CTL.numb,
 *   CTL.slowed in `input.bits`; replicas know numb only as the bit: NUMB_REPLICA). Both are the same chain.
 * - Numb applies to every flown mode alike (Player and Pilotless): it is state, and replicas read it from CTL.numb.
 *   (The server chills only pilots today, bridge/damage.ts coldStage, so no pilotless trace moves.)
 * - The env hazard (hazards.ts hazardFlight: a well's drift, a rated system's sluggish drive) applies to pilots only:
 *   ENV_HAZARD_MODES. Replicas could derive it for pilotless ships too (the same function of build and position, on
 *   every end), but turning it on changes how every AI ship and boss flies in a hazard system (drifting into a
 *   black hole's well, slower drives), a gameplay call left to the owner; it is that one set.
 * - Priming (pilotJumpStep) runs for every flown mode, replicas and pilotless ships included: it is state, hashed.
 * - Engine power: an accounted pilot works it out from its stores; an unaccounted pilot (a replica) replays the
 *   authority's CTL power bits from `input.bits`; pilotless ships fly at full charge (their battery is the host's,
 *   bridge/pilotless.ts powerTick, after the step).
 */

import { stepShipPhysics, quantizeShipBody, SHIP_FLIGHT_CONSTANTS } from '../ships/physics.js';
import { jumpTuning, withSlowed, stepDrift, CTL_NO_BOOST, CTL_POWER_MASK, CTL_SHARE_MASK, type FlightConstants } from '../ships/flight.js';
import { pilotJumpStep } from '../ships/jumpFields.js';
import { withEmp } from '../ships/hazards.js';
import { withNumb, warmthStage, type WarmthStage } from '../ships/warmth.js';
import { gunLoadTick, FULL_CHARGE } from '../ships/energy.js';
import { stepDebrisBody } from '../ships/debris.js';
import { ReplicaMode } from '../ships/replica.js';
import { cloneSimShip, type SimShipState } from './state.js';
import { simControls, type SimInput } from './input.js';
import type { SimEnv, StepResult } from './env.js';
import type { SimEvent } from './events.js';
import { stepShipGuns } from './guns.js';
import { applyPulls } from './pulls.js';

// (CTL's hazard bits as numbers: replica.ts imports this file (replicaStep delegates here), so nothing from it may be
// read while this module loads. a-callers.test.ts checks they equal CTL's)
const BIT_JUMP = 256, BIT_EMP = 512, BIT_NUMB = 2048, BIT_SLOWED = 4096;

/** CTL bits that are state (hazards) or the authority's step's output (power, share, noBoost), not held controls */
export const CTL_STATE_BITS = BIT_EMP | BIT_NUMB | BIT_SLOWED | CTL_NO_BOOST | CTL_POWER_MASK | CTL_SHARE_MASK;
/** The authority's engine output a replica replays */
const CTL_REPLAY_BITS = CTL_POWER_MASK | CTL_SHARE_MASK | CTL_NO_BOOST;

/** Modes the env hazard (SimEnv.hazard) applies to: pilots only (see the header) */
export const ENV_HAZARD_MODES: ReadonlySet<ReplicaMode> = new Set([0 /* ReplicaMode.Player */]);

/** What the motion phases report besides the state (StepResult.isBoosting; not state: never stored, never hashed) */
export interface MotionOut {
  /** The CTL power bits it flew with (0 for anything but a pilot) */
  ctlPower: number;
  isBoosting: boolean;
}

function copyInto(out: SimShipState, from: SimShipState): void {
  Object.assign(out, cloneSimShip(from));
}

/** One ship's hazards for the tick: its state's, or a replica's view of the authority's (the row bits) */
export interface StepHazards {
  emp: boolean;
  slowed: boolean;
  /** The numb drive's control factor (1: not numb) */
  numb: number;
}

export function stepHazards(s: Readonly<SimShipState>, input: Readonly<SimInput>, t: number, out: StepHazards = { emp: false, slowed: false, numb: 1 }): StepHazards {
  const h = s.hazard;
  out.emp = t < h.empUntil || (input.bits & BIT_EMP) !== 0;
  out.slowed = t < h.slowUntil || (input.bits & BIT_SLOWED) !== 0;
  out.numb = h.numb < 1 ? h.numb : (input.bits & BIT_NUMB) !== 0 ? NUMB_REPLICA : 1;
  return out;
}

const HZ: StepHazards = { emp: false, slowed: false, numb: 1 };
const NUMB_STAGE: WarmthStage = { name: 'numb', below: 0, control: 1 };

export function stepShip(prev: SimShipState, input: Readonly<SimInput>, env: Readonly<SimEnv>, out?: SimShipState, events: SimEvent[] = []): StepResult {
  const s = out ?? cloneSimShip(prev);
  if (out && out !== prev) copyInto(out, prev);
  const hz = stepHazards(s, input, env.tick, HZ);
  const m = stepShipMotion(s, input, env, hz, MOTION);
  const ctlPower = m.ctlPower, isBoosting = m.isBoosting;
  // 4. Guns (Stage 1B), unless the host runs them
  if (!env.gunsByHost) stepShipGuns(s, input, env, events);
  // 5. Pulls (Stage 1C), then back on the snapshot grid
  if (env.pulls) { applyPulls(s, env, events); quantizeShipBody(s.body); }
  // 6. What it flew with (an EMP'd drive starts no jump: the bit goes as the step read it)
  const hazBits = (hz.emp ? BIT_EMP : 0) | (hz.numb < 1 ? BIT_NUMB : 0) | (hz.slowed ? BIT_SLOWED : 0);
  s.ctl.bits = (input.bits & ~CTL_STATE_BITS & ~(hz.emp ? BIT_JUMP : 0)) | hazBits | ctlPower;
  s.ctl.q = input.q;
  return { state: s, events, isBoosting };
}

const MOTION: MotionOut = { ctlPower: 0, isBoosting: false };

/**
 * Phases 1-3 of the step, in place on `s`: the impulse and the motion of whatever mode it is in. Writes the CTL power
 * bits it flew with and whether it boosted into `out` (returned). replicaStep is this, on a replica's view.
 */
export function stepShipMotion(s: SimShipState, input: Readonly<SimInput>, env: Readonly<SimEnv>, hz: Readonly<StepHazards>, out: MotionOut = MOTION): MotionOut {
  out.ctlPower = 0; out.isBoosting = false;
  const t = env.tick, body = s.body, d = s.structure.derived;
  switch (s.mode) {
    case ReplicaMode.Player:
    case ReplicaMode.Pilotless: {
      // 2. A decided source's push
      if (input.impulse && !hz.emp) { body.vx += input.impulse[0]; body.vy += input.impulse[1]; }
      // 1. The hazard chain: env hazard, numb, slowed, EMP
      const controls = simControls(input, body);      if (hz.emp) controls.jump = false;
      NUMB_STAGE.control = hz.numb;
      const here = ENV_HAZARD_MODES.has(s.mode) ? env.hazard?.(d, body.x, body.y) : undefined;
      const flown = withSlowed(withNumb(here, NUMB_STAGE), hz.slowed);
      const hazard = hz.emp ? withEmp(flown) : flown;
      // 3. The motion, round the charging fields
      const pilot = s.mode === ReplicaMode.Player;
      const accounted = pilot && s.accounted;
      const jt = jumpTuning(env.tuning);
      s.jumpPrime = pilotJumpStep(body, s.jumpPrime, env.fields, t, d.jumpCooldown || jt.cooldownTicks, jt, (rangeBoost) => {
        const energy = accounted ? { charge: s.charge, drainRate: 1, load: gunLoadTick(gunLoadOf(s), t), tick: t }
          // (A replica: no stores, the engines' power replayed from the authority's bits; pilotless: full charge)
          : pilot ? { charge: FULL_CHARGE, drainRate: 0, replay: input.bits } : { charge: FULL_CHARGE, drainRate: 0 };
        const res = stepShipPhysics(body, controls, d, env.tuning, energy, env.gravity, rangeBoost, hazard, env.terrain);
        if (accounted) { s.charge = res.charge; out.ctlPower = res.ctlPower; } else if (pilot) out.ctlPower = input.bits & CTL_REPLAY_BITS;
        out.isBoosting = res.isBoosting;
      });
      return out;
    }
    case ReplicaMode.Drift:
      // (Debris: the deterministic drift every side runs, ships/debris.ts)
      stepDebrisBody(body, env.gravity ? { ...SHIP_FLIGHT_CONSTANTS, gravity: env.gravity } : SHIP_FLIGHT_CONSTANTS);
      return out;
    case ReplicaMode.Anchored: {
      // (A wreck held in place: coasts and spins, no gravity)
      const spin = body.angVel;
      stepDrift(body, SHIP_FLIGHT_CONSTANTS as FlightConstants);
      body.angVel = spin;
      quantizeShipBody(body);
      return out;
    }
    case ReplicaMode.Docked:
    default:
      return out;
  }
}

/** (What gunLoadTick reads: the guns' state and the structure) */
const LOAD = { derived: undefined as unknown as SimShipState['structure']['derived'], cooldown: [] as number[], rounds: [] as number[], reload: [] as number[], charge: [] as number[], spin: [] as number[], mineUntil: undefined as number | undefined, tow: undefined as number | undefined };
function gunLoadOf(s: SimShipState): typeof LOAD {
  const g = s.guns;
  LOAD.derived = s.structure.derived; LOAD.cooldown = g.cooldown; LOAD.rounds = g.rounds; LOAD.reload = g.reload;
  LOAD.charge = g.charge; LOAD.spin = g.spin; LOAD.mineUntil = g.mineUntil; LOAD.tow = g.tow;
  return LOAD;
}

/** (A replica's numb drive: it knows only CTL.numb, warmthStage(1). warmth.ts is outside the replica.ts cycle) */
const NUMB_REPLICA = warmthStage(1).control;
