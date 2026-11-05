/**
 * Each tick's contact pass as a client finding pairs itself would need to know it (CAPS.CONTACTS): which ships were in
 * the pass (and each one's rebuild count then), which of them were pinned, the candidate pairs in the pass's order
 * (common ships/contactPass.ts), and where the pass began among the tick's causes. The server's pass notes it
 * (bridge/flight.ts resolveContacts); Replication reads it per client (net/causes/contactsFor.ts) to tell which of a
 * window's contacts that client works out itself, and which ships it must leave out.
 *
 * Only kept once a CONTACTS client has asked (`wanted`), for the last KEEP_TICKS ticks.
 */

/** One system's pass on one tick */
export interface ContactPassLog {
  /** The ships in the pass, by id (sorted), and each one's rebuild count then */
  ids: number[];
  rebuilds: number[];
  /** Pinned ones among them (they don't give: a client can't know that, so it is told their pairs) */
  pinned: number[];
  /** Candidate pairs as ids [a, b, a, b...] (a < b), in the pass's order */
  pairs: number[];
  /** The tick's cause sequence number as the pass began (a pull noted after it came after the pass) */
  seq: number;
}

const KEEP_TICKS = 128;

export class ContactLog {
  /** Kept only once some client finds its own contacts */
  wanted = false;
  private readonly ticks = new Map<number, Map<number, ContactPassLog>>();

  note(tick: number, systemId: number, log: ContactPassLog): void {
    if (!this.wanted) return;
    let t = this.ticks.get(tick);
    if (!t) {
      this.ticks.set(tick, (t = new Map()));
      for (const k of this.ticks.keys()) { if (k >= tick - KEEP_TICKS) break; this.ticks.delete(k); }
    }
    t.set(systemId, log);
  }

  /** A system's pass on a tick (undefined: no pass there with two bodies, or not kept) */
  at(tick: number, systemId: number): ContactPassLog | undefined {
    return this.ticks.get(tick)?.get(systemId);
  }
}

/** Is `id` among a pass's ships (sorted ids): its place, or -1 */
export function passIndex(log: ContactPassLog, id: number): number {
  let lo = 0, hi = log.ids.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, v = log.ids[m];
    if (v === id) return m;
    if (v < id) lo = m + 1; else hi = m - 1;
  }
  return -1;
}
