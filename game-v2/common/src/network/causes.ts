/**
 * Other ships' causes on a client's tick-aligned layer (CAPS.CAUSES; docs/design/awareness-model.md 6.1, "effect and
 * cause records"). The own ship's causes (network/ownTick.ts) for every ship a client holds: what moved a ship besides
 * its controls goes as that cause at its tick, and the client works it out on its replica with the very function the
 * server's shadow uses (applyOwnCauses), so the replica stays the server's ship to the bit and no keyframe goes.
 *
 * A snapshot's `causes` records, by tick and then in the order the server's step had them:
 *
 *   PULL     [ago, 0, id, dvx, dvy]: a pilot's pull (on the PULL_PLACES grid)
 *   CONTACT  [ago, 1, a, b, flags, (a's x, y, angle, vx, vy), (b's ...)]: a and b touched, a the contact pass's first.
 *            One record for both: each side the client holds is pushed (worked out from the two bodies before the
 *            pair). A side's body is the client's own replica of it on that tick before its causes (ShipReplicaSet
 *            .preAt) and its causes earlier in the tick, unless its state follows (PAIR.A_STATE, PAIR.B_STATE): the
 *            server leaves it out only when that is what the pass had and the client steps that side in step
 *   REBUILD  [ago, 2, id]: rebuilt on that tick: it flew the structure it had until then (the client keeps the one from
 *            before its shipSync) and its centre moved with its centre of mass
 *
 * A record applies to each ship it names that the client holds and isn't sent a keyframe of in that snapshot (the
 * server's choice exactly: what it can't work out goes as a keyframe). A client without the cap gets a keyframe of every
 * ship a cause moved, as before.
 */
import { CAPS } from './hits.js';
import { ownSimCaps, OWN_CAUSE, CONTACT_FLAG } from './ownTick.js';

/** Does this client take other ships' causes (CAPS.CAUSES, on the own ship's: OWN_SIM)? */
export function causesFor(caps: number | undefined): boolean {
  return ((caps ?? 0) & CAPS.CAUSES) !== 0 && ownSimCaps(caps);
}

/** A CONTACT record's flags */
export const PAIR = {
  A_PINNED: 1,
  B_PINNED: 2,
  /** a's pose and velocity before the pair follow */
  A_STATE: 4,
  /** b's follow (after a's, if both) */
  B_STATE: 8,
  /** a was rebuilt after the contact in this window and the client had it as it was: its structure from before its shipSync */
  A_BEFORE: 16,
  B_BEFORE: 32,
} as const;

/** A ship's cause on a tick, in its own-format row ([kind, ...], network/ownTick.ts), and its place among the tick's */
export interface CauseRow { seq: number; row: number[] }

/**
 * A snapshot's records as each held ship's own-format rows by ship, then tick, in order: `takes` says which ships they
 * apply to (held, not keyframed now)
 */
export function causesByShip(rows: readonly (readonly number[])[] | undefined, snapTick: number, takes: (id: number) => boolean): Map<number, Map<number, CauseRow[]>> {
  const out = new Map<number, Map<number, CauseRow[]>>();
  let seq = 0;
  const put = (id: number, t: number, row: number[]) => {
    let ticks = out.get(id);
    if (!ticks) out.set(id, (ticks = new Map()));
    const at = ticks.get(t);
    if (at) at.push({ seq, row }); else ticks.set(t, [{ seq, row }]);
  };
  for (const r of rows ?? []) {
    seq++;
    const t = snapTick - r[0], kind = r[1];
    if (kind !== OWN_CAUSE.CONTACT) { if (takes(r[2])) put(r[2], t, [kind, ...r.slice(3)]); continue; }
    const a = r[2], b = r[3], f = r[4];
    const sa = f & PAIR.A_STATE ? r.slice(5, 10) : null, sb = f & PAIR.B_STATE ? r.slice(sa ? 10 : 5, sa ? 15 : 10) : null;
    if (takes(a)) {
      put(a, t, [OWN_CAUSE.CONTACT, b, (f & PAIR.B_PINNED ? CONTACT_FLAG.OTHER_PINNED : 0) | (f & PAIR.A_PINNED ? CONTACT_FLAG.SELF_PINNED : 0)
        | (f & PAIR.B_BEFORE ? CONTACT_FLAG.OTHER_BEFORE : 0) | (sb ? CONTACT_FLAG.STATE : 0), ...(sb ?? [])]);
    }
    if (takes(b)) {
      put(b, t, [OWN_CAUSE.CONTACT, a, CONTACT_FLAG.SECOND | (f & PAIR.A_PINNED ? CONTACT_FLAG.OTHER_PINNED : 0) | (f & PAIR.B_PINNED ? CONTACT_FLAG.SELF_PINNED : 0)
        | (f & PAIR.A_BEFORE ? CONTACT_FLAG.OTHER_BEFORE : 0) | (sa ? CONTACT_FLAG.STATE : 0), ...(sa ?? [])]);
    }
  }
  return out;
}

// ---- The check: a byte over every ship a client holds, on its own check (OwnCheck.body) ----

const mixH = (h: number, v: number) => Math.imul(h ^ (v | 0), 0x9e3779b1) ^ (Math.imul(h, 0x85ebca6b) >>> 13);

/** One held ship's share of the check: its id, place, velocity and heading, on the snapshot grid */
export function replicaHash(id: number, b: { x: number; y: number; vx: number; vy: number; angle: number }): number {
  let h = mixH(0x6a09e667, id);
  h = mixH(h, Math.round(b.x * 100)); h = mixH(h, Math.round(b.y * 100));
  h = mixH(h, Math.round(b.vx * 1e4)); h = mixH(h, Math.round(b.vy * 1e4)); h = mixH(h, Math.round(b.angle * 1e5));
  h ^= h >>> 15;
  return Math.imul(h, 0x2c1b3c6d) >>> 0;
}

/**
 * What a CAUSES client adds to its own check's state byte (OwnCheck.body): the sum of every ship it holds (not its own,
 * no debris, none docked) as of the snapshot's tick, once that snapshot is taken in (keyframes, causes, removals). The
 * server sums its shadows of the same ships; off, it keyframes them all again (and its own ship)
 */
export function replicasByte(sum: number): number {
  return (sum ^ (sum >>> 8) ^ (sum >>> 16) ^ (sum >>> 24)) & 0xff;
}
