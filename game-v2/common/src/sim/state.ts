/**
 * SimShipState: one ship as the deterministic stepper sees it (sim foundation, Stage 0 contract).
 *
 * A plain per-ship object: no ECS globals, no typed arrays indexed by entity, nothing reached through a host. Everything
 * a tick's step reads or writes about the ship is here or in `env` (step.ts), so the step can run anywhere (a worker
 * later) and a StateRing can keep copies of it. (Named SimShipState: `ShipState` is already the common ships/state.ts
 * record of blueprint, HP and the rest, which this one points at through `structure`.)
 *
 * Owned per tick (copied into the ring, hashed): pose and velocity (`body`), the controls it flew (`ctl`), its stores
 * (`charge`), gun state (`guns`), hazard state (`hazard`), jump state (`body.jump`, `jumpScale`, `jumpPrime`).
 * Shared by reference (never copied, never hashed, immutable between rebuild points): `structure`, the derived
 * structure and blueprint. A rebuild swaps the reference and bumps `structure.version` (the version is hashed).
 */

import type { FlightBody } from '../ships/flight.js';
import type { Charge } from '../ships/energy.js';
import type { ShipDerived } from '../ships/rebuild.js';
import type { ShipState } from '../ships/state.js';
import type { PortsState } from '../ships/power/ports.js';
import { ReplicaMode } from '../ships/replica.js';

/** The ship's structure: shared by reference by every copy of its state, replaced (not mutated) at a rebuild */
export interface SimStructure {
  readonly derived: ShipDerived;
  /** The full record (blueprint, HP, part uids) for steps that read it (guns: part uids, mods). Read-only in the step */
  readonly ship?: Readonly<ShipState>;
  /** Bumped at every rebuild point; part of the state hash, so a missed rebuild shows as a mismatch */
  readonly version: number;
}

/** Gun state, by part index (guns.ts stepGuns, the firing models; the same names as the common ShipState's) */
export interface GunState {
  cooldown: number[];
  rounds: number[];
  reload: number[];
  charge: number[];
  spin: number[];
  /** Turret aim, by part index */
  aim: number[];
  triggerHeld: boolean;
  clickAt: number;
  minePaid?: number;
  mineUntil?: number;
  mineShare?: number;
  /** Tow Beam: the entity towed (gunLoad draws for it) */
  tow?: number;
}

/**
 * Hazard state the step derives its hazard chain from (step.ts: numb, then slowed, then EMP). Ticks, not flags, so a
 * re-step of an older tick reads the hazard as it was then.
 */
export interface HazardState {
  /** EMP'd while tick < empUntil: drive × EMP_CONTROL, no jump starting, no firing */
  empUntil: number;
  /** Slowed (a Frostbite beam) while tick < slowUntil: × SLOW_CONTROL */
  slowUntil: number;
  /** Numb with cold: the warmth stage's control factor (1 = not numb). Replicas know only CTL.numb: warmthStage(1).control */
  numb: number;
}

/** The controls a ship flew its last tick with: the replicated form (CTL bits incl. power/share/noBoost, aim on the cursor grid) */
export interface SimCtl {
  bits: number;
  q: number;
}

export interface SimShipState {
  /** Entity id: the shot-id owner, the contact-pair order, the ring key */
  id: number;
  mode: ReplicaMode;
  /** Pose, velocity, jump counter and scale, cargo, dodge: on SHIP_PRECISION after every step */
  body: FlightBody;
  ctl: SimCtl;
  /**
   * Stores. `accounted` false: a replica's view (FULL_CHARGE, nothing drained; what the engines got comes from
   * CTL power bits). True: the real charge (the server's pilot and pilotless ships, the own client's prediction)
   */
  charge: Charge;
  accounted: boolean;
  /** Stillstone priming (jumpFields.ts stepPrime): owned by the step for every mode (replicas included, Stage 1A) */
  jumpPrime: number;
  hazard: HazardState;
  guns: GunState;
  structure: SimStructure;
}

export const NO_HAZARD: Readonly<HazardState> = Object.freeze({ empUntil: 0, slowUntil: 0, numb: 1 });

/** An empty gun state sized for a structure */
export function newGunState(parts = 0): GunState {
  const z = () => new Array<number>(parts).fill(0);
  return { cooldown: z(), rounds: z(), reload: z(), charge: z(), spin: z(), aim: z(), triggerHeld: false, clickAt: -1 };
}

/** A gun state copied out of a common ShipState (the adapter's way in, until Stage 1B owns guns) */
export function gunStateOf(s: Pick<ShipState, 'cooldown' | 'rounds' | 'reload' | 'charge' | 'spin' | 'aim' | 'triggerHeld' | 'clickAt' | 'minePaid' | 'mineUntil' | 'mineShare' | 'tow'>): GunState {
  return {
    cooldown: [...s.cooldown], rounds: [...s.rounds], reload: [...s.reload], charge: [...s.charge], spin: [...s.spin], aim: [...s.aim],
    triggerHeld: s.triggerHeld, clickAt: s.clickAt, minePaid: s.minePaid, mineUntil: s.mineUntil, mineShare: s.mineShare, tow: s.tow,
  };
}

function clonePorts(e: PortsState): PortsState {
  return { ...e, held: e.held.slice(), flags: e.flags.slice(), amt: e.amt.slice(), mat: e.mat.slice(), closed: e.closed.slice(), aug: e.aug.slice(), sat: e.sat.slice() };
}

export function cloneCharge(c: Charge): Charge {
  const out: Charge = { g: c.g, b: [...c.b] };
  if (c.eng) out.eng = [...c.eng];
  if (c.gun) out.gun = [...c.gun];
  if (c.e) out.e = clonePorts(c.e);
  if (c.row) out.row = Array.from(c.row);
  return out;
}

/** A deep copy of everything per-tick; `structure` shared by reference */
export function cloneSimShip(s: Readonly<SimShipState>): SimShipState {
  const g = s.guns;
  return {
    id: s.id, mode: s.mode, body: { ...s.body }, ctl: { bits: s.ctl.bits, q: s.ctl.q },
    charge: cloneCharge(s.charge), accounted: s.accounted, jumpPrime: s.jumpPrime,
    hazard: { empUntil: s.hazard.empUntil, slowUntil: s.hazard.slowUntil, numb: s.hazard.numb },
    guns: {
      cooldown: [...g.cooldown], rounds: [...g.rounds], reload: [...g.reload], charge: [...g.charge], spin: [...g.spin], aim: [...g.aim],
      triggerHeld: g.triggerHeld, clickAt: g.clickAt, minePaid: g.minePaid, mineUntil: g.mineUntil, mineShare: g.mineShare, tow: g.tow,
    },
    structure: s.structure,
  };
}

/** A fresh SimShipState (tests, harness scenarios, adapters) */
export function newSimShip(init: { id: number; derived: ShipDerived; ship?: ShipState; body: FlightBody; charge: Charge; accounted?: boolean; mode?: ReplicaMode; parts?: number }): SimShipState {
  return {
    id: init.id, mode: init.mode ?? ReplicaMode.Player, body: { jump: 0, cargo: 0, ...init.body }, ctl: { bits: 0, q: 0 },
    charge: cloneCharge(init.charge), accounted: init.accounted ?? true, jumpPrime: 0, hazard: { ...NO_HAZARD },
    guns: init.ship ? gunStateOf(init.ship) : newGunState(init.parts ?? init.derived.alive?.length ?? 0),
    structure: { derived: init.derived, ship: init.ship, version: 0 },
  };
}
