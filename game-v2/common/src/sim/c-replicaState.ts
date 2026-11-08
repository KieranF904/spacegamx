/**
 * A replica's per-tick state as the StateRing holds it (sim foundation, Stage 1C): ShipReplicaSet (network/
 * replication.ts) keeps every ship it steps as one of these per tick, in a StateRing, where it kept `{ body, bits, q }`
 * steps in maps before. It is a SimShipState (the ring hashes it, a later stage steps it) that is cheap to make:
 * what a replica doesn't own per tick (its charge, a FULL_CHARGE stand-in; guns, hazards, priming, structure) is one
 * shared frozen value, and its controls are the object itself (`ctl` is `this`: bits and q are its own fields), so
 * one state costs the object and its body, as a step did.
 *
 * The same state on both ends hashes the same: the snapshot head's own-ship hash (headHash.ts) is shipHash of this
 * form of the pilot's ship at the snapshot's tick, on the server from its shadow (server net/SnapshotBuilder.ts) and on
 * the client from its tick layer (the replica set's ring).
 */

import type { FlightBody } from '../ships/flight.js';
import type { Charge } from '../ships/energy.js';
import type { ShipDerived } from '../ships/rebuild.js';
import { ReplicaMode } from '../ships/replicaControls.js';
import { NO_HAZARD, newGunState, type GunState, type HazardState, type SimCtl, type SimShipState, type SimStructure } from './state.js';
import { shipHash } from './ring.js';

const REP_CHARGE: Charge = Object.freeze({ g: 100, b: Object.freeze([]) as unknown as number[] }) as Charge;
const REP_GUNS: GunState = Object.freeze(newGunState(0));
/** A replica's structure as its per-tick state carries it (the real one is the set's to look up: version 0 on both ends) */
export const REPLICA_STRUCTURE: SimStructure = Object.freeze({ derived: null as unknown as ShipDerived, version: 0 });

export class ReplicaState implements SimShipState, SimCtl {
  readonly charge = REP_CHARGE;
  readonly accounted = false;
  readonly jumpPrime = 0;
  readonly hazard = NO_HAZARD as HazardState;
  readonly guns = REP_GUNS;
  readonly structure = REPLICA_STRUCTURE;

  constructor(
    readonly id: number,
    readonly mode: ReplicaMode,
    readonly body: FlightBody,
    readonly bits: number,
    readonly q: number,
  ) {}

  /** Its controls: itself (bits, q) */
  get ctl(): SimCtl { return this; }
}

/** shipHash of a ship's replica state (what the head hash compares): the same on both ends for the same body and controls */
export function replicaStateHash(id: number, mode: ReplicaMode, body: FlightBody, bits: number, q: number): number {
  return shipHash(new ReplicaState(id, mode, body, bits, q));
}
