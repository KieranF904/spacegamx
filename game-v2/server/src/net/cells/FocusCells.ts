/**
 * The focus grid on the server (CAPS.FOCUS; common network/cells.ts; docs/design/awareness-model.md section 0).
 *
 * Shared, once a snapshot round: every ship's home cell (with CELL_HOME_SLACK) and each system's cells' lists of
 * ships. Per client: its focus cells (every cell within 19 km of its ship, flat), which of them are held, which wait for
 * its answer about a cell it dropped, and the cells it dropped (when, which ships: what the server sent it, nothing kept
 * of the ships themselves). A client's ship view is the ships homed in its held focus cells: that replaces the 40/48 km
 * circle (SnapshotBuilder.updateShipView) and costs the focus's ships, not the system's.
 *
 * - **Leaving.** A cell leaving the focus keeps its ships in view for that round's snapshot (their rows for it go), then
 *   the `cells` message after it drops them (`d`): the client keeps them as of that tick. The server records each
 *   ship's keyframe version and hash then (`records`, per cell and tick, shared by every client that drops it then).
 * - **Entering.** A cell it dropped less than the hold ago comes back pending (`b`: what do you have of it?), its ships
 *   out of view till the answer (cellCache) or a timeout. A hash that agrees, with the control changes since (each
 *   shadow keeps them, Replication.eventsSince) smaller than an entry, goes back as a log (`l`) for the ships still on
 *   their path and in focus: the client fast-forwards them, and they come into view the next round on control rows.
 *   Otherwise (no answer, a different hash, a long log) `l` with none, and they enter as new: keyframes, rows, syncs.
 * - **Jumps.** While its ship is in a jump's burn its focus holds as it was (a transit: no cell dropped or entered on the
 *   way); the burn's end drops the old cells and enters the new ones at once.
 * - **Ghosts.** The ring (cells within 35 km), pending cells, party and target: map-dot legs (sendMapDots), not held.
 *
 * Entries are encoded once already: with CAPS.BLOCKS each entering ship's keyframe and status row is one shared block.
 */
import { InSystem, Position, FOCUS_RANGE, CELL_HOLD_TICKS, CELL_ENTRY_BYTES, focusCells, ringCells, homeCell, cellHash, packCellLog, cellLogBytes, type CellLogShip } from '@space-game/common';
import type { ClientConnection } from '../ClientConnection.js';
import type { Replication } from '../Replication.js';

/** What the focus grid needs of the server */
export interface FocusHost {
  /** Every ship body (id order as the bridge keeps them) */
  bodies(): Iterable<number>;
  has(eid: number): boolean;
  /** A client's party's ships and its target: ghosts wherever they are */
  partyOf(conn: ClientConnection): readonly number[];
  targetOf(eid: number): number;
  /** Bosses this client runs on its tick layer (CAPS.BODIES): never kept, they come back as new */
  runsBody(conn: ClientConnection, eid: number): boolean;
  send(conn: ClientConnection, msg: { type: 'cells'; tick: number; d?: number[]; b?: number[]; l?: number[] }): void;
  /** Its status rows as last sent (dropped ships are forgotten there, so their rows go afresh) */
  rowsSent(conn: ClientConnection): Map<number, string> | undefined;
  /** Its ship is in a jump's burn (20 km/s: a cell every 24 ticks): its focus holds still till it ends */
  transit(eid: number): boolean;
  /** The focus radius in a system (19 km; less in a crowd: net/crowd/CrowdControl.ts) */
  focusOf?(system: number): number;
}

/** One client's focus (ClientConnection.focus) */
export interface FocusState {
  /** The system it is for */
  system: number;
  /** Its focus cells as of the last round */
  cells: Set<number>;
  ring: Set<number>;
  /** Dropped cells back in focus, waiting for its answer: cell -> the drop's tick, and the round it was asked */
  pending: Map<number, { T: number; since: number }>;
  /** Cells it dropped: cell -> the tick, and the ships it was told to keep */
  dropped: Map<number, { T: number; ids: number[] }>;
  /** Its answers since the last round: [cell, T, hash] */
  replies: number[];
  /** This round: cells leaving, ships put back (id, version), ships kept out of view this round, and what goes after */
  leaving: number[];
  restore: [number, number][];
  skip: Set<number>;
  b: number[];
  l: number[];
}

/** An answer this long after the question (ticks, plus its ping) is too late: the cell comes back as new */
const ANSWER_TICKS = 30;
/** Offered back only this long after the drop (the client keeps it CELL_HOLD_TICKS and more: no race at the end) */
const OFFER_TICKS = CELL_HOLD_TICKS - 60;

export class FocusCells {
  /** Every ship's home cell (kept between rounds: the slack needs the last) */
  private homes = new Map<number, number>();
  /** This round's cells, by system: cell -> ships homed there (body order) */
  private grid = new Map<number, Map<number, number[]>>();
  /** Dropped cells' records, shared: `${system}:${cell}:${T}` -> ship -> [version, hash] */
  private records = new Map<string, Map<number, [number, number]>>();
  private tick = 0;
  /** Counters (the crowd bench, the tests) */
  readonly stats = {
    rounds: 0, drops: 0, dropShips: 0, entries: 0, offers: 0, logs: 0, logShips: 0, logBytes: 0, logEvents: 0,
    refusedHash: 0, refusedSize: 0, refusedLate: 0, refusedNone: 0, savedBytes: 0,
  };

  constructor(private host: FocusHost, private replication: Replication) {}

  /** Once a round, before any client's view: home cells and the cells' lists, for the systems with a capable client */
  beginRound(tick: number, systems: ReadonlySet<number>): void {
    this.tick = tick;
    this.stats.rounds++;
    this.grid.clear();
    for (const eid of this.homes.keys()) if (!this.host.has(eid)) this.homes.delete(eid);
    if (!systems.size) return;
    for (const eid of this.host.bodies()) {
      const sys = InSystem.systemId[eid];
      if (!systems.has(sys)) continue;
      const h = homeCell(this.homes.get(eid), Position.x[eid], Position.y[eid]);
      this.homes.set(eid, h);
      let cells = this.grid.get(sys);
      if (!cells) this.grid.set(sys, (cells = new Map()));
      const list = cells.get(h);
      if (list) list.push(eid); else cells.set(h, [eid]);
    }
    for (const [k] of this.records) if (Number(k.slice(k.lastIndexOf(':') + 1)) < tick - CELL_HOLD_TICKS - 120) this.records.delete(k);
  }

  /** A ship's home cell this round (undefined: not placed) */
  homeOf(eid: number): number | undefined {
    return this.homes.get(eid);
  }

  /** Forget a client's focus (a new system, its death, its caps switched): it starts afresh */
  reset(conn: ClientConnection): void {
    conn.focus = undefined;
  }

  /** Its answer about dropped cells (cellCache): weighed at the next round */
  reply(conn: ClientConnection, c: readonly unknown[]): void {
    const st = conn.focus;
    if (!st || !Array.isArray(c)) return;
    for (let i = 0; i + 2 < c.length && st.replies.length < 300; i += 3) st.replies.push(Number(c[i]) || 0, Number(c[i + 1]) || 0, Number(c[i + 2]) >>> 0);
  }

  /**
   * A capable client's view this round (in place of updateShipView): its own ship, and the ships homed in its held focus
   * cells, plus this round those of cells leaving it (dropped after the snapshot: `after`). Returns the ships that left
   * its view otherwise (they go in the snapshot's `out`, as before)
   */
  view(conn: ClientConnection, system: number, px: number, py: number): number[] {
    let st = conn.focus;
    if (!st || st.system !== system) {
      st = conn.focus = { system, cells: new Set(), ring: new Set(), pending: new Map(), dropped: new Map(), replies: [], leaving: [], restore: [], skip: new Set(), b: [], l: [] };
    }
    st.leaving.length = 0; st.restore.length = 0; st.skip.clear(); st.b.length = 0; st.l.length = 0;
    // (In a jump's burn: the focus it had holds, no cell dropped or entered on the way; the burn's end is one change)
    const transit = st.cells.size > 0 && this.host.transit(conn.playerId);
    const range = this.host.focusOf?.(system) ?? FOCUS_RANGE;
    const now = transit ? st.cells : new Set(focusCells(px, py, undefined, range));
    if (!transit) st.ring = new Set(ringCells(px, py, undefined, range));
    this.answers(conn, st, now);
    for (const c of st.cells) {
      if (now.has(c)) continue;
      if (st.pending.delete(c)) continue;
      st.leaving.push(c);
    }
    for (const c of now) {
      if (st.cells.has(c)) continue;
      const d = st.dropped.get(c);
      if (d && d.ids.length && this.tick - d.T <= OFFER_TICKS) {
        st.pending.set(c, { T: d.T, since: this.tick });
        st.b.push(c, d.T);
        this.stats.offers++;
      } else {
        if (d) this.forget(conn, st, c);
        this.stats.entries++;
      }
    }
    st.cells = now;
    // (Dropped long enough ago that the client let it go: what the server kept of its having them goes too)
    for (const [c, d] of st.dropped) if (this.tick - d.T > CELL_HOLD_TICKS && !st.pending.has(c)) this.forget(conn, st, c);
    const cells = this.grid.get(system);
    const was = conn.shipView, view = new Set<number>([conn.playerId]);
    const take = (c: number) => { for (const id of cells?.get(c) ?? []) if (!st!.skip.has(id)) view.add(id); };
    for (const c of now) if (!st.pending.has(c)) take(c);
    for (const c of st.leaving) take(c);
    const left: number[] = [];
    for (const id of was) if (!view.has(id) && this.host.has(id) && InSystem.systemId[id] === system) left.push(id);
    conn.shipView = view;
    return left;
  }

  /** Answers to its pending cells, and the ones that waited too long */
  private answers(conn: ClientConnection, st: FocusState, now: ReadonlySet<number>): void {
    const r = st.replies;
    for (let i = 0; i + 2 < r.length; i += 3) {
      const c = r[i], T = r[i + 1], h = r[i + 2], p = st.pending.get(c);
      if (!p || p.T !== T) continue;
      st.pending.delete(c);
      this.settle(conn, st, c, T, h, now);
    }
    r.length = 0;
    const late = ANSWER_TICKS + 2 * Math.ceil((conn.ping || 0) / (1000 / 60));
    for (const [c, p] of st.pending) {
      if (this.tick - p.since <= late) continue;
      st.pending.delete(c);
      this.stats.refusedLate++;
      this.refuse(conn, st, c, p.T);
    }
  }

  /** A pending cell answered: its log if the hash agrees and it's smaller than an entry, otherwise it comes back as new */
  private settle(conn: ClientConnection, st: FocusState, c: number, T: number, h: number, now: ReadonlySet<number>): void {
    const d = st.dropped.get(c), rec = this.records.get(`${st.system}:${c}:${T}`);
    if (!h || !d || !rec) { this.stats.refusedNone++; return this.refuse(conn, st, c, T); }
    const mine: [number, number][] = [];
    for (const id of d.ids) { const m = rec.get(id); if (m) mine.push([id, m[1]]); }
    if (cellHash(mine) !== h) { this.stats.refusedHash++; return this.refuse(conn, st, c, T); }
    const ships: CellLogShip[] = [], back: [number, number][] = [];
    for (const id of d.ids) {
      const m = rec.get(id)!;
      // (Still on the path it had then, still here and in focus, not already back some other way)
      if (!this.host.has(id) || InSystem.systemId[id] !== st.system || conn.shipView.has(id) || this.host.runsBody(conn, id)) continue;
      const home = this.homes.get(id);
      if (home === undefined || !now.has(home) || st.pending.has(home)) continue;
      if (this.replication.versionOf(id) !== m[0]) continue;
      ships.push({ id, events: this.replication.eventsSince(id, T) });
      back.push([id, m[0]]);
    }
    const bytes = cellLogBytes(ships), entry = ships.length * CELL_ENTRY_BYTES;
    if (!ships.length || bytes >= entry) { if (ships.length) this.stats.refusedSize++; else this.stats.refusedNone++; return this.refuse(conn, st, c, T); }
    packCellLog(st.l, c, T, ships);
    for (const [id, v] of back) { st.restore.push([id, v]); st.skip.add(id); }
    st.dropped.delete(c);
    this.stats.logs++;
    this.stats.logShips += ships.length;
    this.stats.logBytes += bytes;
    this.stats.savedBytes += entry - bytes;
    for (const s of ships) this.stats.logEvents += s.events.length;
  }

  /** It comes back as new: the client forgets what it kept (`l` with none), the server what it knew it had */
  private refuse(conn: ClientConnection, st: FocusState, c: number, T: number): void {
    packCellLog(st.l, c, T, []);
    this.forget(conn, st, c);
    this.stats.entries++;
  }

  private forget(conn: ClientConnection, st: FocusState, c: number): void {
    const d = st.dropped.get(c);
    if (!d) return;
    st.dropped.delete(c);
    for (const id of d.ids) if (!conn.shipView.has(id)) { conn.shipSynced.delete(id); conn.shipHpSent.delete(id); }
  }

  /**
   * After its snapshot this round: cells leaving are dropped (their ships out of its view, kept on the client as of this
   * tick, their record made once for everyone), ships put back are known again, and the `cells` message goes
   */
  after(conn: ClientConnection): void {
    const st = conn.focus;
    if (!st) return;
    const d: number[] = [];
    const rows = this.host.rowsSent(conn);
    for (const c of st.leaving) {
      const rec = this.record(st.system, c);
      const ids: number[] = [];
      for (const [id, m] of rec) {
        if (!conn.shipView.has(id) || conn.repKnown.get(id) !== m[0] || this.host.runsBody(conn, id)) continue;
        ids.push(id);
        conn.shipView.delete(id);
        conn.repKnown.delete(id);
        conn.sentNames.delete(id);
        rows?.delete(id);
      }
      // (A cell dropped again before it was settled: its first drop is what the client still has... unless this one has ships)
      if (!ids.length) continue;
      st.dropped.set(c, { T: this.tick, ids });
      d.push(c, ids.length, ...ids);
      this.stats.drops++;
      this.stats.dropShips += ids.length;
    }
    for (const [id, v] of st.restore) conn.repKnown.set(id, v);
    if (d.length) conn.mapDotsDue = true;
    if (d.length || st.b.length || st.l.length) {
      this.host.send(conn, { type: 'cells', tick: this.tick, ...(d.length ? { d } : {}), ...(st.b.length ? { b: [...st.b] } : {}), ...(st.l.length ? { l: [...st.l] } : {}) });
    }
  }

  /** A cell's record at this tick: each ship's keyframe version and hash (made once, whoever drops it) */
  private record(system: number, c: number): Map<number, [number, number]> {
    const key = `${system}:${c}:${this.tick}`;
    let rec = this.records.get(key);
    if (rec) return rec;
    rec = new Map();
    for (const id of this.grid.get(system)?.get(c) ?? []) {
      const m = this.replication.cellMember(id);
      if (m) rec.set(id, [m.version, m.h]);
    }
    this.records.set(key, rec);
    return rec;
  }

  /**
   * Its ghosts (map-dot legs with its map closed): ships homed in its ring or pending cells, its party and its target,
   * none it holds
   */
  ghost(conn: ClientConnection): ((eid: number) => boolean) | null {
    const st = conn.focus;
    if (!st) return null;
    const party = new Set(this.host.partyOf(conn));
    const target = this.host.targetOf(conn.playerId);
    return (eid) => {
      if (conn.shipView.has(eid)) return false;
      if (party.has(eid) || eid === target) return true;
      const h = this.homes.get(eid);
      return h !== undefined && (st.ring.has(h) || st.pending.has(h) || st.cells.has(h));
    };
  }
}
