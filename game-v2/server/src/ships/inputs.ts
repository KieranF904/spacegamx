/**
 * The server's input sources (sim foundation, Stage 1 section D): what a ship flies a tick with, as an InputSource.
 *
 *  - `PilotInputSource` (confirmed): a player's held inputs, read off the Input component as ShipBridge.stepMovement's
 *    readInputsInto reads them. bits = the held controls only (no emp: that is state), q = the aim on the grid,
 *    jumpDist = the cursor distance.
 *  - `ControllerInputSource` (decided): an AI ship's order this tick, as pilotless.ts stepPilotless works it out: its
 *    controller's PilotOrders, else its autopilot, else holding still; pinned ships only turn; the impulse rides along.
 *
 * Plumbing only: nothing calls these yet (A's `pilotInput`/`pilotlessInput` still fly). Stage 3 swaps them in.
 */

import { Input, CTL, controlBits, getPlan, quantizeCursorDist, quantizeReplicaAngle, buildFlightInputs, newFlightControls, InputSlots } from '@space-game/common';
import type { FlightInputSource, InputSource, SimInput } from '@space-game/common';
import type { BridgeCtx } from './bridge/core.js';

let HELD: { name: string; field: ArrayLike<number> }[] | undefined;
function heldInputs(): { name: string; field: ArrayLike<number> }[] {
  return HELD ??= getPlan().held.map((name) => {
    const field = (Input as unknown as Record<string, ArrayLike<number> | undefined>)[name];
    if (!field) throw new Error(`part feature input ${name}: the Input component has no field of that name`);
    return { name, field };
  });
}

const SRC: FlightInputSource = { forward: false, backward: false, left: false, right: false, boost: false, targetAngle: 0 };
const CTLS = newFlightControls();

/** A pilot's held inputs, read off the Input component into a SimInput (same fields readInputsInto reads) */
export function readPilotInput(eid: number): SimInput {
  SRC.forward = Input.forward[eid] === 1;
  SRC.backward = Input.backward[eid] === 1;
  SRC.left = Input.left[eid] === 1;
  SRC.right = Input.right[eid] === 1;
  SRC.boost = Input.boost[eid] === 1;
  SRC.targetAngle = Input.targetAngle[eid];
  SRC.helm = Input.helm[eid] === 1;
  SRC.strafeLeft = Input.strafeLeft[eid] === 1;
  SRC.strafeRight = Input.strafeRight[eid] === 1;
  SRC.jump = Input.jump[eid] === 1;
  SRC.cursorDist = Input.cursorDist[eid];
  const H = heldInputs(), held = SRC as unknown as Record<string, boolean>;
  for (let i = 0; i < H.length; i++) held[H[i].name] = H[i].field[eid] === 1;
  // (emp false: it clears the jump in the step, from state, not here)
  const bits = controlBits(buildFlightInputs(SRC, false, CTLS));
  return {
    bits, q: quantizeReplicaAngle(Input.targetAngle[eid]), jumpDist: Input.cursorDist[eid],
    fire: Input.fireLeft[eid] === 1, fireAlt: Input.fireRight[eid] === 1, aimDist: quantizeCursorDist(Input.cursorDist[eid]),
  };
}

/** A player's inputs (confirmed: the server steps with what it holds, so every tick it has stepped is final) */
export class PilotInputSource implements InputSource {
  readonly knowledge = 'confirmed' as const;
  constructor(readonly eid: number, private readonly tick: () => number) {}
  inputAt(): SimInput { return readPilotInput(this.eid); }
  confirmedThrough(): number { return this.tick(); }
}

/** An AI ship's order (decided): its controller, else its autopilot, else holding still, from the bridge's own maps */
export class ControllerInputSource implements InputSource {
  readonly knowledge = 'decided' as const;
  private answered = -Infinity;
  constructor(private readonly b: BridgeCtx, readonly eid: number) {}

  inputAt(t: number): SimInput {
    const b = this.b, eid = this.eid;
    if (t > this.answered) this.answered = t;
    const ship = b.bodies.get(eid);
    const ai = b.controllers.get(eid);
    const orders = ai && ship ? ai(eid, ship) : null;
    const target = b.autopilot.get(eid);
    const base = { fire: !!orders?.firing, fireAlt: false, aimDist: quantizeCursorDist(orders?.aimDist ?? 0) };
    const impulse = orders?.impulse;
    if (!orders && !target) return { bits: CTL.hold, q: 0, jumpDist: -1, ...base };
    let c = orders ? orders.controls : b.autopilotControls(eid, target!);
    // (Pinned: it only turns)
    if (b.pinned.has(eid)) c = { ...c, forward: false, backward: false, left: false, right: false, boost: false };
    const out: SimInput = { bits: controlBits(c), q: quantizeReplicaAngle(c.targetAngle), jumpDist: -1, ...base };
    if (impulse) out.impulse = impulse;
    return out;
  }

  confirmedThrough(): number { return this.answered; }
}

/** The server's per-ship sources, with the possess hook (a pilot's slot holds PilotInputSource; an AI ship's ControllerInputSource) */
export function newServerInputSlots(): InputSlots { return new InputSlots(); }
