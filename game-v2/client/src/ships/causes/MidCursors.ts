/**
 * A ship on a tick part way through that tick's causes (CAPS.CONTACTS): its body before each cause, worked out once.
 * A pair reads the other ship just before the pair (its causes before it applied); with pairs found on the tick layer
 * a ship has a cause for every candidate near it, and working each such state out from scratch (its earlier causes,
 * each reading its own others the same way) grew with the square of a crowd and worse. Here each ship's causes on a
 * tick are applied once, in order, its body before each kept: a state asked for again (another pair reading it, its
 * own step) is looked up. A ship stepped again from a tick drops what was kept from then on (`forget`).
 */
import { applyCauseRows, quantizeShipBody, type CauseRow, type FlightBody, type OwnCauseEnv } from '@space-game/common';

interface Cursor {
  rows: readonly CauseRow[];
  env: OwnCauseEnv;
  /** Its body before each cause applied so far, and as it is now (after `next` of them) */
  befores: FlightBody[];
  body: FlightBody;
  next: number;
  busy: boolean;
}

export class MidCursors {
  private readonly ticks = new Map<number, Map<number, Cursor>>();
  readonly stats = { applied: 0, failed: 0, reentry: 0 };

  /** What was kept from tick t on goes (a ship stepped again from there) */
  forget(from: number): void {
    for (const t of this.ticks.keys()) if (t >= from) this.ticks.delete(t);
  }

  clear(): void {
    this.ticks.clear();
  }

  /**
   * Ship `id` on tick t just before the first of its causes placed at `place` or later (Infinity: after them all,
   * unrounded). `start`: its body before the tick's causes, its causes in order and what applying them reads
   */
  mid(id: number, t: number, place: number, start: () => { pre: FlightBody; rows: readonly CauseRow[]; env: OwnCauseEnv } | null): FlightBody | null {
    let m = this.ticks.get(t);
    if (!m) {
      this.ticks.set(t, (m = new Map()));
      if (this.ticks.size > 96) for (const k of this.ticks.keys()) { if (k >= t - 64) break; this.ticks.delete(k); }
    }
    let c = m.get(id);
    if (!c) {
      const s = start();
      if (!s) return null;
      c = { rows: s.rows, env: s.env, befores: [], body: { ...s.pre }, next: 0, busy: false };
      m.set(id, c);
    }
    let i = 0;
    while (i < c.rows.length && c.rows[i].seq < place) i++;
    if (i < c.next) return { ...c.befores[i] };
    // (Asked for further on while one of its causes is being applied: can't be, the pass's order forbids it)
    if (c.busy && i >= c.next) { this.stats.reentry++; return { ...c.body }; }
    while (c.next < i) {
      c.befores.push({ ...c.body });
      const r = c.rows[c.next++];
      c.busy = true;
      try { if (!applyCauseRows(c.body, [r.row], c.env)) this.stats.failed++; } finally { c.busy = false; }
      this.stats.applied++;
    }
    return { ...c.body };
  }

  /** After them all, rounded as every body is at a tick's end, into `body` (its step's result): false if one failed */
  after(id: number, t: number, body: FlightBody, start: () => { pre: FlightBody; rows: readonly CauseRow[]; env: OwnCauseEnv } | null): boolean {
    const failed = this.stats.failed;
    const end = this.mid(id, t, Infinity, () => { const s = start(); return s && { ...s, pre: body }; });
    if (!end) return false;
    Object.assign(body, end);
    quantizeShipBody(body);
    return this.stats.failed === failed;
  }
}
