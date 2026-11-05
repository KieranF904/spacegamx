/**
 * What a step reads besides the ship and its input (sim foundation, Stage 0 contract): the world it flies in, the
 * same object on every end for the same system and tick. Plain data and pure functions only; nothing in it may read
 * wall-clock time, ECS components or host objects.
 */

import type { ShipTuning } from '../ships/tuning.js';
import type { GravityWell } from '../ships/flight.js';
import type { FieldEnv } from '../ships/jumpFields.js';
import type { HazardFlight } from '../ships/hazards.js';
import type { ShipDerived } from '../ships/rebuild.js';
import type { Terrain } from '../terrain.js';
import type { SimShipState } from './state.js';
import type { SimInput } from './input.js';
import type { SimEvent } from './events.js';

/**
 * Pulls as forces inside the step (Stage 1C fills this in; magnets, the Hookboat's reel, custom pulls, collapsing
 * stars). Worked out on both ends from state both hold as the tick starts (the puller's and the pulled's states at
 * t - 1, from the StateRing), never from a message. The step adds each pull's velocity (quantizePull'd) after the
 * motion, where today's push queue lands them, and emits a 'pull' event. Order: by puller id, ascending.
 */
export interface PullSource {
  /** The pulls on ship `id` for tick t: [puller id, ax, ay] each (world units / tick). Empty: none */
  on(id: number, t: number, at: { x: number; y: number }): readonly (readonly [number, number, number])[];
}

/**
 * Ship-to-ship contacts, resolved once per tick (Stage 1C). The candidate pairs are found once (contactPass.ts
 * sweep, pairs in ascending (a, b) id order) after the ships phase and cached by tick; every reader (server
 * resolveContacts, client ContactWorld, a re-step of that tick) takes the cached list. A re-step that moves a body
 * invalidates the cache from that tick on (`dropFrom`), so the pairs are found again only for re-stepped ticks.
 */
export interface ContactCache {
  /** The pairs at tick t ([a, b] with a < b), finding them if not cached */
  pairs(t: number): readonly (readonly [number, number])[];
  /** Forget ticks >= t */
  dropFrom(t: number): void;
}

export interface SimEnv {
  /** The tick being stepped into (lodestones and hazards are read at it) */
  tick: number;
  tuning: ShipTuning;
  gravity: GravityWell | null;
  /** Charging fields: the central body's ring and the stillstones */
  fields: FieldEnv;
  terrain: Terrain | null;
  /** What hazards do to a ship here (ships/hazards.ts hazardFlight); absent: none */
  hazard?: (derived: ShipDerived, x: number, y: number) => HazardFlight | undefined;
  pulls?: PullSource;
  /**
   * The host runs this ship's guns itself, once per tick in its guns phase (the server's fireWeapons, the client's
   * predictGuns, both through guns.ts gunsTick on the ShipState): the step skips its gun phase (4) so they never run
   * twice. Absent: the step runs them (stepShipGuns) and emits their events. Settled in Stage 3: the server keeps its
   * guns phase after every ship has moved (SIM_PHASES), and its projectiles need the gun step's specs (damage scale)
   */
  gunsByHost?: boolean;
}

export interface StepResult {
  state: SimShipState;
  events: SimEvent[];
  /** The drive boosted this tick (not state: never stored, never hashed; the server's pilot step stamps Boost.lastUseTick) */
  isBoosting: boolean;
}

/**
 * The stepper's signature: tick `env.tick` of one ship from its state at tick - 1. `prev` is not mutated unless it
 * is passed as `out` too (the server steps in place); otherwise the result is written into `out`, or a fresh copy.
 * Events are pushed onto `events` when given (one array for a whole tick), else onto a new array.
 */
export type StepShipFn = (prev: SimShipState, input: Readonly<SimInput>, env: Readonly<SimEnv>, out?: SimShipState, events?: SimEvent[]) => StepResult;
