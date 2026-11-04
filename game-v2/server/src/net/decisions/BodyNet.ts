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
import { DECISION, BODY_KINDS, bodyHash, bodyCheckByte, syncArgs, unwrapTick12, type BodyState, type FlightBody } from '@space-game/common';

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

interface Boss { state: BodyState; log: number[][] }
interface Client {
  /** Bosses it runs (synced, and not stopped since) */
  runs: Set<number>;
  /** The last snapshot tick it was sent decisions to */
  through: number;
  expect: Map<number, number>;
  ticks: number[];
  fixedAt: number;
}

export class BodyNet {
  readonly stats = { decisions: 0, rows: 0, syncs: 0, offs: 0, targetKeyed: 0, checks: 0, agreed: 0, off: 0, stale: 0, unknown: 0 };
  private readonly bosses = new Map<number, Boss>();
  private readonly clients = new WeakMap<object, Client>();

  constructor(private readonly host: BodyNetHost) {}

  decide(eid: number, op: number, args: readonly number[], state: BodyState): void {
    let b = this.bosses.get(eid);
    if (!b) this.bosses.set(eid, (b = { state, log: [] }));
    b.state = state;
    // (Its body off and its ship gone (despawned, blown apart: its brain let go): nothing more to send of it. Its id may
    // be another ship's later (entity ids are reused), so it's forgotten now, not when some client's snapshot notices)
    if (op === DECISION.OFF && !this.host.has(eid)) { this.bosses.delete(eid); return; }
    b.log.push([this.host.tick(), op, ...args]);
    this.stats.decisions++;
    const old = this.host.tick() - KEEP_TICKS;
    let n = 0;
    while (n < b.log.length && b.log[n][0] < old) n++;
    if (n) b.log.splice(0, n);
  }

  private client(conn: object): Client {
    let c = this.clients.get(conn);
    if (!c) this.clients.set(conn, (c = { runs: new Set(), through: -Infinity, expect: new Map(), ticks: [], fixedAt: -Infinity }));
    return c;
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
  forClient(conn: object, self: number, systemOf: (eid: number) => number, systemId: number, known: Map<number, number>, tick: number, view: (eid: number) => boolean, rekeyed?: (eid: number) => boolean, pilots = false): number[][] {
    const c = this.client(conn), rows: number[][] = [];
    const holds = (id: number) => id === self || known.has(id) || view(id);
    for (const [eid, b] of this.bosses) {
      if (!this.host.has(eid)) { this.bosses.delete(eid); c.runs.delete(eid); continue; }
      const s = b.state, kind = BODY_KINDS[s.kind];
      const runs = c.runs.has(eid);
      if (!runs && (!s.on || systemOf(eid) !== systemId)) continue;
      // (Every ship its body reads held: its target, a pack's other ships. The enemy AI's pilots only with CAPS.PILOTS)
      const reads = kind?.reads(eid, s) ?? [];
      const can = !!kind && s.on && (pilots || !kind.pilot) && systemOf(eid) === systemId && view(eid) && reads.every(holds);
      if (can && !runs) {
        rows.push([eid, 0, DECISION.SYNC, ...syncArgs(s)]);
        rekey(known, eid);
        c.runs.add(eid);
        this.stats.syncs++;
      } else if (can) {
        // (a ship it reads was off on this client this window: so was what its body made of it)
        if (rekeyed && reads.some(rekeyed)) { rekey(known, eid); this.stats.targetKeyed++; }
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
    for (const eid of c.runs) if (!this.bosses.has(eid)) c.runs.delete(eid);
    c.through = tick;
    this.stats.rows += rows.length;
    return rows;
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

  /**
   * It no longer runs bodies (its caps switched off CAPS.BODIES, or OWN_SIM: the client stopped every body, BodyRunner.
   * setOn): it runs none here either, so its rows and keyframes come the old way, its hits aren't 'body' ones, and when
   * the cap comes back each boss starts with a SYNC again
   */
  drop(conn: object): void {
    const c = this.clients.get(conn);
    if (!c?.runs.size) return;
    c.runs.clear();
    c.expect.clear();
    c.ticks.length = 0;
  }
}

/**
 * A keyframe of this ship goes with the snapshot: its known version set to one no ship has (0), so it is still a ship
 * the client has (a contact with it needs no keyframe of its own ship: Replication.ownFor)
 */
function rekey(known: Map<number, number>, eid: number): void {
  if (known.has(eid)) known.set(eid, 0);
}
