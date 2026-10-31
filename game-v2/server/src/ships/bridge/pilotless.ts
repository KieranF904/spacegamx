/**
 * ShipBridge pilotless: ships nobody pilots. Their AI pilots (setController: PilotOrders each tick), the autopilot
 * (setAutopilot, autopilotControls), and the end-of-tick step that flies them (stepPilotless, called from flight.ts
 * tick through the bridge). ShipBridge keeps one-line delegators with the same names.
 *
 * What an AI pilot decides (its PilotOrders) is worked out by its controller, in server/src/game (Enemies.ts, Bosses.ts).
 */

import { collideTerrain, terrainRadius } from '@space-game/common';
import {
  Position, Velocity, Rotation, FRICTION, stepFlight, withEmp, withSlowed, ReplicaMode, CTL, controlBits, replicaAngle,
  quantizeReplicaAngle, powerTick, gunLoadTick, FULL_CHARGE, type ShipState, type FlightConstants,
} from '@space-game/common';
import type { PilotOrders, BridgeCtx } from './core.js';

/** Reused each tick (powerTick reads it and keeps nothing) */
const PILOTLESS_USE: { thrusting: boolean; boosting: boolean; load: ArrayLike<number> | undefined } = { thrusting: false, boosting: false, load: undefined };

export function hasController(b: BridgeCtx, eid: number): boolean {
  return b.controllers.has(eid);
}

/** Where its autopilot is taking it (null: none) */
export function autopilotOf(b: BridgeCtx, eid: number): { x: number; y: number; arriveRadius: number } | null {
  return b.autopilot.get(eid) ?? null;
}

/** Give a pilotless ship an AI pilot (null: none) */
export function setController(b: BridgeCtx, eid: number, fn: ((eid: number, ship: ShipState) => PilotOrders | null) | null): void {
  if (fn) b.controllers.set(eid, fn);
  else b.controllers.delete(eid);
}

/** Fly a pilotless ship towards a point (null: stop and hold). */
export function setAutopilot(b: BridgeCtx, eid: number, target: { x: number; y: number; arriveRadius?: number } | null): void {
  if (target) b.autopilot.set(eid, { x: target.x, y: target.y, arriveRadius: target.arriveRadius ?? 500 });
  else b.autopilot.delete(eid);
}

/**
 * Autopilot controls: turn to face the target, thrust when roughly facing it,
 * and cut the engines in time to coast to a stop at the arrival radius.
 */
export function autopilotControls(b: BridgeCtx, eid: number, target: { x: number; y: number; arriveRadius: number }) {
  const dx = target.x - Position.x[eid], dy = target.y - Position.y[eid];
  const dist = Math.hypot(dx, dy);
  // Hold the heading until the course drifts a degree or so: fewer control changes to replicate
  let want = Math.atan2(dy, dx);
  const held = b.apHeading.get(eid);
  if (held !== undefined && Math.abs(Math.atan2(Math.sin(want - held), Math.cos(want - held))) < 0.02 && dist > target.arriveRadius) want = held;
  b.apHeading.set(eid, want);
  let err = want - Rotation.angle[eid];
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  // Friction alone stops a ship moving at v within about v / (1 - FRICTION)
  const speed = Math.hypot(Velocity.x[eid], Velocity.y[eid]);
  const stopping = speed / (1 - FRICTION);
  const go = Math.abs(err) < 0.5 && dist - target.arriveRadius > stopping;
  // Mouse-steer controls are screen-relative (forward = up the screen): press the
  // screen directions nearest the nose, and the PD turn keeps the nose on target
  const a = Rotation.angle[eid], cx = Math.cos(a), cy = Math.sin(a);
  return { forward: go && cy < -0.38, backward: go && cy > 0.38, left: go && cx < -0.38, right: go && cx > 0.38, boost: false, targetAngle: want };
}

/**
 * One end-of-tick step of a pilotless ship (flight.ts tick): its AI pilot's orders, else its autopilot, else holding
 * still; flown in the replicated aim quantisation, then its battery and guns
 */
export function stepPilotless(b: BridgeCtx, eid: number, ship: ShipState, k: FlightConstants, tick: number): void {
  // Dummy: holds its heading, coasts, and keeps its weapons cooling (or flies its autopilot course)
  const body = b.readBody(eid, ship);
  const ai = b.controllers.get(eid);
  const orders = ai ? ai(eid, ship) : null;
  const target = b.autopilot.get(eid);
  const emp = b.isEmped(eid);
  const hold = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: body.angle };
  let controls = orders ? orders.controls : target ? b.autopilotControls(eid, target) : hold;
  // Aim in the replicated quantization, so every client steps it exactly the same
  let q = 0;
  if (controls !== hold) {
    q = quantizeReplicaAngle(controls.targetAngle);
    controls = { ...controls, targetAngle: replicaAngle(ReplicaMode.Pilotless, q) };
  }
  // EMP'd: it keeps flying, crippled (as a pilot does); slowed by a Frostbite's beam, sluggish (features/weaponry)
  const slowed = b.slowedUntil.size > 0 && b.slowedTicksLeft(eid) > 0;
  b.replicaCtl.set(eid, { mode: ReplicaMode.Pilotless, bits: (controls === hold ? CTL.hold : controlBits(controls)) | (emp ? CTL.emp : 0) | (slowed ? CTL.slowed : 0), q, derived: ship.derived });
  if (orders?.impulse && !emp) { body.vx += orders.impulse[0]; body.vy += orders.impulse[1]; }
  const hazard = withSlowed(undefined, slowed);
  stepFlight(body, controls, ship.derived, b.tuning, { charge: FULL_CHARGE, drainRate: 0 }, emp ? { ...k, hazard: withEmp(hazard) } : hazard ? { ...k, hazard } : k);
  // A surface's rock (as the replicas have it: replicaStep)
  collideTerrain(body, terrainRadius(ship.derived.radius), b.host.terrainAt?.(eid));
  b.writeBody(eid, ship, body);
  const pin = b.pinned.get(eid);
  if (pin) { Position.x[eid] = pin.x; Position.y[eid] = pin.y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; }
  // Pilotless ships have a battery too: spare power charges it, shots spend it
  // (Its guns draw on the ship as they reload: energy.ts)
  PILOTLESS_USE.load = gunLoadTick(ship, tick);
  const energy = { charge: powerTick(ship.derived, b.chargeOf(eid), PILOTLESS_USE, b.tuning).charge };
  PILOTLESS_USE.load = undefined;
  b.fireWeapons(eid, ship, !!orders?.firing && !emp && !b.isJumping(ship), orders?.aim, orders?.aimDist ?? 0, orders?.target ?? -1, energy);
  b.charge.set(eid, energy.charge);
}
