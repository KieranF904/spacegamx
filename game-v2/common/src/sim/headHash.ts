/**
 * The snapshot-head state hash (sim foundation, Stage 0: the format only; Stage 1C wires it). It replaces the own
 * row's safety copy (SELF_SAFETY_TICKS, every 2 s, server/src/net/SnapshotBuilder.ts): every snapshot's head carries
 * the hash of the receiving pilot's own ship at the snapshot's tick, as the server stepped it (ring.ts shipHash, its
 * low 16 bits). The client compares it with its own tick layer's state at that tick (its StateRing): equal, nothing
 * happens; different (or the client has no state for that tick), its next input carries the miss and the server
 * sends the full own row once. A correct client never gets the row again; a broken one gets it within a round trip.
 *
 * Wire: 4 bytes, little-endian, after the head's tick: [own hash low 16][flags 8][reserved 8].
 * flags bit 0: the own ship is held (absent: docked, dead, between ships: no compare). bit 1: a full row follows in
 * this snapshot (the client re-seeds rather than compares). The rest are reserved, zero.
 */

export const HEAD_HASH_BYTES = 4;
export const HEAD_HASH_HELD = 1;
export const HEAD_HASH_ROW = 2;

export interface HeadHash {
  /** Low 16 bits of shipHash(own ship at the snapshot's tick) */
  own: number;
  flags: number;
}

export function packHeadHash(h: HeadHash, out: Uint8Array = new Uint8Array(HEAD_HASH_BYTES), at = 0): Uint8Array {
  out[at] = h.own & 0xff;
  out[at + 1] = (h.own >>> 8) & 0xff;
  out[at + 2] = h.flags & 0xff;
  out[at + 3] = 0;
  return out;
}

export function unpackHeadHash(b: ArrayLike<number>, at = 0): HeadHash {
  return { own: (b[at] | (b[at + 1] << 8)) & 0xffff, flags: b[at + 2] & 0xff };
}

/** Does a client's state agree with the head (compare only when held and no row came with it) */
export function headAgrees(h: HeadHash, ownHash: number | undefined): boolean {
  if (!(h.flags & HEAD_HASH_HELD) || h.flags & HEAD_HASH_ROW) return true;
  return ownHash !== undefined && (ownHash & 0xffff) === h.own;
}
