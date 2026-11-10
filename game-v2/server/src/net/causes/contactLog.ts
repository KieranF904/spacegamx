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

/** One ship across a window's passes (ContactLog.window): missing from one, and the rebuild counts it had in them */
export interface WindowShip {
  /** Not in every pass of the window (out of one there was) */
  missing: boolean;
  /** Its rebuild counts in the passes it was in, each once, and the first tick it had each */
  rebuilds: number[];
  ticks: number[];
}

/** A system's passes over a window, summed up by ship (ContactLog.window): what every client's window there reads */
export interface WindowPasses {
  /** Any pass at all in the window */
  any: boolean;
  ships: Map<number, WindowShip>;
}

export class ContactLog {
  /** Kept only once some client finds its own contacts */
  wanted = false;
  private readonly ticks = new Map<number, Map<number, ContactPassLog>>();
  /** Windows summed up since the last pass was noted (the passes don't change after: one sum for every client) */
  private readonly windows = new Map<string, WindowPasses>();

  note(tick: number, systemId: number, log: ContactPassLog): void {
    if (!this.wanted) return;
    this.windows.clear();
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

  /** A system's passes on the ticks after `from` up to `to`, by ship (worked out once, until a pass is noted) */
  window(systemId: number, from: number, to: number): WindowPasses {
    const k = `${systemId}:${from}:${to}`;
    let w = this.windows.get(k);
    if (w) return w;
    const ships = new Map<number, WindowShip>(), seen = new Map<number, number>();
    let passes = 0;
    for (let t = from + 1; t <= to; t++) {
      const L = this.at(t, systemId);
      if (!L) continue;
      passes++;
      for (let i = 0; i < L.ids.length; i++) {
        const id = L.ids[i], rb = L.rebuilds[i];
        let e = ships.get(id);
        if (!e) ships.set(id, (e = { missing: false, rebuilds: [], ticks: [] }));
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if (!e.rebuilds.includes(rb)) { e.rebuilds.push(rb); e.ticks.push(t); }
      }
    }
    for (const [id, e] of ships) e.missing = seen.get(id)! < passes;
    this.windows.set(k, (w = { any: passes > 0, ships }));
    return w;
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
