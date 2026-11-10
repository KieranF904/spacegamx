/**
 * @contract sim.state
 * owns:       the sim's state shapes and GUN_FIELDS: the one table of per-gun fields every copy, wire form and hash
 *             iterates
 * needs:      common/ships ShipState and derived types
 * invariants: every gun field rides every copy, both wire forms and the hash; a field added to the table but dropped
 *             by one fails — common/src/sim/gunFields.test.ts
 * extend:     a new per-gun field is one name in GUN_ARRAYS or GUN_SCALARS plus its declaration in GunState and the
 *             ShipState type (tsc fails until they agree); a scalar also gets its line in copyGunScalars (unrolled for
 *             speed; gunFields.test.ts fails until it has)
 */

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
import { ReplicaMode } from '../ships/replicaControls.js';

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
  /** The group masks the waiting click is for (ships/guns.ts, weaponGroups.ts freshMasks); absent: every gun's */
  clickMasks?: number;
  /** The trigger word the guns stepped on last tick (ships/weaponGroups.ts trigWord); absent: 0 */
  trig?: number;
  minePaid?: number;
  mineUntil?: number;
  mineShare?: number;
  /** Tow Beam: the entity towed */
  tow?: number;
  /** A pilot's aim distance as its guns last stepped on it (ships/guns.ts distDue) */
  heldDist?: number;
}

/**
 * GUN_FIELDS: the gun state's fields, once. Every site that copies a gun state (the clones, the step's views, the own
 * client's mirror, the head hash's scratch) iterates these, so a new per-gun field is one line here plus its
 * declaration (GunState and the common ShipState; tsc fails until the two lists and the type agree).
 * - GUN_ARRAYS: by part index (copied element-wise or lent by reference).
 * - GUN_SCALARS: one value each, in this order (the order JSON messages carry them in). The first GUN_SCALARS_HASHED
 *   are hashed and sent in gunSync by hand (sim/ring.ts shipHash, sim/otherGuns.ts packGunSync: each has its own rule);
 *   any after them are numbers, hashed and sent only while set, generically, so adding one moves no hash or byte of a
 *   state that doesn't have it.
 */
export const GUN_ARRAYS = ['cooldown', 'rounds', 'reload', 'charge', 'spin', 'aim'] as const;
export const GUN_SCALARS = ['triggerHeld', 'clickAt', 'trig', 'minePaid', 'mineUntil', 'mineShare', 'tow', 'heldDist', 'clickMasks'] as const;
/** The scalars with their own hash and gunSync rules (all of today's); later ones go generic */
export const GUN_SCALARS_HASHED = 8;
export type GunArrayField = typeof GUN_ARRAYS[number];
export type GunScalarField = typeof GUN_SCALARS[number];

// (Checks: every GunState field is in exactly one list, and every listed field is a ShipState field of a compatible type)
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const GUN_FIELDS_COVER: Same<keyof GunState, GunArrayField | GunScalarField> = true;
type OnRecord = { [K in GunArrayField | GunScalarField]: ShipState[K] extends GunState[K] ? (Exclude<GunState[K], undefined> extends ShipState[K] ? true : false) : false }[GunArrayField | GunScalarField];
const GUN_FIELDS_ON_RECORD: Same<OnRecord, true> = true;
void GUN_FIELDS_COVER; void GUN_FIELDS_ON_RECORD;

type GunScalars = Pick<GunState, GunScalarField>;

/**
 * Every gun scalar from `from` onto `to` (absent ones too: a copy is the same shape whatever is set), in GUN_SCALARS
 * order. Named one by one: a loop over the names makes every load and store a keyed one, a hot cost in every copy of
 * a gun state (a scalar added to GUN_SCALARS but not here fails gunFields.test.ts)
 */
export function copyGunScalars(from: Readonly<GunScalars>, to: GunScalars): void {
  to.triggerHeld = from.triggerHeld; to.clickAt = from.clickAt; to.trig = from.trig; to.minePaid = from.minePaid;
  to.mineUntil = from.mineUntil; to.mineShare = from.mineShare; to.tow = from.tow; to.heldDist = from.heldDist;
  to.clickMasks = from.clickMasks;
}

/**
 * A gun state's scalars onto a ShipState-shaped record (a firing model's view, the own client's mirror): as copyGunScalars,
 * with the record's own defaults for what the gun state may leave absent (trig: 0)
 */
export function gunScalarsOntoRecord(from: Readonly<GunScalars>, to: Pick<ShipState, GunScalarField>): void {
  copyGunScalars(from, to as unknown as GunScalars);
  to.trig = from.trig ?? 0;
}

/** A gun state with its own arrays (`from`: a GunState or a ShipState's gun fields) */
export function cloneGunState(from: Readonly<Pick<GunState, GunArrayField | GunScalarField>>): GunState {
  const out = {
    cooldown: [...from.cooldown], rounds: [...from.rounds], reload: [...from.reload], charge: [...from.charge], spin: [...from.spin], aim: [...from.aim],
  } as GunState;
  copyGunScalars(from, out);
  return out;
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
export function gunStateOf(s: Pick<ShipState, GunArrayField | GunScalarField>): GunState {
  return cloneGunState(s);
}

function clonePorts(e: PortsState): PortsState {
  return { ...e, held: e.held.slice(), flags: e.flags.slice(), amt: e.amt.slice(), mat: e.mat.slice(), closed: e.closed.slice(), aug: e.aug.slice(), sat: e.sat.slice(), machEu: e.machEu.slice() };
}

export function cloneCharge(c: Charge): Charge {
  const out: Charge = {};
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
    guns: cloneGunState(g),
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
