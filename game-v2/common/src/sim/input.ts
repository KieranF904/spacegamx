/**
 * Inputs to the stepper (sim foundation, Stage 0 contract): what a ship flies one tick with, the one aim rule, and
 * where inputs come from (InputSource).
 *
 * ## The aim rule
 * Every ship, every mode, every end steers on `simAim(q)`: the aim quantised to the replicated cursor grid
 * (`quantizeReplicaAngle`, 13 bits) and read back as float32. Today pilots steer on the raw `targetAngle` (equal to
 * this only when it came off the wire), replicas on `replicaAngle(mode, q)` (float32 for pilots only) and pilotless
 * ships on the unrounded dequantised angle. Stage 1A routes them all through `simAim`. Pilot traces don't move (the
 * wire already delivers this value); pilotless traces may, once, deliberately.
 *
 * ## Sources
 * | knowledge   | what                                           | today                                              |
 * |-------------|------------------------------------------------|----------------------------------------------------|
 * | `known`     | the own client's own inputs                    | ShipClient.predict's input / ShipReplicaSet own.src |
 * | `decided`   | worked out from decisions + state (AI)         | server controllers + autopilot (pilotless.ts), client BodyRunner drivers, server/src/bots drivers |
 * | `assumed`   | another pilot's last heard input, held         | ShipReplicaSet r.events, last row carried on       |
 * | `confirmed` | the input the authority stepped with           | server: a pilot's input messages (readInputsInto); client: ctl rows once they arrive |
 *
 * A tick's input is final when `t <= source.confirmedThrough()`. A client re-steps a ship from the first tick whose
 * confirmed input differs from what it stepped (an `assumed` input that turned out wrong).
 *
 * Bots: the server's NPC and simulated-player drivers (server/src/bots) become `decided` sources feeding the pilot
 * slot of their ship (they write Input components today); to clients they are pilots (`assumed`, then `confirmed`).
 *
 * Possess (hook only): `InputSlots.possess(id, src)` swaps a ship's source for another (an admin's live `known`
 * source on their client, `confirmed` on the server); `release(id)` restores the one it had. Nothing else changes:
 * the step reads only SimInput.
 */

import { dequantizeCursorAngle, quantizeCursorAngle } from '../network/cursorState.js';
import type { FlightControls } from '../ships/flight.js';
import { flightControls } from '../ships/replica.js';

/** One tick's inputs for one ship */
export interface SimInput {
  /** Held controls as CTL bits (movement, boost, helm, strafes, jump, hold, feature bits such as dodge). Not emp/numb/slowed/power: those are state */
  bits: number;
  /** The aim on the replicated cursor grid (quantizeReplicaAngle): steering reads simAim(q) */
  q: number;
  /** Jump distance as the step reads it (quantised cursor distance × CURSOR_DIST_STEP); below 0: not known (a replica: the charge waits) */
  jumpDist: number;
  /** Guns: trigger held (primary), mining/secondary held, aim distance (quantised). Stage 1B owns their use */
  fire: boolean;
  fireAlt: boolean;
  aimDist: number;
  /**
   * The guns' aim (world angle) where it isn't the steering aim (an AI pilot's: its body leads its target, sim/otherGuns.ts);
   * null: no aim (an AI with no target: turrets hold, fixed guns don't re-aim). Absent: simAim(q), as a pilot's
   */
  gunAim?: number | null;
  /** A decided source's push this tick (an AI order's impulse), applied before the motion unless EMP'd */
  impulse?: readonly [number, number];
  /**
   * A pilot's held aim (sim/aimHold.ts: the aim it was applied at last tick), where the raw aim `q` is known (its own
   * ship, on the server and its client). Set, the step still flies `q`, and its ctl.q is the applied aim: this one where
   * flying it would have done exactly the same. Absent: ctl.q is `q`
   */
  heldQ?: number;
}

export const NO_INPUT: Readonly<SimInput> = Object.freeze({ bits: 0, q: 0, jumpDist: -1, fire: false, fireAlt: false, aimDist: 0 });

/** The one aim rule: the grid aim, float32 (every mode) */
export function simAim(q: number): number {
  return Math.fround(dequantizeCursorAngle(q));
}

/** (cursorState.ts AIM_STEPS: the top of the 13-bit aim grid) */
const AIM_TOP = 8191;

/**
 * A raw aim angle onto the grid, canonical: simAimQ(simAim(q)) === q for every q. (quantizeCursorAngle alone sends the
 * top step, whose angle is just under 2π, back to 0: a different float, steered on differently; settled in Stage 3
 * from Stage 1A's aimQ)
 */
export function simAimQ(angle: number): number {
  const q = quantizeCursorAngle(angle);
  return q === 0 && angle > Math.PI ? AIM_TOP : q;
}

/** The FlightControls one tick flies with (CTL.hold: keep the heading, as flightControls has it). Jump stays the input's; the step clears it under EMP */
export function simControls(input: Readonly<SimInput>, body: { angle: number }): FlightControls {
  const c = flightControls({ bits: input.bits, targetAngle: simAim(input.q) }, body as never);
  c.jumpDist = input.jumpDist;
  // (The held aim to weigh against it, sim/aimHold.ts; holding the heading (CTL.hold), the aim is the heading either way)
  if (input.heldQ !== undefined) c.heldAngle = (input.bits & BIT_HOLD) !== 0 ? c.targetAngle : simAim(input.heldQ);
  return c;
}

/** (CTL.hold as a number: replica.ts is in this file's import cycle) */
const BIT_HOLD = 1024;

export type InputKnowledge = 'known' | 'decided' | 'assumed' | 'confirmed';

/** What a source may read of the ship before the tick (a SimShipState is one) */
export type InputPrev = Readonly<{ id: number; body: { x: number; y: number; angle: number }; ctl: { bits: number; q: number } }>;

export interface InputSource {
  readonly knowledge: InputKnowledge;
  /**
   * The input ship `id` flies tick t with. A decided source may read the ship's own state before the tick (`prev`:
   * its pose, and the controls it flew tick t - 1 with, `ctl`, so a driver that steers from its last bits/q needs no
   * memory of its own and a rollback's re-ask answers the same) and anything else deterministic both ends hold; never
   * wall-clock time or randomness outside common/math/rng.
   */
  inputAt(t: number, prev: InputPrev): SimInput;
  /** The last tick whose input is final (known and decided sources: every tick they have answered for) */
  confirmedThrough(): number;
}

/** A source of fixed per-tick inputs (tests, the harness, a recorded run) */
export class ScriptedInputs implements InputSource {
  constructor(readonly knowledge: InputKnowledge, private readonly script: (t: number) => SimInput, private through = Infinity) {}
  inputAt(t: number): SimInput { return this.script(t); }
  confirmedThrough(): number { return this.through; }
  confirm(t: number): void { this.through = t; }
}

/** Each ship's input source, with the possess hook */
export class InputSlots {
  private readonly src = new Map<number, InputSource>();
  private readonly held = new Map<number, InputSource>();

  set(id: number, s: InputSource): void { this.src.set(id, s); }
  get(id: number): InputSource | undefined { return this.src.get(id); }
  remove(id: number): void { this.src.delete(id); this.held.delete(id); }

  /** Fly ship `id` from `s` until released (an admin's live inputs) */
  possess(id: number, s: InputSource): void {
    const had = this.src.get(id);
    if (had && !this.held.has(id)) this.held.set(id, had);
    this.src.set(id, s);
  }

  release(id: number): void {
    const had = this.held.get(id);
    if (!had) return;
    this.held.delete(id);
    this.src.set(id, had);
  }

  possessed(id: number): boolean { return this.held.has(id); }
}
