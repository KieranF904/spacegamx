/**
 * The snapshot-head state hash (sim foundation; Stage 1C wired it, Stage 3 settled the format here). It replaces the
 * own row's safety copy (SELF_SAFETY_TICKS, every 2 s, server/src/net/SnapshotBuilder.ts) for a client stepping its
 * own ship (CAPS.OWN_SIM): every snapshot's head carries `hh` (protocol.ts ServerSnapshotMessage, protocol 54), the
 * hash of the receiving pilot's own ship at the snapshot's tick as the server stepped it (its low 16 bits). The client
 * compares it with its own tick layer's state at that tick: equal, nothing happens; different (or no state for that
 * tick), it sends its own check at once (client ships/own/OwnTick.takeCheck) and the server puts it right (OwnChecks)
 * and sends its own row with that. A correct client never gets the row again; a broken one gets it within a round trip.
 *
 * Wire: one 24-bit field of the snapshot's packed sections (field 14; packed/snapshotSections.ts, packedCodec.ts):
 * own | flags << 16. flags bit 0 (HEAD_HASH_HELD): there is an own ship (absent: docked, dead, between ships: no
 * compare). bit 1 (HEAD_HASH_ROW): its state comes in this snapshot (a keyframe: the client re-seeds rather than
 * compares). The rest are reserved, zero.
 *
 * What is hashed: the own ship's replica form at that tick (c-replicaState.ts replicaStateHash: the pose, velocity,
 * jump, hold and dodge, and the controls it flew the tick with), which both ends hold exactly (the server from its
 * ship, the client from its replica set's ring). Not yet the full own state (ring.ts shipHash: charge, guns, hazards,
 * priming): the client keeps no per-tick copy of those for its own ship (ShipClient.predict / predictGuns step them
 * once, in place, unaligned to the snapshot's tick), so that waits for the own ship drawn from the replica layer.
 */

import type { FlightBody } from '../ships/flight.js';
import { ReplicaMode } from '../ships/replica.js';
import { replicaStateHash } from './c-replicaState.js';

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

/** The hash a client compares with the head's (its own ship flying: a pilot's replica state) */
export function ownHeadHash(id: number, body: FlightBody, bits: number, q: number): number {
  return replicaStateHash(id, ReplicaMode.Player, body, bits, q);
}

/** The head's word for its own ship at the snapshot's tick: held, with its hash; or not held (docked, dead, none) */
export function headWord(held: { id: number; body: FlightBody; bits: number; q: number } | null, flags = 0): number {
  if (!held) return headHashWord({ own: 0, flags });
  return headHashWord({ own: ownHeadHash(held.id, held.body, held.bits, held.q) & 0xffff, flags: flags | HEAD_HASH_HELD });
}
