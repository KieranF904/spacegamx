/**
 * Decision inputs on the wire (CAPS.BODIES; common bodies/, docs/design/decision-inputs.md): each boss's decisions as
 * its brain took them (one log a boss, shared by every client), what each client runs, and its checks.
 *
 *   decide    a brain's decision at this tick, with the body state it leaves (the brain's own: read again at each
 *             snapshot for SYNCs and the checks)
 *   forClient a snapshot's decision rows for one client: a boss it can run now and doesn't yet gets a SYNC (and, with
 *             it, a keyframe: its known version is dropped); one it runs gets the decisions since its last snapshot;
 *             one it can't run any more (its body off, its target a ship it doesn't have, out of view) an OFF, and the
 *             old way from then (rows and keyframes: Replication.forClient asks `runs`)
 *   note      what its body check should say for this snapshot (the sum of each body's hash, common bodies/hash.ts)
 *   check     its check, judged: off, every boss it runs is synced again with the next snapshot
 *
 * A decision always takes effect on a tick no snapshot it went to has covered yet: it's taken during the tick, and
 * written into the snapshot after it (the tick layer is never late; only a client's drawing ahead of it can be).
 * A body is only as exact as what it reads: a target whose replica was off on a client this window (it gets a
 * keyframe of it) costs that client a keyframe of the boss too.
 */
import { DECISION, ENDED_OFF, BODY_KINDS, MOVES_HOLD, bodyHash, bodyCheckByte, syncArgs, unwrapTick12, type BodyState, type FlightBody, type MoveOrigin } from '@space-game/common';

/** Decisions kept a boss (ticks): longer than any client's snapshots are apart */
const KEEP_TICKS = 600;
/** Checks remembered per client (snapshots) */
const KEEP_CHECKS = 80;

export interface BodyNetHost {
  tick(): number;
  /** The boss's ship as it is now (null: gone) */
  body(eid: number): FlightBody | null;
  /** Is its ship still there */
  has(eid: number): boolean;
}

/** What a client sends of its bodies (CAPS.BODIES): the low byte of its hash sum as of a snapshot's tick */
export interface BodyCheckIn { hash: number; tick: number }

interface Boss {
  state: BodyState;
  log: number[][];
  /** The ships its body reads now, and those it stopped reading lately ([tick, id]: a pack's ship shot down, what a client made of it that window may be off) */
  reads: number[];
  dropped: [number, number][];
}
interface Client {
  /** Bosses it runs (synced, and not stopped since) */
  runs: Set<number>;
  /** The tick each was synced at (CAPS.MOVES: a move it works out is one decided after it) */
  since: Map<number, number>;
  /** The move shells it made itself (it works out the moves of the bodies it runs, CAPS.MOVES: no rows of them) */
  derived: Set<number>;
  /** The last snapshot tick it was sent decisions to */
  through: number;
  /** ...and the one before it: this snapshot's window, after forClient (readersOf) */
  from: number;
  expect: Map<number, number>;
  ticks: number[];
  fixedAt: number;
}

export class BodyNet {
  readonly stats = { decisions: 0, rows: 0, syncs: 0, offs: 0, targetKeyed: 0, checks: 0, agreed: 0, off: 0, stale: 0, unknown: 0, moveShells: 0, shellsDerived: 0 };
  private readonly bosses = new Map<number, Boss>();
  /**
   * Bodies whose ship is gone (out of `bosses`): their decisions' log while it was there, the tick it went (`gone`), and
   * the tick their OFF took effect (`at`: the first its moves weren't run; undefined till its brain lets go), for each
   * client still running them (forClient: what it hasn't had of the log, then the OFF)
   */
  private readonly ended = new Map<number, { gone: number; at?: number; log: number[][] }>();
  /** Move shells alive (CAPS.MOVES): whose, and the decision they came of */
  private readonly shells = new Map<number, { owner: number; origin: MoveOrigin }>();
  private readonly clients = new WeakMap<object, Client>();

  constructor(private readonly host: BodyNetHost) {}

  decide(eid: number, op: number, args: readonly number[], state: BodyState): void {
    let b = this.bosses.get(eid);
    if (!b) this.bosses.set(eid, (b = { state, log: [], reads: [], dropped: [] }));
    b.state = state;
    const reads = BODY_KINDS[state.kind]?.reads(eid, state) ?? [];
    for (const r of b.reads) if (!reads.includes(r)) b.dropped.push([this.host.tick(), r]);
    while (b.dropped.length && b.dropped[0][0] < this.host.tick() - KEEP_TICKS) b.dropped.shift();
    b.reads = reads;
    // (Its body off and its ship gone (despawned, blown apart: its brain let go): nothing more to send of it but that
    // OFF, the first tick its moves weren't run (`ended`: a client running it steps it to just before, not on to its
    // next snapshot). Its id may be another ship's later (entity ids are reused), so it's forgotten now, not when some
    // client's snapshot notices)
    if (op === DECISION.OFF && !this.host.has(eid)) {
      this.bosses.delete(eid);
      const now = this.host.tick(), was = this.ended.get(eid);
      // (its log moved here already if a snapshot found its ship gone first)
      if (was) { was.log.push(...b.log); was.at ??= now; } else this.ended.set(eid, { gone: now, at: now, log: b.log });
      return;
    }
    // (its id another ship's now: what the old one left is done with)
    if (this.host.has(eid)) this.ended.delete(eid);
    b.log.push([this.host.tick(), op, ...args]);
    this.stats.decisions++;
    const old = this.host.tick() - KEEP_TICKS;
    let n = 0;
    while (n < b.log.length && b.log[n][0] < old) n++;
    if (n) b.log.splice(0, n);
  }

  private client(conn: object): Client {
    let c = this.clients.get(conn);
    if (!c) this.clients.set(conn, (c = { runs: new Set(), since: new Map(), derived: new Set(), through: -Infinity, from: -Infinity, expect: new Map(), ticks: [], fixedAt: -Infinity }));
    return c;
  }

  // ---- Moves (decision-inputs stage 4, CAPS.MOVES: common bodies/moves) ----

  /**
   * Does this client work out what a body's move does (its look, its straight shells) itself: it runs the body's moves,
   * began running it before the decision `origin` came of, and the move is anyone's or its own pilot's (`self`)
   */
  derives(conn: object, self: number, eid: number, origin: MoveOrigin): boolean {
    const c = this.clients.get(conn);
    if (!c || !c.runs.has(eid) || (origin.who >= 0 && origin.who !== self)) return false;
    return origin.t > (c.since.get(eid) ?? Infinity);
  }

  /** A move's straight shell (GameServer.moveShot): its row goes only to the clients that don't make it themselves */
  moveShell(id: number, owner: number, origin: MoveOrigin): void {
    this.shells.set(id, { owner, origin });
    this.stats.moveShells++;
  }

  /** Is this shell's row one this client makes itself (a move's it works out, not sent it before) */
  shellDerived(conn: object, self: number, id: number, sent: boolean): boolean {
    const c = this.clients.get(conn);
    if (!c) return false;
    if (c.derived.has(id)) return true;
    const s = this.shells.get(id);
    if (!s || sent || !this.derives(conn, self, s.owner, s.origin)) return false;
    c.derived.add(id);
    this.stats.shellsDerived++;
    return true;
  }

  /** Shells gone (a snapshot round's removals, after every client's): forgotten */
  shellsGone(ids: Iterable<number>, conns: Iterable<object>): void {
    for (const id of ids) {
      if (!this.shells.delete(id)) continue;
      for (const conn of conns) this.clients.get(conn)?.derived.delete(id);
    }
  }

  /** Does this client run this boss's body (no rows or keyframes but its bodied shadow's: Replication.forClient) */
  runs(conn: object, eid: number): boolean {
    return this.clients.get(conn)?.runs.has(eid) ?? false;
  }

  /** Does this client run its body, one whose hits are told (a boss's: what a hit does is still its brain's, BodyKind.toldHits) */
  toldHits(conn: object, eid: number): boolean {
    if (!this.runs(conn, eid)) return false;
    const b = this.bosses.get(eid);
    return !!b && !!BODY_KINDS[b.state.kind]?.toldHits;
  }

  /**
   * One snapshot's decision rows for a client ([id, dt, op, ...args]). `view(id)`: in its view; its target must be,
   * or be itself. `known`: its keyframe versions (a boss it starts running is dropped from it: a keyframe goes with the
   * SYNC). `rekeyed(id)`: this snapshot brings it a keyframe of that ship (what it had of it this window was off): a
   * boss whose target that is gets one too, as its body read the target off
   */
  forClient(conn: object, self: number, systemOf: (eid: number) => number, systemId: number, known: Map<number, number>, tick: number, view: (eid: number) => boolean, rekeyed?: (eid: number) => boolean): number[][] {
    const c = this.client(conn), rows: number[][] = [];
    // (In its view now: a ship leaving it this snapshot (known, not in view) is gone from the client from here, so a
    // body reading it would fly blind from this tick: off now, with a keyframe, not a keyframe every snapshot it stays out)
    const holds = (id: number) => id === self || view(id);
    for (const [eid, b] of this.bosses) {
      if (!this.host.has(eid)) {
        this.bosses.delete(eid);
        // (its ship gone before its brain let go (that comes next tick: its moves ran this one), or its body put off while
        // its ship was still there: its OFF then)
        const at = b.state.on ? undefined : lastOff(b.log);
        const log = at === undefined ? b.log : b.log.filter((d) => d[0] < at), was = this.ended.get(eid);
        if (was) { was.log.push(...log); was.at ??= at; } else this.ended.set(eid, { gone: this.host.tick(), at, log });
        continue;
      }
      const s = b.state, kind = BODY_KINDS[s.kind];
      const runs = c.runs.has(eid);
      if (!runs && (!s.on || systemOf(eid) !== systemId)) continue;
      // (Every ship its body reads held: its target, a pack's other ships)
      const reads = kind?.reads(eid, s) ?? [];
      // (A pack's ship it reads shot down while it runs it: what it made of it this window was off, so it goes again with
      // a keyframe; its next order no longer reads it. One alive out of view: off, as for any read it doesn't hold)
      const gone = runs && kind?.pilot ? reads.filter((r) => r !== s.target && !this.host.has(r)) : [];
      const can = !!kind && s.on && systemOf(eid) === systemId && view(eid) && reads.every((r) => holds(r) || gone.includes(r));
      if (can && runs && (gone.length || b.dropped.some(([t, r]) => t > c.through && (!this.host.has(r) || !holds(r))))) { rekey(known, eid); this.stats.targetKeyed++; }
      if (can && !runs) {
        rows.push([eid, 0, DECISION.SYNC, ...syncArgs(s)]);
        // (its drive EMP'd or slowed now: a SYNC clears that, so it goes after)
        if ((s.empUntil ?? 0) > tick || (s.slowUntil ?? 0) > tick) rows.push([eid, 0, DECISION.STATUS, Math.max(0, (s.empUntil ?? 0) - tick), Math.max(0, (s.slowUntil ?? 0) - tick)]);
        // (its moves held or stopped now, a custom enemy's pieces gone as its moves read them: a SYNC says nothing of those, CAPS.MOVES)
        if ((s.hold ?? MOVES_HOLD.RUN) !== MOVES_HOLD.RUN) rows.push([eid, 0, DECISION.HOLD, s.hold!]);
        if (s.gone !== undefined) rows.push([eid, 0, DECISION.GONE, s.gone]);
        rekey(known, eid);
        c.runs.add(eid);
        c.since.set(eid, tick);
        this.stats.syncs++;
      } else if (can) {
        // (a ship it reads was off on this client this window: so was what its body made of it)
        // (one it stopped reading this window too: a target lost or swapped since the last snapshot was read till then)
        if (rekeyed && (reads.some(rekeyed) || b.dropped.some(([t, r]) => t > c.through && rekeyed(r)))) { rekey(known, eid); this.stats.targetKeyed++; }
        for (const d of b.log) {
          if (d[0] <= c.through) continue;
          if (d[0] > tick) break;
          rows.push([eid, d[0] - tick, ...d.slice(1)]);
        }
      } else if (runs) {
        rows.push([eid, 0, DECISION.OFF]);
        c.runs.delete(eid);
        this.stats.offs++;
      }
    }
    // (A body it runs whose ship is gone: what it decided since this client's last snapshot, its ship there still; then
    // its OFF at its tick, ENDED_OFF so it's that decision, not this client's OFF at the snapshot (the window's ticks
    // before it are still stepped: the server ran its moves on those). Not let go yet: its moves ran through this tick,
    // and the ship's removal in this snapshot ends the run)
    for (const [eid, { gone, at, log }] of this.ended) {
      // (its id another ship's already: nothing of the old body goes to anyone, as if forgotten at once)
      if (gone < tick - KEEP_TICKS || this.host.has(eid)) { this.ended.delete(eid); continue; }
      if (!c.runs.has(eid)) continue;
      for (const d of log) if (d[0] > c.through && d[0] <= tick) rows.push([eid, d[0] - tick, ...d.slice(1)]);
      if (at !== undefined && at > c.through && at <= tick) { rows.push([eid, at - tick, DECISION.OFF, ENDED_OFF]); this.stats.offs++; }
      c.runs.delete(eid);
    }
    for (const eid of c.runs) if (!this.bosses.has(eid)) c.runs.delete(eid);
    c.from = c.through;
    c.through = tick;
    this.stats.rows += rows.length;
    return rows;
  }

  /** Bodies it runs that read a ship in these keyframes and aren't in them themselves */
  readersOf(conn: object, self: number, keyed: readonly (readonly number[])[]): number[] {
    const c = this.clients.get(conn), out: number[] = [];
    if (!c?.runs.size) return out;
    const ids = new Set(keyed.map((k) => k[0]));
    for (const eid of c.runs) {
      const b = this.bosses.get(eid);
      if (!b || ids.has(eid)) continue;
      // (or read it this window: a target lost or swapped since the last snapshot)
      if (BODY_KINDS[b.state.kind]?.reads(eid, b.state).some((r) => ids.has(r)) || b.dropped.some(([t, r]) => t > c.from && ids.has(r))) { out.push(eid); this.stats.targetKeyed++; }
    }
    return out;
  }

  /** A snapshot went to it: what its check should say for it (nothing if it runs no body) */
  note(conn: object, tick: number): void {
    const c = this.clients.get(conn);
    if (!c?.runs.size) return;
    let sum = 0;
    for (const eid of c.runs) {
      const b = this.bosses.get(eid), body = this.host.body(eid);
      if (b && body) sum = (sum + bodyHash(eid, body, b.state)) >>> 0;
    }
    c.expect.set(tick, bodyCheckByte(sum));
    c.ticks.push(tick);
    while (c.ticks.length > KEEP_CHECKS) c.expect.delete(c.ticks.shift()!);
  }

  /** Its check (on an input): off, every boss it runs is synced again with its next snapshot */
  check(conn: object, chk: BodyCheckIn): void {
    const c = this.clients.get(conn);
    this.stats.checks++;
    if (!c) { this.stats.unknown++; return; }
    const tick = unwrapTick12(chk.tick & 0xfff, this.host.tick());
    if (tick <= c.fixedAt) { this.stats.stale++; return; }
    const want = c.expect.get(tick);
    if (want === undefined) { this.stats.unknown++; return; }
    if (want === (chk.hash & 0xff)) { this.stats.agreed++; return; }
    this.stats.off++;
    c.fixedAt = this.host.tick();
    c.runs.clear();
  }

  /** Every boss it runs synced again with its next snapshot */
  resync(conn: object): void {
    this.clients.get(conn)?.runs.clear();
  }

}

/** The tick of the newest OFF in a body's log (undefined: none kept) */
function lastOff(log: readonly (readonly number[])[]): number | undefined {
  for (let i = log.length - 1; i >= 0; i--) if (log[i][1] === DECISION.OFF) return log[i][0];
  return undefined;
}

/**
 * A keyframe of this ship goes with the snapshot: its known version set to one no ship has (0), so it is still a ship
 * the client has (a contact with it needs no keyframe of its own ship: Replication.ownFor)
 */
function rekey(known: Map<number, number>, eid: number): void {
  if (known.has(eid)) known.set(eid, 0);
}
