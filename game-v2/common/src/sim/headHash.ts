/**
 * The snapshot-head state hash (sim foundation; Stage 1C wired it, Stage 3 settled the format here, Stage 3b made it
 * the full own state). It replaces the own row's safety copy (SELF_SAFETY_TICKS, every 2 s) for a client stepping its
 * own ship (CAPS.OWN_SIM): a snapshot's head carries `hh` (protocol.ts ServerSnapshotMessage), the hash of the
 * receiving pilot's own ship at the snapshot's tick as the server has it (its low 16 bits). The client compares it
 * with its own tick layer's state at that tick: equal, nothing happens; different (or no state for that tick), it
 * sends its own check at once (client ships/own/OwnTick.takeCheck), whose state byte is of the same hash
 * (ownStateHash); the server finds it off (server net/own/OwnChecks.ts) and puts it right: its own ship's keyframe
 * (the body) and an `ownSync` (everything else, exact: server net/own/ownSync.ts). A correct client never gets either
 * again; a broken one gets both within a round trip.
 *
 * Wire: one 24-bit field of the snapshot's packed sections (field 14; packed/snapshotSections.ts, packedCodec.ts):
 * own | flags << 16. flags bit 0 (HEAD_HASH_HELD): there is an own ship (absent: docked, dead, between ships: no
 * compare). bit 1 (HEAD_HASH_ROW): its state comes in this snapshot (a keyframe: the client re-seeds rather than
 * compares). The rest are reserved, zero.
 *
 * What is hashed (ownStateHash): the own ship's full per-tick state, the one stepper's (ring.ts shipHash's fields):
 * pose, velocity, jump, hold and dodge, the controls it flew (CTL bits incl. power and hazards, aim), priming, its
 * stores, its gun state (less turret aims: point defence follows what the server sees coming), and its hazards as ticks
 * left from the next tick (so the server's "not slowed: 0" and a
 * client's "slowed until a tick gone by" agree). Not the structure's version (each end counts its own): a missed
 * rebuild shows in the stores or the pose. Both ends step the same state with the same step (common sim/step.ts:
 * the server's stepMovement and fireWeapons, the client's own layer, OwnTick), so it matches to the bit.
 */

import type { FlightBody } from '../ships/flight.js';
import type { ReplicaMode } from '../ships/replica.js';
import type { SimShipState } from './state.js';
import { shipHash } from './ring.js';

/** The field's width on the wire */
export const HEAD_HASH_BITS = 24;
export const HEAD_HASH_HELD = 1;
export const HEAD_HASH_ROW = 2;

export interface HeadHash {
  /** Low 16 bits of the own ship's hash at the snapshot's tick */
  own: number;
  flags: number;
}

/** The head hash as its wire word: own | flags << 16 */
export function headHashWord(h: HeadHash): number {
  return (h.own & 0xffff) | ((h.flags & 0xff) << 16);
}

export function headHashOfWord(v: number): HeadHash {
  return { own: v & 0xffff, flags: (v >>> 16) & 0xff };
}

/** Does a client's state agree with the head (compare only when held and no row came with it) */
export function headAgrees(h: HeadHash, ownHash: number | undefined): boolean {
  if (!(h.flags & HEAD_HASH_HELD) || h.flags & HEAD_HASH_ROW) return true;
  return ownHash !== undefined && (ownHash & 0xffff) === h.own;
}

/** What the own state carries besides its pose and controls (the stores, guns, hazards, priming) */
export type OwnExtras = Pick<SimShipState, 'charge' | 'guns' | 'hazard' | 'jumpPrime'>;

/** (ownStateHash's scratch: the state as shipHash reads it, hazards as ticks left, turret aims left out) */
const SCRATCH: SimShipState = {
  // (ReplicaMode.Player: replica.ts is in this file's import cycle, nothing of it is read while it loads)
  id: 0, mode: 0 as ReplicaMode, body: undefined as unknown as FlightBody, ctl: { bits: 0, q: 0 }, charge: undefined as unknown as SimShipState['charge'],
  accounted: true, jumpPrime: 0, hazard: { empUntil: 0, slowUntil: 0, numb: 1 }, guns: undefined as unknown as SimShipState['guns'],
  structure: { derived: undefined as unknown as SimShipState['structure']['derived'], version: 0 },
};

/**
 * The own ship's full state hash at the end of tick `tick` (32 bits): its pose and controls there (`body`, `bits`,
 * `q`: its replica's, which both ends hold exactly) and the rest of its state (`x`)
 */
export function ownStateHash(id: number, body: FlightBody, bits: number, q: number, x: Readonly<OwnExtras>, tick: number): number {
  const s = SCRATCH, next = tick + 1;
  s.id = id; s.body = body; s.ctl.bits = bits; s.ctl.q = q;
  s.charge = x.charge; s.jumpPrime = x.jumpPrime;
  // (Its guns without their turrets' aims: a point-defence turret follows what the server sees coming, which its client
  // doesn't know. The rest of the gun state is its own guns' doing, stepped alike on both ends)
  const g = x.guns, v = GUNS;
  v.cooldown = g.cooldown; v.rounds = g.rounds; v.reload = g.reload; v.charge = g.charge; v.spin = g.spin;
  v.triggerHeld = g.triggerHeld; v.clickAt = g.clickAt; v.clickMasks = g.clickMasks; v.trig = g.trig; v.minePaid = g.minePaid; v.mineUntil = g.mineUntil; v.mineShare = g.mineShare; v.tow = g.tow; v.heldDist = g.heldDist;
  s.guns = v;
  s.hazard.empUntil = Math.max(0, x.hazard.empUntil - next);
  s.hazard.slowUntil = Math.max(0, x.hazard.slowUntil - next);
  s.hazard.numb = x.hazard.numb;
  return shipHash(s);
}

const GUNS: SimShipState['guns'] = { cooldown: [], rounds: [], reload: [], charge: [], spin: [], aim: [], triggerHeld: false, clickAt: -1 };

/** The head's word for its own ship at the snapshot's tick: held, with its state hash (ownStateHash); or not held */
export function headWord(hash: number | null, flags = 0): number {
  if (hash === null) return headHashWord({ own: 0, flags });
  return headHashWord({ own: hash & 0xffff, flags: flags | HEAD_HASH_HELD });
}
