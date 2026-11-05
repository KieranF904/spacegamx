/**
 * Own shells named by their shot ids on the wire (sim foundation Stage 1B, CAPS.SHOT_IDS).
 *
 * A capable pilot's client works its own straight shells out itself: which gun fired on which tick comes from its own
 * gun step (sim/guns.ts), the shells from the shared launch maths at its confirmed pose, and each one's name from its
 * shot id (events.ts shotId), so the server sends it no fire records of its own and no server entity ids for them.
 * The server still names those shells where it must (a removal the client can't derive, such as a rock strike; a hit
 * record) by the same name.
 *
 * A shot id is 49 bits and doesn't fit the wire's entity-id fields (31-bit ints: removed lists, hit records' shell
 * deltas). On the wire, to its own pilot, an own shell's owner is implied, so its name is the shot id without the
 * owner, in a range of its own above the server's entity ids (and above client MoveRunner's local ids' start):
 *   OWN_SHOT_WIRE0 + (tick mod 2^16) · 2^13 + slot · 2^5 + barrel        (< 2^31)
 */

import { SHOT_ID_BARRELS, SHOT_ID_SLOTS, SHOT_ID_TICKS, shotIdParts } from './events.js';

/** Where own shells' wire names start (bit 30 and bit 29 set: clear of entity ids and of MoveRunner's 0x40000000 ids for 2^29 shells) */
export const OWN_SHOT_WIRE0 = 0x60000000;

/** An own shell's wire name from (tick, slot, barrel) */
export function ownShotWire(tick: number, slot: number, barrel: number): number {
  const t = ((tick % SHOT_ID_TICKS) + SHOT_ID_TICKS) % SHOT_ID_TICKS;
  return OWN_SHOT_WIRE0 + t * SHOT_ID_SLOTS * SHOT_ID_BARRELS + slot * SHOT_ID_BARRELS + barrel;
}

/** An own shell's wire name from its shot id (the owner dropped: its pilot knows it) */
export function ownShotWireOf(shot: number): number {
  const p = shotIdParts(shot);
  return ownShotWire(p.tick16, p.slot, p.barrel);
}

/** Is this id an own shell's wire name? */
export function isOwnShotWire(id: number): boolean {
  return id >= OWN_SHOT_WIRE0 && id < 2 ** 31;
}

