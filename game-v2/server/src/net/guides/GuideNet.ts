/**
 * Homing shells and mobs on clients' tick layers (CAPS.WAYPOINTS; common guidance/, docs/design/awareness-model.md 6.3): the
 * waypoint records the server's planner made (one log a shell, shared by every client), which clients run which
 * shells, and in which mode.
 *
 *   record     a planner's record at a tick (Weapons: WP, NEXT, LOST)
 *   forClient  a snapshot's guide rows for one client: a shell within its range that it doesn't run yet gets a SYNC
 *              (its state and guide as this tick ended); one it runs gets, for the window since its last snapshot, its
 *              mode (MODE when it changes) and, in "sent" mode, the window's WP and NEXT records; LOST and TARGET always; one
 *              out of range an OFF
 *   heldSum    what its running shells add to its own check (OwnChecks; off: resync, every one SYNCed again)
 *
 * The mode of a window is "derived" (the client plans the waypoints itself from its replica of the target) only when
 * it held the target through the whole window: at its last snapshot and now, and not keyframed in this one (what it
 * had of it was off). Otherwise "sent". Both give the same waypoints, so a switch never moves the shell.
 */
import { GUIDE, MODE_DERIVED, MODE_SENT, guideFirst, guideHash, guideSyncArgs, type Guide, type GuideBody } from '@space-game/common';

/** Records kept a shell (ticks): longer than any client's snapshots are apart */
const KEEP_TICKS = 600;

/** What flies by the waypoint law (Weapons' homing shells, Mobs): every one, and each one's motion and birth */
export interface GuideSource {
  guided(): Iterable<[number, Guide]>;
  /** Its motion now (null: not one of these, gone, or dead this tick) */
  guideBody(eid: number): GuideBody | null;
  /** The tick it was made (an entity id is reused: a new one in an old one's id is another) */
  guideBorn(eid: number): number;
}

export interface GuideNetHost {
  tick(): number;
  sources(): readonly GuideSource[];
  systemOf(eid: number): number;
}

interface Run { mode: number; held: boolean; born: number }
interface Log { born: number; recs: number[][] }
interface Client { runs: Map<number, Run>; through: number }

/** What forClient asks of the client's view */
export interface GuideView {
  self: number;
  systemId: number;
  /** In range of it (the projectile rows' range) */
  near(eid: number): boolean;
  /** It holds this ship (a replica on its tick layer) */
  holds(eid: number): boolean;
  /** This snapshot brings it a keyframe of that ship (what it had of it this window was off) */
  rekeyed(eid: number): boolean;
}

export class GuideNet {
  readonly stats = { records: 0, rows: 0, syncs: 0, offs: 0, modes: 0, sent: 0, resyncs: 0 };
  private readonly logs = new Map<number, Log>();
  private readonly clients = new WeakMap<object, Client>();

  constructor(private readonly host: GuideNetHost) {}

  /** Its source's word on it (the first that has it) */
  private body(eid: number): GuideBody | null {
    for (const src of this.host.sources()) { const b = src.guideBody(eid); if (b) return b; }
    return null;
  }
  private born(eid: number): number {
    for (const src of this.host.sources()) if (src.guideBody(eid)) return src.guideBorn(eid);
    return -1;
  }

  record(eid: number, tick: number, op: number, args: readonly number[]): void {
    const born = this.born(eid);
    let log = this.logs.get(eid);
    if (!log || log.born !== born) this.logs.set(eid, (log = { born, recs: [] }));
    const recs = log.recs;
    recs.push([tick, op, ...args]);
    this.stats.records++;
    let n = 0;
    while (n < recs.length && recs[n][0] < tick - KEEP_TICKS) n++;
    if (n) recs.splice(0, n);
  }

  private client(conn: object): Client {
    let c = this.clients.get(conn);
    if (!c) this.clients.set(conn, (c = { runs: new Map(), through: -Infinity }));
    return c;
  }

  /** Does this client run this shell (no rows of it after its first) */
  runs(conn: object, eid: number): boolean {
    return this.clients.get(conn)?.runs.has(eid) ?? false;
  }

  /** Every shell as this tick ended, gathered once for every client's snapshot */
  private list: { eid: number; g: Guide; born: number; body: GuideBody | null; system: number }[] = [];
  private listTick = -1;
  private shells(tick: number) {
    if (this.listTick === tick) return this.list;
    this.listTick = tick;
    this.list = [];
    for (const src of this.host.sources()) for (const [eid, g] of src.guided()) this.list.push({ eid, g, born: src.guideBorn(eid), body: src.guideBody(eid), system: this.host.systemOf(eid) });
    return this.list;
  }

  /** One snapshot's guide rows for a client ([id, dt, op, ...args]); `active`: it runs one (a snapshot must go) */
  forClient(conn: object, v: GuideView, tick: number): { rows: number[][]; active: boolean } {
    const c = this.client(conn), rows: number[][] = [], seen = new Set<number>();
    for (const { eid, g, born, body, system } of this.shells(tick)) {
      let run = c.runs.get(eid);
      // (its id was another shell's: that one is gone, this one is new to it)
      if (run && run.born !== born) { c.runs.delete(eid); run = undefined; }
      if (!body || system !== v.systemId || !v.near(eid)) {
        if (run && body) { rows.push([eid, 0, GUIDE.OFF]); this.stats.offs++; c.runs.delete(eid); }
        continue;
      }
      seen.add(eid);
      const t = g.target, held = t < 0 || t === v.self || v.holds(t);
      if (!run) {
        rows.push([eid, 0, GUIDE.SYNC, ...guideSyncArgs(body, g, !held, tick)]);
        c.runs.set(eid, { mode: held ? MODE_DERIVED : MODE_SENT, held, born });
        this.stats.syncs++;
        continue;
      }
      const mode = held && run.held && !(t >= 0 && v.rekeyed(t)) ? MODE_DERIVED : MODE_SENT;
      if (mode !== run.mode) { rows.push([eid, c.through + 1 - tick, GUIDE.MODE, mode]); run.mode = mode; this.stats.modes++; }
      run.held = held;
      const log = this.logs.get(eid);
      if (log?.born === born) for (const d of log.recs) {
        if (d[0] <= c.through) continue;
        if (d[0] > tick) break;
        // (a lost target and a brain's new one go to everyone; waypoints only to those in sent mode)
        if (!guideFirst(d[1]) && mode !== MODE_SENT) continue;
        rows.push([eid, d[0] - tick, ...d.slice(1)]);
        if (!guideFirst(d[1])) this.stats.sent++;
      }
    }
    for (const eid of c.runs.keys()) if (!seen.has(eid)) c.runs.delete(eid);
    c.through = tick;
    this.stats.rows += rows.length;
    return { rows, active: c.runs.size > 0 };
  }

  /** What its running shells add to its own check (each as this tick ended: guideHash) */
  heldSum(conn: object): number {
    const c = this.clients.get(conn);
    let sum = 0;
    if (c) for (const eid of c.runs.keys()) {
      const b = this.body(eid);
      if (b) sum = (sum + guideHash(eid, b)) >>> 0;
    }
    return sum;
  }

  /** Its check was off: every shell it runs SYNCed again with its next snapshot */
  resync(conn: object): void {
    const c = this.clients.get(conn);
    if (c?.runs.size) { c.runs.clear(); this.stats.resyncs++; }
  }

  /** It no longer runs shells (its caps switched off CAPS.WAYPOINTS): rows again, and SYNCs when it comes back */
  drop(conn: object): void {
    this.clients.get(conn)?.runs.clear();
  }

  /** Logs of shells that are gone */
  sweep(): void {
    for (const eid of this.logs.keys()) if (!this.body(eid)) this.logs.delete(eid);
  }
}
