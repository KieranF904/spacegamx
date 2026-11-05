/**
 * The snapshot head's own-ship hash as it goes (sim foundation, Stage 1C; the format in headHash.ts). A snapshot to
 * a client stepping its own ship (CAPS.OWN_SIM) carries `hh` (protocol.ts ServerSnapshotMessage): the low 16 bits of
 * its own ship's state hash at the snapshot's tick as the server stepped it, and the flags (HEAD_HASH_HELD: there is
 * a ship to compare; HEAD_HASH_ROW: its state comes in this snapshot, a keyframe, so nothing to compare), as one
 * 24-bit word, own | flags << 16 (the wire's packed sections carry it in 24 bits).
 *
 * The state hashed is its replica form at that tick (c-replicaState.ts: the pose, velocity, jump, hold and dodge, and
 * the controls it flew the tick with), which both ends hold exactly: the server from its ship (SnapshotBuilder), the
 * client from its tick layer (the replica set's ring, client ships/own/OwnTick.ts). A client that disagrees sends its
 * own check at once (OwnTick.takeCheck), and the server puts it right (OwnChecks: its own ship keyed, or its part HP
 * again) and sends its own row with that; so the row no longer goes every 2 s just in case (SELF_SAFETY_TICKS).
 */

import type { FlightBody } from '../ships/flight.js';
import { ReplicaMode } from '../ships/replica.js';
import { HEAD_HASH_HELD, type HeadHash } from './headHash.js';
import { replicaStateHash } from './c-replicaState.js';

export function headHashWord(h: HeadHash): number {
  return (h.own & 0xffff) | ((h.flags & 0xff) << 16);
}

export function headHashOfWord(v: number): HeadHash {
  return { own: v & 0xffff, flags: (v >>> 16) & 0xff };
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
