/**
 * stepShip: one tick of one ship (sim foundation; Stage 1A owns this file, the signature is env.ts StepShipFn).
 *
 * The step owns, in this order:
 *   1. the hazard chain: env hazard, then numb, then slowed, then EMP (one place; today hand-built in four)
 *   2. a decided source's impulse (unless EMP'd)
 *   3. the motion: pilotJumpStep (range boost, fields' cooldown, stillstone priming) around stepShipPhysics
 *      (stepFlight, terrain collision, quantisation), steering on the one aim rule (input.ts simAim)
 *   4. guns (guns.ts, Stage 1B): fire events
 *   5. pulls (pulls.ts, Stage 1C): forces both ends derive, then the body is quantised again
 *   6. the controls it flew (`ctl`), as the replicated row carries them
 *
 * Stage 0 is a thin adapter over today's code, so the harness runs now: an accounted Player state flies the pilot
 * path exactly as server/src/ships/bridge/flight.ts stepMovement and ShipClient.predict call it; every other state
 * flies today's replicaStep (FULL_CHARGE, the CTL power bits replayed, no priming). Stage 1A makes this the one
 * path for all of them and routes the callers here.
 */

import { stepShipPhysics, quantizeShipBody } from '../ships/physics.js';
import { jumpTuning, withSlowed } from '../ships/flight.js';
import { pilotJumpStep } from '../ships/jumpFields.js';
import { withEmp } from '../ships/hazards.js';
import { withNumb, warmthStage, type WarmthStage } from '../ships/warmth.js';
import { dequantizeCursorAngle } from '../network/cursorState.js';
import { gunLoadTick } from '../ships/energy.js';
import { replicaStep, ReplicaMode, CTL } from '../ships/replica.js';
import { cloneSimShip, type SimShipState } from './state.js';
import { simControls, simAim, type SimInput } from './input.js';
import type { SimEnv, StepResult } from './env.js';
import type { SimEvent } from './events.js';
import { stepShipGuns } from './guns.js';
import { applyPulls } from './pulls.js';

/** CTL bits that are state (hazards) or the authority's step's output (power, share, noBoost), not held controls */
export const CTL_STATE_BITS = CTL.emp | CTL.numb | CTL.slowed | CTL.noBoost | CTL.power | CTL.share;

function copyInto(out: SimShipState, from: SimShipState): void {
  const c = cloneSimShip(from);
  Object.assign(out, c);
}

export function stepShip(prev: SimShipState, input: Readonly<SimInput>, env: Readonly<SimEnv>, out?: SimShipState, events: SimEvent[] = []): StepResult {
  const s = out ?? cloneSimShip(prev);
  if (out && out !== prev) copyInto(out, prev);
  const t = env.tick, body = s.body, d = s.structure.derived, h = s.hazard;
  // 1. Hazards: from state, or (a replica's view) from the authority's row bits
  const emp = t < h.empUntil || (input.bits & CTL.emp) !== 0;
  const slowed = t < h.slowUntil || (input.bits & CTL.slowed) !== 0;
  const numb = h.numb < 1 ? h.numb : (input.bits & CTL.numb) !== 0 ? NUMB_REPLICA : 1;
  const hazBits = (emp ? CTL.emp : 0) | (numb < 1 ? CTL.numb : 0) | (slowed ? CTL.slowed : 0);
  // 2. A decided source's push
  if (input.impulse && !emp) { body.vx += input.impulse[0]; body.vy += input.impulse[1]; }
  // 3. Motion
  let ctlPower = 0;
  if (s.mode === ReplicaMode.Player && s.accounted) {
    const controls = simControls(input, body);
    controls.jump = !!controls.jump && !emp;
    const flown = withSlowed(withNumb(env.hazard?.(d, body.x, body.y), { control: numb } as WarmthStage), slowed);
    const jt = jumpTuning(env.tuning);
    const g = s.guns;
    const loadShip = { derived: d, cooldown: g.cooldown, rounds: g.rounds, reload: g.reload, charge: g.charge, spin: g.spin, mineUntil: g.mineUntil, tow: g.tow };
    s.jumpPrime = pilotJumpStep(body, s.jumpPrime, env.fields, t, d.jumpCooldown || jt.cooldownTicks, jt, (rangeBoost) => {
      const res = stepShipPhysics(body, controls, d, env.tuning, { charge: s.charge, drainRate: 1, load: gunLoadTick(loadShip, t), tick: t }, env.gravity, rangeBoost, emp ? withEmp(flown) : flown, env.terrain);
      s.charge = res.charge;
      ctlPower = res.ctlPower;
    });
  } else {
    // (Today's replica: the row's bits, hazards included; its power bits replayed)
    replicaStep(s.mode, body, { bits: input.bits | hazBits, targetAngle: s.mode === ReplicaMode.Player ? simAim(input.q) : replicaAimToday(input.q) }, d, env.tuning,
      { gravity: env.gravity, central: env.fields.central ?? null, lodestones: env.fields.lodestones, terrain: env.terrain, hazard: env.hazard }, t);
    ctlPower = input.bits & (CTL.power | CTL.share | CTL.noBoost);
  }
  // 4. Guns (Stage 1B)
  stepShipGuns(s, input, env, events);
  // 5. Pulls (Stage 1C), then back on the snapshot grid
  if (env.pulls) { applyPulls(s, env, events); quantizeShipBody(body); }
  // 6. What it flew with
  s.ctl.bits = (input.bits & ~CTL_STATE_BITS) | hazBits | ctlPower;
  s.ctl.q = input.q;
  return { state: s, events };
}

/** (A replica's numb drive: it knows only CTL.numb, replica.ts NUMB = warmthStage(1)) */
const NUMB_REPLICA = warmthStage(1).control;

/** (Pilotless replicas steer on the unrounded dequantised aim today; Stage 1A moves them to simAim) */
function replicaAimToday(q: number): number {
  return dequantizeCursorAngle(q);
}
