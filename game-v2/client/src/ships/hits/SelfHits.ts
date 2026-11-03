/**
 * Client-detected hits (docs/design/confirmed-hits.md part D, CAPS.SELF_HITS). A client that has it finds its shells'
 * hits on ships itself, on its tick-faithful layer, as each snapshot arrives, and tells the server only a one-byte hash
 * of what it found (on its inputs). The server compares with its own; when they agree it sends nothing for those hits.
 *
 * The tick-faithful layer, per snapshot window (the ticks after the last snapshot up to this one's):
 *   shells   each straight shell from a gun, from its spawn, moved a tick at a time as the server moves it (f32 sums,
 *            Position += Velocity), its line each tick the server's: from where it is to one step on
 *   ships    each ship's exact state at the tick (its replica, ShipReplicaSet.at): a pilot's after its move that tick,
 *            anyone else's from the tick before (pilotless ships move after the collision step), as f32
 *   the cast the server's (common hitRules.ts shipSegmentHit), against the ship as this client has it; who may hurt
 *            whom by the server's rule (sidesHurt)
 *
 * It leaves alone what it can't have exactly, and the server tells those (as records): its own ship, debris, a ship
 * synced in this frame (rebuilt: its shape changed mid-window) or keyframed (its path did), shells the snapshot removed (rock, expiry, point
 * defence: their end tick isn't known), shells that don't fly straight or arm late, two pilots' fights.
 *
 * The hit chain: each hit (found or told) adds hitHash(shell, ship, part) to a sum. At a snapshot whose hits changed
 * it, the low byte goes up on the next input (or on its own after REPORT_WAIT input ticks). A correction (hitFix) says
 * what the server had: hits missed are drawn, ships hit wrongly get their HP again, and the chain becomes the server's
 * plus this client's hits since.
 */
import {
  hitHash, chainAdd, shipSegmentHit, sidesHurt, SIDE, gunShell, firesStraight, unpackHits, shellGone,
  type HitCtx, type HitReport, type ShipState, type ServerHitFixMessage, type WeaponTuning,
} from '@space-game/common';
import type { HitDone, OwnHit } from './ConfirmedHits';

/** A shell on the tick-faithful layer */
interface Shell {
  owner: number;
  /** Its gun's tuning (pierce, straightness) */
  def: WeaponTuning;
  /** The tick its line counts from (where it is at that tick's end: spawn) */
  spawnTick: number;
  /** Where it is at the end of tick `at` (f32, as the server keeps it) and its step a tick (f32) */
  px: number;
  py: number;
  at: number;
  vx: number;
  vy: number;
  /** Ships it has passed through (a pierce's exclusions) */
  hit: Set<number> | null;
  /** Spent (its last hit ended it) */
  dead: boolean;
  /** Hits found on it this window (its passes: ConfirmedHits' count before the window, plus these) */
  win: number;
}

export interface SelfHitsHost {
  /** The ships (ShipStore) */
  readonly store: HitCtx & { get(id: number): ShipState | undefined };
  /** This client's own ship */
  self(): number;
  /** The ships it could find hits on (replicated, in view) */
  ships(): Iterable<number>;
  /** A ship's exact state at the end of a tick (its replica), null if it has none */
  at(id: number, tick: number): { x: number; y: number; angle: number } | null;
  /** A ship's side, as this client knows it (hitRules.ts SIDE bits) */
  side(id: number): number;
  /** A shell's pass count so far (ConfirmedHits.passesOf) */
  passes(shell: number): number;
}

/** A hit in the chain, kept a while for a correction: its HP change, to take back if the server never had it */
export interface LogEntry { tick: number; shell: number; target: number; part: number; h: number; undo: HitDone['undo'] }

/** Input ticks a report may wait for an input to ride on before it goes on its own */
export const REPORT_WAIT = 6;
/** ...and at least this many between two reports riding on inputs (the chain covers the snapshots between) */
const REPORT_MIN = 6;
/** Hits kept for a correction to be compared against (ticks) */
const LOG_TICKS = 600;
/** A shell no snapshot has removed is let go after this many ticks */
const SHELL_TICKS = 1200;

export class SelfHits {
  /** On (the server's netCaps said so) */
  on = false;
  private shells = new Map<number, Shell>();
  /** Shells dropped (told the old way) until their removal */
  private dropped = new Set<number>();
  /** The last snapshot's tick: the next window starts after it */
  private lastTick = -1;
  /** This frame: ships synced (their shape changed), shells the snapshot removed */
  private synced = new Set<number>();
  private removed = new Set<number>();
  /** The chain, the hits that made it (for a correction), and the correction count */
  chain = 0;
  private log: LogEntry[] = [];
  private epoch = 0;
  /** The report to send (the snapshot's tick it's as of), and input ticks it has waited */
  private report: HitReport | null = null;
  private waited = 0;
  /** Input ticks since the last report went */
  private since = 0;
  /** A correction came: report even if the chain didn't change */
  private reportDue = false;
  private snapTick = 0;
  readonly stats = { windows: 0, found: 0, reports: 0, fixes: 0, fixMissed: 0, fixWrong: 0 };

  constructor(private host: SelfHitsHost) {}

  /**
   * Switched on or off (netCaps): on, everything starts afresh from the last snapshot, as the server's journal does.
   * Shells already flying sit it out (what they hit before isn't known here): the server tells their hits (HitLedger
   * endSnapshot), as for a shell told the old way
   */
  setOn(on: boolean, lastTick: number): void {
    if (on === this.on) return;
    this.on = on;
    if (on) {
      for (const id of this.shells.keys()) this.dropped.add(id);
      this.shells.clear();
    }
    this.chain = 0;
    this.epoch = 0;
    this.log = [];
    this.report = null;
    this.reportDue = false;
    this.lastTick = lastTick;
  }

  /** A connection afresh (a join) */
  reset(): void {
    this.on = false;
    this.shells.clear();
    this.dropped.clear();
    this.synced.clear();
    this.removed.clear();
    this.chain = 0;
    this.epoch = 0;
    this.log = [];
    this.report = null;
    this.lastTick = -1;
  }

  /**
   * A shell it was told of (a projectile row from a gun, or a fire event's, rebuilt): (x, y) where it is at the end of
   * `spawnTick`, (vx, vy) its step. Only straight shells from a gun of a ship it has; once
   */
  addShell(id: number, owner: number, gun: number, spawnTick: number, x: number, y: number, vx: number, vy: number, size = 1): void {
    // (The same shell told again stays as it is; an id the server used again, after its shell went unseen here, is a new shell)
    if (this.shells.get(id)?.spawnTick === spawnTick || !(gun >= 0) || this.dropped.has(id)) return;
    const ship = this.host.store.get(owner);
    const sh = ship ? gunShell(this.host.store.tuning, ship, gun) : null;
    // (a great slow orb hits as wide as it's drawn: the server tells those)
    if (!sh || !firesStraight(sh.def) || sh.def.lob || sh.def.arm || size * 5 >= 19.95) return;
    this.shells.set(id, { owner, def: sh.def, spawnTick, px: Math.fround(x), py: Math.fround(y), at: spawnTick, vx: Math.fround(vx), vy: Math.fround(vy), hit: null, dead: false, win: 0 });
  }

  /**
   * A shell told the old way (a projectileHit not from these hits): what it passed through isn't known here, so it's
   * dropped; the server tells its hits from now on (HitLedger oldWayShells)
   */
  drop(id: number): void {
    this.shells.delete(id);
    // (its row may come again: it stays out)
    this.dropped.add(id);
  }

  /**
   * Shells spent by a hit (found, told or corrected: no removal names them): gone from the layer, so their ids are
   * free for new shells (the server uses ids again)
   */
  spent(ids: readonly number[]): void {
    for (const id of ids) { this.shells.delete(id); this.dropped.delete(id); }
  }

  /** A ship synced this frame (a rebuild, or new to this client): left to the server's records this window */
  onSync(id: number): void {
    this.synced.add(id);
  }

  /**
   * Ships keyframed by the snapshot (their path changed in the window: a boss's drive, a knock): where they were on the
   * ticks before it isn't known exactly, so they're left to the server's records this window
   */
  onKeyframes(rows: readonly (readonly number[])[] | undefined): void {
    if (rows) for (const r of rows) this.synced.add(r[0]);
  }

  /** The snapshot's removed list (before it's applied): those shells sit this window out, and go */
  onRemoved(ids: readonly number[]): void {
    for (const id of ids) this.removed.add(id);
  }

  /**
   * The snapshot at `tick` is in (its replicas, rows and removals): the hits on the ticks since the last one, in tick
   * then shell order
   */
  detect(tick: number): OwnHit[] {
    const out: OwnHit[] = [];
    const from = this.lastTick;
    this.lastTick = tick;
    this.snapTick = tick;
    if (this.on && from >= 0 && tick > from && tick - from <= 120) {
      this.stats.windows++;
      const { store } = this.host, me = this.host.self();
      const targets: number[] = [];
      for (const id of this.host.ships()) {
        const s = store.get(id);
        if (id !== me && s && s.kind !== 'debris' && !this.synced.has(id)) targets.push(id);
      }
      const ids = [...this.shells.keys()].sort((a, b) => a - b);
      for (const s of this.shells.values()) s.win = 0;
      for (let k = from + 1; k <= tick; k++) {
        for (const id of ids) {
          const s = this.shells.get(id)!;
          if (s.dead || this.removed.has(id) || k <= s.spawnTick) continue;
          // (Moved as the server moves it, a tick at a time in f32)
          while (s.at < k) { s.px = Math.fround(s.px + s.vx); s.py = Math.fround(s.py + s.vy); s.at++; }
          if (k - s.spawnTick > SHELL_TICKS) { s.dead = true; continue; }
          const x0 = s.px, y0 = s.py, x1 = x0 + s.vx, y1 = y0 + s.vy;
          let best = -1, bp = -1, bt = Infinity;
          const sideA = this.host.side(s.owner);
          for (const t of targets) {
            if (t === s.owner || s.hit?.has(t) || sidesHurt(sideA, this.host.side(t)) !== 1) continue;
            const ship = store.get(t)!;
            const pose = this.host.at(t, this.host.side(t) & SIDE.PILOT ? k : k - 1);
            if (!pose) continue;
            const h = shipSegmentHit(store, ship, Math.fround(pose.x), Math.fround(pose.y), Math.fround(pose.angle), x0, y0, x1, y1);
            if (h && h.t < bt) { bt = h.t; best = t; bp = h.part; }
          }
          if (best < 0) continue;
          out.push({ shell: id, tick: k, target: best, part: bp, x: x0 + (x1 - x0) * bt, y: y0 + (y1 - y0) * bt });
          (s.hit ??= new Set()).add(best);
          // (spent when its passes are used up: hitRules.ts shellGone, as the server's onShipHit)
          if (shellGone(s.def, this.host.passes(id) + s.win++)) s.dead = true;
          this.stats.found++;
        }
      }
    }
    for (const id of this.removed) { this.shells.delete(id); this.dropped.delete(id); }
    if (this.dropped.size > 512) this.dropped.clear();
    this.removed.clear();
    this.synced.clear();
    // (shells long gone without a removal: let go)
    if (this.shells.size > 256) for (const [id, s] of this.shells) if (s.dead || tick - s.spawnTick > SHELL_TICKS) this.shells.delete(id);
    return out;
  }

  /** The frame's end: the hits this frame came to (found and told) go into the chain; a report if it changed */
  settle(done: readonly HitDone[]): void {
    if (!this.on) return;
    let changed = this.reportDue;
    for (const d of done) {
      const h = hitHash(d.shell, d.target, d.part);
      this.chain = chainAdd(this.chain, h);
      this.log.push({ tick: d.tick, shell: d.shell, target: d.target, part: d.part, h, undo: d.undo });
      const s = this.shells.get(d.shell);
      if (s) {
        (s.hit ??= new Set()).add(d.target);
        if (d.gone) s.dead = true;
      }
      changed = true;
    }
    if (this.log.length > 64 && this.log[0].tick < this.snapTick - LOG_TICKS) this.log = this.log.filter((e) => e.tick >= this.snapTick - LOG_TICKS);
    if (changed) {
      this.reportDue = false;
      if (!this.report) this.waited = 0;
      this.report = { tick: this.snapTick, hash: this.chain & 0xff, epoch: this.epoch };
    }
  }

  /**
   * The report for this input tick: when an input goes anyway (`riding`), or when it has waited REPORT_WAIT input
   * ticks for one (then the input goes for it). Undefined: nothing to say
   */
  takeReport(riding: boolean): HitReport | undefined {
    this.since++;
    if (!this.report) return undefined;
    // (at most one every REPORT_MIN input ticks: the chain covers the snapshots between)
    if (++this.waited < REPORT_WAIT && !(riding && this.since >= REPORT_MIN)) return undefined;
    const r = this.report;
    this.report = null;
    this.waited = 0;
    this.since = 0;
    this.stats.reports++;
    return r;
  }

  /**
   * A correction (hitFix): the server's hits after `s` up to `t`. Returns the ones this client missed (to work out
   * now, HP and all, as records) and the hits it had in that span that the server didn't (to take back)
   */
  fix(msg: ServerHitFixMessage): { missed: ReturnType<typeof unpackHits>; wrong: LogEntry[] } {
    const recs = unpackHits(msg.h);
    const key = (s: number, t: number, p: number) => s + ':' + t + ':' + p;
    const theirs = new Set(recs.map((r) => key(r.shell, r.target, r.part)));
    // (a hit it has a tick or two either side of the span is the same hit: not missed)
    const mine = new Set(this.log.map((e) => key(e.shell, e.target, e.part)));
    const wrong = this.log.filter((e) => e.tick > msg.s && e.tick <= msg.t && !theirs.has(key(e.shell, e.target, e.part)));
    const missed = recs.filter((r) => !mine.has(key(r.shell, r.target, r.part)));
    // The chain: the server's as of t, plus this client's hits since (bar any the server's list already has)
    let c = msg.c >>> 0;
    const keep: LogEntry[] = [];
    for (const e of this.log) {
      if (e.tick <= msg.t || theirs.has(key(e.shell, e.target, e.part))) continue;
      c = chainAdd(c, e.h);
      keep.push(e);
    }
    this.log = keep;
    this.chain = c;
    this.epoch = msg.e & 3;
    this.reportDue = true;
    // (a shell it missed the end of is spent here too)
    for (const r of missed) {
      const s = this.shells.get(r.shell);
      if (s) { (s.hit ??= new Set()).add(r.target); if (r.gone) s.dead = true; }
    }
    this.stats.fixes++;
    this.stats.fixMissed += missed.length;
    this.stats.fixWrong += wrong.length;
    return { missed, wrong };
  }
}
