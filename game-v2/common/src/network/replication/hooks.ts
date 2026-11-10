/**
 * @contract network.replication.hooks
 * owns:       what the client's ShipReplicaSet asks of its hosts: the own timeline, body drivers, other ships' causes,
 *             the contact pass's rewinds, side steps (other ships' guns) and the debris world; the Step it hands out
 * needs:      common/ships (ReplicaMode, ReplicaEnv, FlightBody, ShipDerived, Vec2), sim/input (SimInput)
 * invariants: a client rebuilds every other ship exactly from keyframes, control changes and causes against the
 *             server's state — server/src/net/replication.test.ts
 * extend:     a new thing a replica is moved by is a source or cause here, passed to ShipReplicaSet, not a branch in
 *             its step
 */

import type { ReplicaMode, ReplicaEnv, FlightBody, ShipDerived } from '../../ships/index.js';
import type { Vec2 } from '../../ships/types.js';
import type { SimInput } from '../../sim/input.js';

/** A piece of debris's shape for the knocks (ShipReplicaSet's debrisShape): its mass, radius, centre and convex pieces */
export interface DebrisShape { mass: number; radius: number; com: Vec2; pieces: readonly (readonly Vec2[])[]; born?: number }

/**
 * What a client's debris world asks of the debris it holds (client ships/debris/DebrisSplits.ts): each piece's shape
 * on a tick, and, for a piece it runs itself (CAPS.DEBRIS: common ships/debrisLife.ts), its life on that tick
 */
export interface DebrisWorld {
  /** Its shape on tick t's step (null: not known yet; it drifts without knocking) */
  shape(id: number, t: number): DebrisShape | null;
  /** Gone before tick t's step (its time is up) */
  gone?(id: number, t: number): boolean;
  /**
   * After tick t's step, the tick's rebuild point: a crumble rebuilt it there, and what's left is recentred in place
   * (`body` moved). False: nothing was left of it (it went at t)
   */
  after?(id: number, t: number, body: FlightBody): boolean;
  /** One it runs itself (its whole life worked out here, its end too: a removal of it is no news) */
  runs?(id: number): boolean;
}

/** A ship's state at a tick, as `at` gives it (the ring's ReplicaState: its body and the controls it flew) */
export interface Step { readonly body: FlightBody; readonly bits: number; readonly q: number }

/**
 * A pilot's own ship on its tick-aligned layer (CAPS.OWN_SIM, network/ownTick.ts): its controls are its own inputs
 * (and what the server says where they don't tell), its structure the one it flew on each tick, and after each step
 * that tick's causes (pulls, contacts, a rebuild). The replica set steps it like any other ship but asks this instead
 * of its control rows.
 */
export interface OwnTimeline {
  /** The control change on tick t (its input with that target tick, or what the server said for it), if any */
  ctl(t: number): readonly [number, number] | undefined;
  /** The structure it flew tick t with */
  derived(t: number): ShipDerived | null | undefined;
  /** After its step at tick t: that tick's causes, then rounded */
  after(t: number, body: FlightBody): void;
  /** Before its step at tick t: what goes in first (a CARGO cause: the hold's mass it flies the step with) */
  preStep?(t: number, body: FlightBody): void;
  /** Its pulls on tick t as the server told them (PULL rows, [kind, dvx, dvy]): its step takes them. Undefined: none told */
  pulls?(t: number): readonly (readonly number[])[] | undefined;
  /**
   * Its whole step at tick t, flown (a pilot's): the one stepper on its full state (stores, guns, hazards, priming:
   * the source keeps those by tick), `body` stepped in place from its state at t - 1, with the controls the timeline
   * says (`bits`, `q`), and `heldQ` the aim it was applied at on t - 1 (sim/aimHold.ts). Returns the controls it flew: the
   * CTL bits (its power and hazard bits the step's own) and its applied aim. Absent (or null back): stepped as any
   * replica is (replicaStep, its power from the bits, on `q`)
   */
  step?(t: number, body: FlightBody, bits: number, q: number, derived: ShipDerived, env: ReplicaEnv, heldQ: number): Readonly<{ bits: number; q: number }> | null;
}

/**
 * A ship flown by its body on the client's tick-aligned layer (CAPS.BODIES, bodies/): its controls and its drive's push
 * each tick come from its body (the decisions it was sent, and the replicas it reads), not from control rows. Null
 * from `step`: not this tick (the body is off: the rows fly it).
 */
export interface BodyDriver {
  /**
   * Tick t's controls and push, from the ship as it ended tick t - 1 and the aim and controls it flew that tick with; an
   * AI pilot's guns' controls too (`fire`, `aim`, `aimDist`: bodies/aiPilot.ts, flown by other ships' guns, sim/otherGuns.ts)
   */
  step(t: number, prev: FlightBody, prevQ: number, prevBits: number): { bits: number; q: number; ix: number; iy: number; fire?: boolean; aim?: number; aimDist?: number } | null;
  /** After its step at tick t (the body's check is of this) */
  after?(t: number, body: FlightBody): void;
}

/**
 * Other ships' causes on the tick-aligned layer (CAPS.CAUSES, network/causes.ts): after a ship's step at a tick, what
 * else moved it then (a contact, a rebuild's recentring, a pull), worked out as the server's shadow works it out; and
 * the structure it flew a tick with where that wasn't its current one (a rebuild later in the window)
 */
export interface ReplicaCauses {
  /** The structure ship `id` flew tick t with, if not its current one */
  derived(id: number, t: number): ShipDerived | undefined;
  /** Has it causes on tick t? */
  has(id: number, t: number): boolean;
  /** After its step at tick t: that tick's causes, then rounded */
  after(id: number, t: number, body: FlightBody): void;
  /** Before its step at tick t (only asked when it has causes then): a CARGO cause, the hold's mass it flies the step with */
  preStep?(id: number, t: number, body: FlightBody): void;
  /** Its pulls on tick t as the server told them (PULL rows, [kind, dvx, dvy]): its step takes them. Undefined: none told */
  pulls?(id: number, t: number): readonly (readonly number[])[] | undefined;
}

/**
 * A client finding contact pairs on its tick layer itself (CAPS.CONTACTS: client ships/causes/ContactWorld.ts): what
 * it worked out on a tick reads every ship of the pair there, so a ship stepped again from tick t (a rewind, a
 * keyframe, a late control row, gone) may change what it found from t on
 */
export interface ReplicaRewinds {
  rewound(id: number, t: number): void;
  /** Something is waiting to be worked out before a ship is stepped (pairs to find again, ships to step again) */
  readonly unsettled?: boolean;
  /** Work it out (asked only when the set isn't part way through a step: ShipReplicaSet.busy) */
  settle?(): void;
}

/**
 * Something stepped beside every ship's step on the tick layer (other ships' guns: sim/otherGuns.ts, client
 * ships/guns/OtherGuns.ts): told after each tick t a ship is stepped, with its state before (t - 1, after its causes),
 * after the step (before t's causes) and the input it flew, and whenever its steps from a tick on are dropped
 */
export interface ReplicaSideSteps {
  stepped(id: number, t: number, mode: ReplicaMode, prev: Readonly<Step>, now: Readonly<Step>, input: Readonly<SimInput>, derived: ShipDerived, env: ReplicaEnv): void;
  /** Its steps from tick t on are gone (a rewind, a keyframe, removed: -Infinity) */
  rewound(id: number, t: number): void;
}
