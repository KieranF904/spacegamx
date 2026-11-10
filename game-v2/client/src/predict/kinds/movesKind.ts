/**
 * @contract client.predict.kind.moves
 * owns:       bodies' moves (boss attacks) on the PT timeline: a MoveRunner fork per body, looks queued to the body's draw tick, shells drawn ahead
 * needs:      @space-game/common, MoveRunner (TimedMoveMsg), ptKinds (hash helpers)
 * invariants: a miss against ST re-forks from c - FORK_BACK and steps to the head once; looks already shown are not shown twice — client/src/predict/kindInvariants.test.ts
 * extend:     a new move look or shell type is handled where the MoveRunner outputs it; the kind is registered in worldKinds.ts
 */
/**
 * Bodies' moves on the PT timeline (boss attacks, custom enemies' moves: telegraphs, beams, windows, their straight
 * shells). The snapshots' MoveRunner (ST) works each body's moves out through the confirmed tick; this kind keeps a
 * fork of each body's moves (MoveRunner with `from`/`only`) stepped on to the PT head, so a move's looks are drawn
 * when the body (drawn at its PT tick) gets to them and its shells leave the body where it's drawn.
 *
 *   advance   each fork stepped to the head; its looks queued and shown as the body's draw tick reaches their tick,
 *             its shells handed to the drawing as predicted shells at once (drawn from their spawn tick on the body's
 *             timeline), every output recorded by tick
 *   ST        the snapshots' outputs (stRows at the snapshot, stMsgs at the frame's end), recorded by tick; a look PT
 *             already showed isn't shown again; one it didn't is shown late (aged by how late); an ST shell is the
 *             server's copy of a predicted one (WeaponFx claims it) or new (late)
 *   confirm   each body's PT outputs in (last c, c] against ST's by hash; a miss (a decision PT couldn't know: a new
 *             move, a cap, a window; or a body PT had elsewhere) makes the fork afresh from c - FORK_BACK and steps it
 *             to the head once: its looks not yet shown are shown (late if their tick is past), its shells that the
 *             old fork didn't have are added, the old fork's that it doesn't have are taken back
 *
 * Moves are generators (not copyable), so a fork is made afresh, not copied: a move under way at the fork's start is
 * sat out (MoveRunner `from`). FORK_BACK is as far back as the replica layer's ring reaches (HISTORY 240 less the
 * lead); a move longer than that, under way across a miss, has the rest of its looks shown from ST, late.
 */
import type { EntityState, ServerMessage } from '@space-game/common';
import type { MoveRunner, TimedMoveMsg } from '../../ships/bodies/MoveRunner';
import { FNV0, hashNums, hashStr, noPtStats, type PtKind } from '../ptKinds';

/** Ticks back a fork starts from the confirmed tick */
export const FORK_BACK = 180;
/** A fresh fork is checked against ST over this many ticks before the confirmed one */
const VERIFY_TICKS = 20;
/** A fork that didn't agree with ST over those (a long move under way was sat out) isn't made afresh again for this long */
const PARTIAL_GAP = 30;

export interface MovesKindHost {
  /** The bodies the snapshots' moves run (BodyRunner.ids) */
  bodies(): Iterable<number>;
  /** A fresh fork of one body's moves, its runs beginning at `from` at the earliest */
  fork(from: number, id: number): MoveRunner;
  /** This client's own ship (a body's personal moves at it) */
  self(): number;
  /** The tick a body's things are drawn at this frame (its PT draw tick) */
  drawTick(id: number): number;
  /** Draw a look now, `late` ticks after its tick */
  show(m: ServerMessage, late: number): void;
  /** Draw a shell ahead (a projectile row as MoveRunner makes them, gone at `until`): a handle to take it back by */
  shell(row: EntityState, until: number): number | null;
  /** Take back a shell drawn ahead that never was */
  retract(handle: number): void;
  now?(): number;
}

interface Out { msgs: TimedMoveMsg[]; shells: { row: EntityState; until: number; key: string; handle: number | null }[] }
interface Fork { runner: MoveRunner; through: number; outs: Map<number, Out>; at: number; partial: boolean }

const msgKey = (t: number, m: ServerMessage) => `${t}|${JSON.stringify(m)}`;
const shellKey = (r: EntityState) => { const d = r.data!; return `${d[3]}|${Math.round(d[4])}|${Math.round(d[5])}|${Math.round((r.vx ?? 0) * 8)}|${Math.round((r.vy ?? 0) * 8)}`; };
const outHash = (o: Out | undefined) => {
  let h = FNV0;
  if (!o) return h;
  for (const m of o.msgs) h = hashStr(h, JSON.stringify(m.msg));
  for (const s of o.shells) h = hashStr(h, s.key);
  return h;
};

export class MovesKind implements PtKind {
  readonly name = 'moves';
  readonly order = 30;
  readonly stats = noPtStats();
  private readonly forks = new Map<number, Fork>();
  /** ST's outputs by body, by tick (kept a little past the confirmed tick for the compare) */
  private readonly st = new Map<number, Map<number, Out>>();
  /** Looks shown (by body, msgKey), and looks waiting for their tick */
  private readonly shown = new Map<number, Set<string>>();
  private queue: TimedMoveMsg[] = [];
  private confirmed = -Infinity;
  private checkedTo = new Map<number, number>();
  private head = -Infinity;
  private readonly now: () => number;

  constructor(private readonly host: MovesKindHost) {
    this.now = host.now ?? (() => performance.now());
  }

  reset(): void {
    for (const f of this.forks.values()) this.retractAll(f, -Infinity);
    this.forks.clear();
    this.st.clear();
    this.shown.clear();
    this.queue = [];
    this.checkedTo.clear();
    this.confirmed = this.head = -Infinity;
    Object.assign(this.stats, noPtStats());
  }

  has(id: number): boolean {
    return this.forks.has(id);
  }

  /** The snapshot's ST shells (MoveRunner.advance's rows), at its tick */
  stRows(rows: readonly EntityState[]): void {
    for (const r of rows) {
      const d = r.data!, t = d[3], owner = d[6];
      this.stOut(owner, t).shells.push({ row: r, until: 0, key: shellKey(r), handle: null });
      // (the server's copy of one drawn ahead, or new: late)
      const pt = this.forks.get(owner)?.outs.get(t);
      if (pt?.shells.some((s) => s.key === shellKey(r))) this.stats.ahead++;
      else if (this.forks.has(owner)) { this.stats.late++; this.stats.lateTicks += Math.max(0, this.host.drawTick(owner) - t); }
    }
  }

  /** The frame's ST looks (MoveRunner.takeTimed): those to draw now (a look PT showed isn't shown again) */
  stMsgs(timed: readonly TimedMoveMsg[]): ServerMessage[] {
    const out: ServerMessage[] = [];
    for (const m of timed) {
      this.stOut(m.owner, m.tick).msgs.push(m);
      const k = msgKey(m.tick, m.msg), seen = this.shown.get(m.owner);
      if (seen?.has(k)) { this.stats.ahead++; continue; }
      if (!this.forks.has(m.owner)) { out.push(m.msg); continue; }
      (seen ?? this.seen(m.owner)).add(k);
      const late = this.host.drawTick(m.owner) - m.tick;
      if (late < 0) { this.queue.push(m); continue; }
      this.stats.late++;
      this.stats.lateTicks += late;
      this.host.show(m.msg, late);
    }
    return out;
  }

  confirm(c: number): void {
    if (c <= this.confirmed) return;
    const prev = this.confirmed;
    this.confirmed = c;
    if (prev === -Infinity) return;
    const live = new Set(this.host.bodies());
    for (const [id, f] of this.forks) if (!live.has(id)) { this.retractAll(f, -Infinity); this.forks.delete(id); this.st.delete(id); this.shown.delete(id); }
    for (const [id, f] of this.forks) {
      const from = this.checkedTo.get(id) ?? prev;
      let miss = false;
      for (let t = from + 1; t <= c; t++) {
        if (t > f.through) break;
        this.stats.checks++;
        if (outHash(f.outs.get(t)) === outHash(this.st.get(id)?.get(t))) this.stats.matches++;
        else { miss = true; this.stats.misses++; break; }
      }
      this.checkedTo.set(id, c);
      if (miss && !(f.partial && c - f.at < PARTIAL_GAP)) this.restep(id, f, c, from);
    }
    // (what's checked goes; ST's kept as far back as a fresh fork is checked)
    for (const m of this.st.values()) for (const t of m.keys()) if (t <= c - VERIFY_TICKS - 4) m.delete(t);
    for (const f of this.forks.values()) for (const t of f.outs.keys()) if (t <= c - 4) f.outs.delete(t);
    for (const s of this.shown.values()) if (s.size > 512) s.clear();
  }

  advance(to: number): void {
    if (this.confirmed === -Infinity) return;
    const t0 = this.now();
    for (const id of this.host.bodies()) {
      if (this.forks.has(id)) continue;
      // (new to it: a fork from just before the confirmed tick; what ST shows up to there is ST's)
      const f: Fork = { runner: this.host.fork(this.confirmed - FORK_BACK, id), through: -Infinity, outs: new Map(), at: this.confirmed, partial: false };
      this.forks.set(id, f);
      this.step(id, f, this.confirmed, false);
      f.partial = !this.agrees(id, f, this.confirmed);
      this.checkedTo.set(id, this.confirmed);
    }
    for (const [id, f] of this.forks) {
      const n = Math.max(0, to - Math.max(f.through, this.confirmed));
      this.step(id, f, to, true);
      this.stats.steps += n;
    }
    if (to > this.head) { this.stats.ticks += Number.isFinite(this.head) ? to - this.head : 1; this.head = to; }
    this.release();
    this.stats.advanceMs += this.now() - t0;
  }

  /** Looks queued whose body's draw tick has reached their tick */
  release(): void {
    if (!this.queue.length) return;
    const keep: TimedMoveMsg[] = [];
    for (const m of this.queue) {
      const d = this.host.drawTick(m.owner);
      if (m.tick > d) { keep.push(m); continue; }
      this.host.show(m.msg, d - m.tick);
    }
    this.queue = keep;
  }

  /** A miss: the fork made afresh from c - FORK_BACK and stepped to the head */
  private restep(id: number, old: Fork, c: number, from: number): void {
    const t0 = this.now();
    const f: Fork = { runner: this.host.fork(c - FORK_BACK, id), through: -Infinity, outs: new Map(), at: c, partial: false };
    // (to c: ST's, not shown; on to the head: PT's)
    this.step(id, f, c, false);
    f.partial = !this.agrees(id, f, c);
    const to = Math.max(old.through, c);
    this.step(id, f, to, true, old);
    // (the old fork's shells from the window that missed on: those the new one hasn't, fired already or not, taken back)
    this.retractAll(old, from, f);
    // (looks the old fork showed that never were: drawn already, they run out)
    for (const [t, o] of old.outs) {
      if (t <= c) continue;
      const now = f.outs.get(t);
      for (const m of o.msgs) if (!now?.msgs.some((n) => JSON.stringify(n.msg) === JSON.stringify(m.msg))) this.stats.wrong++;
    }
    this.forks.set(id, f);
    this.stats.restepThings++;
    this.stats.resteps++;
    this.stats.restepTicks += to - (c - FORK_BACK);
    this.stats.restepMs += this.now() - t0;
  }

  /** Does a fresh fork's past agree with ST's (no move under way sat out) */
  private agrees(id: number, f: Fork, c: number): boolean {
    const st = this.st.get(id);
    for (let t = c - VERIFY_TICKS + 1; t <= c; t++) if (outHash(f.outs.get(t)) !== outHash(st?.get(t))) return false;
    return true;
  }

  /** Take back the old fork's shells after tick `after` that the new one doesn't have (its handles for those it has) */
  private retractAll(old: Fork, after: number, now?: Fork): void {
    for (const [t, o] of old.outs) {
      if (t <= after) continue;
      const keep = now?.outs.get(t);
      for (const s of o.shells) {
        if (s.handle === null) continue;
        const same = keep?.shells.find((k) => k.key === s.key && k.handle === null);
        if (same) { same.handle = s.handle; continue; }
        this.host.retract(s.handle);
        this.stats.wrong++;
      }
    }
  }

  /**
   * The fork stepped to `to`, its outputs recorded by tick; `draw`: its looks queued (or shown, late, if their tick has
   * passed) and its shells drawn, unless the fork it replaces (`was`) already drew them
   */
  private step(id: number, f: Fork, to: number, draw: boolean, was?: Fork): void {
    if (to <= f.through) return;
    const r = f.runner, self = this.host.self();
    const mv = r.advance(to, self);
    const timed = r.takeTimed();
    f.through = to;
    const out = (t: number) => { let o = f.outs.get(t); if (!o) f.outs.set(t, (o = { msgs: [], shells: [] })); return o; };
    for (const m of timed) {
      out(m.tick).msgs.push(m);
      if (!draw || m.tick <= this.confirmed) continue;
      const k = msgKey(m.tick, m.msg), seen = this.seen(id);
      if (seen.has(k)) continue;
      seen.add(k);
      const late = this.host.drawTick(id) - m.tick;
      if (late < 0) this.queue.push(m);
      else { this.host.show(m.msg, late); if (was) { this.stats.late++; this.stats.lateTicks += late; } }
    }
    for (const row of mv.rows) {
      const t = row.data![3], key = shellKey(row);
      const s = { row, until: r.until(row.id) ?? t, key, handle: null as number | null };
      out(t).shells.push(s);
      if (!draw || t <= this.confirmed) continue;
      // (drawn by the fork it replaces already: retractAll hands that one's handle over)
      if (was?.outs.get(t)?.shells.some((o) => o.key === key && o.handle !== null)) continue;
      s.handle = this.host.shell(row, s.until);
    }
  }

  private seen(id: number): Set<string> {
    let s = this.shown.get(id);
    if (!s) this.shown.set(id, (s = new Set()));
    return s;
  }

  private stOut(id: number, t: number): Out {
    let m = this.st.get(id);
    if (!m) this.st.set(id, (m = new Map()));
    let o = m.get(t);
    if (!o) m.set(t, (o = { msgs: [], shells: [] }));
    return o;
  }
}
