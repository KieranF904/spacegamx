/**
 * A pilot's own ship stepped by its own client (sim foundation Stage 3b): the one stepper (step.ts stepShip) on its
 * full state, guns included, once per tick. The client's own layer (client ships/own/OwnTick.ts, through
 * ShipReplicaSet's OwnTimeline.step) runs it for every tick up to its prediction's, and draws the ship from there; the
 * server steps the same state (bridge/flight.ts stepMovement, then fireWeapons on the same gun core, gunsTick).
 *
 * The state besides the pose and controls (`OwnExtras`: stores, guns, hazards, priming) is kept by the client per
 * tick and put right exactly by an `ownSync` (packOwnSync/unpackOwnSync) when the server's head hash or the client's
 * own check says it is off (headHash.ts ownStateHash). A hazard it couldn't foresee is told alone (packOwnHazards).
 */

import type { FlightBody } from '../ships/flight.js';
import type { ShipState } from '../ships/state.js';
import type { ShipDerived } from '../ships/rebuild.js';
import { ensurePortsCharge, type Charge } from '../ships/energy.js';
import type { PortsState } from '../ships/power/ports.js';
import { cloneCharge, newGunState, NO_HAZARD, type GunState, type HazardState, type SimShipState, type SimStructure } from './state.js';
import { simAimQ, type SimInput } from './input.js';
import { replicaAngle, quantizeReplicaAngle } from '../network/replication.js';
import type { SimEnv } from './env.js';
import type { SimEvent } from './events.js';
import type { OwnExtras } from './headHash.js';
import { stepShip } from './step.js';
import { CTL_POWER_MASK, CTL_SHARE_MASK, CTL_NO_BOOST } from '../ships/flight.js';

/** CTL bits a server's control row carries that an accounted step works out itself (its engines' power): dropped from the input */
const OWN_DERIVED_BITS = CTL_POWER_MASK | CTL_SHARE_MASK | CTL_NO_BOOST;

/** What a pilot's input says besides its held controls and aim (those are the timeline's bits and q) */
export interface OwnInputExtras {
  fire: boolean;
  fireAlt: boolean;
  /** The jump's distance (the cursor's, as the server's Input.cursorDist) */
  jumpDist: number;
  /** The guns' aim distance (the same cursor distance) */
  aimDist: number;
}

/**
 * An input's aim as the pilot's step flies it: the server puts the wire's angle on the replicated grid (handlers/flight.ts
 * applyInputToEntity: replicaAngle of quantizeReplicaAngle) and its step reads that onto the step's grid (simAimQ). Its
 * client's own layer takes it so (OwnTick.noteInput), and so does the server's view of what its inputs say (ownControlsOf)
 */
export function pilotAimQ(angle: number): number {
  return simAimQ(replicaAngle(0 /* ReplicaMode.Player */, quantizeReplicaAngle(angle)));
}

export const NO_OWN_INPUT: Readonly<OwnInputExtras> = Object.freeze({ fire: false, fireAlt: false, jumpDist: 0, aimDist: 0 });

/** A copy of the extras (every array its own) */
export function cloneOwnExtras(x: Readonly<OwnExtras>): OwnExtras {
  const g = x.guns;
  return {
    charge: cloneCharge(x.charge), jumpPrime: x.jumpPrime,
    hazard: { empUntil: x.hazard.empUntil, slowUntil: x.hazard.slowUntil, numb: x.hazard.numb },
    guns: {
      cooldown: [...g.cooldown], rounds: [...g.rounds], reload: [...g.reload], charge: [...g.charge], spin: [...g.spin], aim: [...g.aim],
      triggerHeld: g.triggerHeld, clickAt: g.clickAt, minePaid: g.minePaid, mineUntil: g.mineUntil, mineShare: g.mineShare, tow: g.tow,
    },
  };
}

/** Extras to start from with nothing known yet (full stores, the ship's gun state as its record has it, no hazards) */
export function seedOwnExtras(ship: Pick<ShipState, 'derived'> & Partial<Pick<ShipState, 'cooldown' | 'rounds' | 'reload' | 'charge' | 'spin' | 'aim'>>, charge?: Charge): OwnExtras {
  const n = ship.cooldown?.length ?? 0;
  const guns: GunState = ship.cooldown ? {
    cooldown: [...ship.cooldown], rounds: [...(ship.rounds ?? [])], reload: [...(ship.reload ?? [])], charge: [...(ship.charge ?? [])], spin: [...(ship.spin ?? [])], aim: [...(ship.aim ?? [])],
    triggerHeld: false, clickAt: -1,
  } : newGunState(n);
  const c = cloneCharge(charge ?? { g: 100, b: [] });
  ensurePortsCharge(ship.derived, c);
  return { charge: c, guns, hazard: { ...NO_HAZARD }, jumpPrime: 0 };
}

const INPUT: SimInput = { bits: 0, q: 0, jumpDist: 0, fire: false, fireAlt: false, aimDist: 0 };

/**
 * One tick of the own ship: from the extras it ended tick t - 1 with (`prev`, untouched) and its body there (`body`,
 * stepped in place), the controls (`bits`, `q`: held controls; the engines' power bits a server's row carried are
 * dropped, the step works out its own) and the rest of its input. The gun phase runs in the step (env.gunsByHost must be off): its
 * fire and fx events go to `events`. Returns the new state (its body is `body`). A server's row's hazard bits (EMP,
 * numb, slowed) stay in: the server flew them then, as its hazards were before the client heard of them
 */
export function stepOwnShip(id: number, prev: Readonly<OwnExtras>, body: FlightBody, bits: number, q: number, x: Readonly<OwnInputExtras>, structure: SimStructure, env: SimEnv, events: SimEvent[]): SimShipState {
  const e = cloneOwnExtras(prev);
  const s: SimShipState = {
    id, mode: 0 /* ReplicaMode.Player */, body, ctl: { bits: 0, q: 0 }, charge: e.charge, accounted: true, jumpPrime: e.jumpPrime,
    hazard: e.hazard, guns: e.guns, structure,
  };
  INPUT.bits = bits & ~OWN_DERIVED_BITS; INPUT.q = q;
  INPUT.jumpDist = x.jumpDist; INPUT.fire = x.fire; INPUT.fireAlt = x.fireAlt; INPUT.aimDist = x.aimDist; INPUT.impulse = undefined;
  ensurePortsCharge(structure.derived, s.charge);
  stepShip(s, INPUT, env, s, events);
  return s;
}

/** A structure record per derived structure (the own step's: never hashed, so its version stays 0) */
const STRUCTS = new WeakMap<ShipDerived, SimStructure>();
export function ownStructure(derived: ShipDerived, ship: Readonly<ShipState>): SimStructure {
  let s = STRUCTS.get(derived);
  if (!s || s.ship !== ship) STRUCTS.set(derived, (s = { derived, ship, version: 0 }));
  return s;
}

/**
 * `ownSync` (a plain message, server to its pilot's client): its own ship's extras at the end of tick `t`, exact (the
 * stores, the gun state, hazards as ticks left after t, priming). Its pose and controls go by its keyframe.
 *
 * Or its hazards alone (`c`, `g` and `p` absent: packOwnHazards): a hazard it couldn't foresee (an EMP, a Frostbite's
 * slowing, the cold's stage) is the server's decision, and the rest of its state is still its own to step. The ticks
 * it already flew under it come with the server's control row's hazard bits (stepOwnShip keeps them)
 */
export interface ServerOwnSyncMessage {
  type: 'ownSync';
  t: number;
  /** The stores */
  c?: Charge;
  /** The gun state */
  g?: GunState;
  /** Hazards: EMP and slowed ticks left from t + 1, numb's control factor */
  h: [number, number, number];
  /** Priming */
  p?: number;
}

/** A ports ship's stores' typed arrays as plain ones (the wire carries arrays), and back */
const PORTS_ARRAYS = [['held', Int32Array], ['flags', Uint8Array], ['amt', Int32Array], ['mat', Uint8Array], ['closed', Int16Array], ['aug', Int32Array], ['sat', Uint8Array]] as const;
function portsOut(e: PortsState): PortsState {
  const out = { ...e } as unknown as Record<string, unknown>;
  for (const [k] of PORTS_ARRAYS) out[k] = Array.from(e[k]);
  return out as unknown as PortsState;
}
function portsIn(e: PortsState): PortsState {
  const out = { ...e } as unknown as Record<string, unknown>;
  for (const [k, T] of PORTS_ARRAYS) out[k] = T.from((e as unknown as Record<string, ArrayLike<number>>)[k] ?? []);
  return out as unknown as PortsState;
}

export function packOwnSync(t: number, x: Readonly<OwnExtras>): ServerOwnSyncMessage {
  const c = cloneCharge(x.charge);
  delete c.row;
  if (c.e) c.e = portsOut(c.e);
  const next = t + 1;
  return { type: 'ownSync', t, c, g: cloneOwnExtras(x).guns, h: hazardsOut(t, x.hazard), p: x.jumpPrime };
}

/** An ownSync of its hazards alone (see ServerOwnSyncMessage) */
export function packOwnHazards(t: number, h: Readonly<HazardState>): ServerOwnSyncMessage {
  return { type: 'ownSync', t, h: hazardsOut(t, h) };
}

function hazardsOut(t: number, h: Readonly<HazardState>): [number, number, number] {
  const next = t + 1;
  return [Math.max(0, h.empUntil - next), Math.max(0, h.slowUntil - next), h.numb];
}

/** An ownSync's hazards as of the end of tick m.t (not EMP'd or slowed: 0, as the server's own state has it then) */
export function ownSyncHazards(m: ServerOwnSyncMessage): HazardState {
  const next = m.t + 1, h = m.h ?? [0, 0, 1];
  return { empUntil: h[0] > 0 ? next + h[0] : 0, slowUntil: h[1] > 0 ? next + h[1] : 0, numb: h[2] };
}

/** Its full extras (an ownSync with its stores: `c` there; one of its hazards alone has none) */
export function unpackOwnSync(m: ServerOwnSyncMessage): OwnExtras {
  const g = m.g ?? {} as Partial<GunState>;
  if (!m.c) throw new Error('ownSync: hazards only');
  // (Absent scalars come back undefined, as they went)
  const guns: GunState = {
    cooldown: [...(g.cooldown ?? [])], rounds: [...(g.rounds ?? [])], reload: [...(g.reload ?? [])], charge: [...(g.charge ?? [])], spin: [...(g.spin ?? [])], aim: [...(g.aim ?? [])],
    triggerHeld: !!g.triggerHeld, clickAt: g.clickAt ?? -1, minePaid: g.minePaid, mineUntil: g.mineUntil, mineShare: g.mineShare, tow: g.tow,
  };
  const charge: Charge = { ...m.c, b: [...(m.c.b ?? [])] };
  if (m.c.e) charge.e = portsIn(m.c.e);
  return {
    charge: cloneCharge(charge), guns, jumpPrime: m.p ?? 0, hazard: ownSyncHazards(m),
  };
}
