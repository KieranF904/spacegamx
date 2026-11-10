/**
 * @contract server.ships.bridge.pilotless
 * owns:       ships nobody pilots: AI pilot orders, the autopilot and the end-of-tick step that flies them
 * needs:      BridgeCtx and ShipHost (bridge/core.ts), ShipBridge as a type only, bitecs components,
 *             @space-game/common; other bridge modules only through the bridge (b.hurt, b.rebuildNow)
 * invariants: bridge modules import ShipBridge as a type only; runtime imports run one way (ShipBridge.ts to
 *             bridge/*.ts to core.ts or common) — server/src/ships/bridge/imports.test.ts
 * extend:     a new pilotless behaviour is a PilotOrders field read here; what an AI decides lives in game/Enemies.ts
 *             and Bosses.ts
 */

/**
 * ShipBridge pilotless: ships nobody pilots. Their AI pilots (setController: PilotOrders each tick), the autopilot
 * (setAutopilot, autopilotControls), and the end-of-tick step that flies them (stepPilotless, called from flight.ts
 * tick through the bridge). ShipBridge keeps one-line delegators with the same names.
 *
 * What an AI pilot decides (its PilotOrders) is worked out by its controller, in server/src/game (Enemies.ts, Bosses.ts).
 */

import {
  Position, Velocity, Rotation, FRICTION, ReplicaMode, NO_FIELDS, stepShip, SimShipView,
  powerTick, FULL_CHARGE, type ShipState, type FlightConstants, type SimEnv, type SimEvent, type SimInput, type FieldEnv, type ShipDerived,
} from '@space-game/common';
import type { PilotOrders, BridgeCtx } from './core.js';
import { controllerInput } from './inputs.js';
import { datan2, dcos, dhypot, dsin } from '@space-game/common';

/** Reused each tick (powerTick reads it and keeps nothing) */
const PILOTLESS_USE = { thrusting: false, boosting: false };

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
  const dist = dhypot(dx, dy);
  // Hold the heading until the course drifts a degree or so: fewer control changes to replicate
  let want = datan2(dy, dx);
  const held = b.apHeading.get(eid);
  if (held !== undefined && Math.abs(datan2(dsin(want - held), dcos(want - held))) < 0.02 && dist > target.arriveRadius) want = held;
  b.apHeading.set(eid, want);
  let err = want - Rotation.angle[eid];
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  // Friction alone stops a ship moving at v within about v / (1 - FRICTION)
  const speed = dhypot(Velocity.x[eid], Velocity.y[eid]);
  const stopping = speed / (1 - FRICTION);
  const go = Math.abs(err) < 0.5 && dist - target.arriveRadius > stopping;
  // Mouse-steer controls are screen-relative (forward = up the screen): press the
  // screen directions nearest the nose, and the PD turn keeps the nose on target
  const a = Rotation.angle[eid], cx = dcos(a), cy = dsin(a);
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
  // One tick of the one stepper (common sim/step.ts stepShip), in place on a view of the ship, as every replica steps it:
  // the aim on the replicated grid (simAim), EMP'd it keeps flying crippled (as a pilot does), slowed by a Frostbite's
  // beam sluggish (features/weaponry), terrain, and on the replicated grid at once, as a pilot's step leaves it: what
  // the rest of the tick (contacts) sees of it is then what every client's replica has of it (network/ownTick.ts)
  const s = PILOTLESS_VIEW.load(eid, ReplicaMode.Pilotless, body, ship.derived, ship, FULL_CHARGE, false, ship.jumpPrime ?? 0);
  s.hazard.empUntil = b.empUntil.get(eid) ?? 0;
  s.hazard.slowUntil = b.slowedUntil.size > 0 ? tick + b.slowedTicksLeft(eid) : 0;
  s.hazard.numb = b.coldStage(eid).control;
  // (Its input from its source, bridge/inputs.ts: the orders asked once above, as their aim, target and body are read here too)
  stepShip(s, controllerInput(b, eid, orders, target, PILOTLESS_IN), pilotlessEnv(b, eid, k, tick), s, PILOTLESS_EVENTS);
  PILOTLESS_EVENTS.length = 0;
  if (s.jumpPrime || ship.jumpPrime !== undefined) ship.jumpPrime = s.jumpPrime;
  b.replicaCtl.set(eid, { mode: ReplicaMode.Pilotless, bits: s.ctl.bits, q: s.ctl.q, derived: ship.derived, body: orders?.body });
  b.writeBody(eid, ship, body);
  const pin = b.pinned.get(eid);
  if (pin) { Position.x[eid] = pin.x; Position.y[eid] = pin.y; Velocity.x[eid] = 0; Velocity.y[eid] = 0; }
  // Pilotless ships have stores too: the generators refill them, shots spend them (energy.ts, the ports core)
  const energy = { charge: powerTick(ship.derived, b.chargeOf(eid), PILOTLESS_USE).charge };
  const from = b.host.gunsRan ? b.fired.length : 0;
  b.fireWeapons(eid, ship, !!orders?.firing && !emp && !b.isJumping(ship), orders?.aim, orders?.aimDist ?? 0, orders?.target ?? -1, energy);
  b.charge.set(eid, energy.charge);
  // (What its guns did, for the clients stepping them from its body's controls: server net/guns/GunNet.ts)
  b.host.gunsRan?.(eid, from, !!orders?.body, !!orders?.firing, orders?.aim, orders?.aimDist ?? 0);
}

/** stepPilotless' scratch: the view, its input and env (reused every call; the step keeps none of them) */
const PILOTLESS_VIEW = new SimShipView();
const PILOTLESS_IN: SimInput = { bits: 0, q: 0, jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 };
const PILOTLESS_FIELDS: FieldEnv = { central: null };
const PILOTLESS_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: PILOTLESS_FIELDS, terrain: null, gunsByHost: true };
/** (Empty: its guns are fireWeapons', env.gunsByHost) */
const PILOTLESS_EVENTS: SimEvent[] = [];
let envEid = 0, envB: BridgeCtx | undefined;
const pilotlessHazard = (d: ShipDerived, x: number, y: number) => envB!.host.hazardFlight?.(envEid, d, x, y);
function pilotlessEnv(b: BridgeCtx, eid: number, k: FlightConstants, tick: number): SimEnv {
  const f = b.host.jumpFields?.(eid) ?? NO_FIELDS;
  PILOTLESS_FIELDS.central = f.central; PILOTLESS_FIELDS.lodestones = f.lodestones;
  envB = b; envEid = eid;
  const e = PILOTLESS_ENV;
  e.tick = tick; e.tuning = b.tuning; e.gravity = k.gravity ?? null; e.terrain = b.host.terrainAt?.(eid) ?? null;
  e.hazard = b.host.hazardFlight ? pilotlessHazard : undefined;
  return e;
}
