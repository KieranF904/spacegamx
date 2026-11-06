/**
 * Pull fields (sim foundation, game-wide C3 track B): every pull on a pilot's ship is a force inside that ship's step,
 * worked out on both ends by the same function from state both hold, never sent as its push tick by tick.
 *
 * What is decided, and sent once, is the FIELD: who pulls (a body, or a collapsing star's held orb), its shape and
 * numbers, which ship it acts on (one, or every pilot in the system), and the ticks it acts on, [t0, t1). The server's
 * moves declare it a tick ahead (a move's step on tick n says "I pull on tick n + 1": PullDeclarer, kept alive while
 * the move keeps saying so); the server sends each field's record when it opens and again if it ends early (the
 * `pulls` message, ServerPullsMessage). The force itself, each tick, is `fieldPull`: the puller as it ended tick t - 1
 * (the server's Position as its pilots step; a client's replica ring at t - 1) and the pulled ship after its motion on
 * tick t (the step's `at`, sim/pulls.ts applyPulls), exactly what the server's move used to compute after the pilots
 * had moved (moves read pilots "after their own step, before that tick's pulls and contacts": bodies/moves/host.ts).
 *
 * Kinds (args `a`, set by the move that declares the field):
 *   CONE   [d, reach, k, walled]: towards the point d ahead of the puller, only on ships in front of it (the Scrap
 *          Mother's haul)
 *   LANE   [d, reach, k, half, alongMin, alongMax, walled]: towards the point d ahead, only on ships in the lane
 *          ahead of it (`along` from that point, `half` wide either side: her intake)
 *   POINT  [r, k]: towards the puller's centre (a Scrap Crawler's magnet), on its target
 *   REEL   [slack, reelMax, r, k]: towards the puller's centre while the target is further than `slack` and not
 *          already closing at `reelMax` (a Hookboat's tether)
 *   STAR   [x, y, radius, strength]: towards a fixed point, harder the closer (a collapsing star parked at (x, y);
 *          its owner is `skip`)
 * `walled`: no pull through rock (terrain.ts rayTerrain from the point to the ship).
 *
 * Only pilots are pulled this way (ReplicaMode.Player: the server's stepMovement, every client's replica and own
 * step). A pull on anything else stays the server's push on its velocity (its replicas get a keyframe as before).
 */

import { dcos, dsin, dhypot } from '../math/detTrig.js';
import { rayTerrain, type Terrain } from '../terrain.js';
import type { PullSource } from './env.js';

export const PULL_FIELD = { CONE: 0, LANE: 1, POINT: 2, REEL: 3, STAR: 4 } as const;

/** A puller's pose as a field reads it (its state at the end of the tick before) */
export interface PullerPose { x: number; y: number; angle: number; vx: number; vy: number }
/** The pulled ship after its motion on the tick (the step's body) */
export interface PulledBody { x: number; y: number; vx?: number; vy?: number }

/** One field: acting on ticks [t0, t1) (t1 Infinity: open, its end not decided yet) */
export interface PullFieldRec {
  /** Its id (the server's, unique while it is kept) */
  id: number;
  /** The puller: a body's ship, or a held orb (STAR: its position is in `a`, nothing of the orb is read) */
  from: number;
  kind: number;
  t0: number;
  t1: number;
  /** The ship it pulls; -1 every pilot in the system */
  target: number;
  /** A ship it never pulls (a star's owner); -1 none */
  skip: number;
  a: readonly number[];
  /** The server's: the system it is in (never sent; a client holds one system) */
  sys?: number;
}

/** Does this kind read its puller's pose (STAR is a fixed point) */
export const fieldNeedsPuller = (kind: number): boolean => kind !== PULL_FIELD.STAR;

/** The pull towards (x, y): `k` a tick at the middle, falling to nothing at `r` (bodies/moves pullTowards and pullOne) */
function towards(at: PulledBody, x: number, y: number, r: number, k: number, out: [number, number]): boolean {
  const dx = x - at.x, dy = y - at.y, d = dhypot(dx, dy);
  if (d > r || d < 1) return false;
  const f = k * (1 - d / r);
  out[0] = (dx / d) * f;
  out[1] = (dy / d) * f;
  return true;
}

/**
 * A field's pull on a ship this tick ([ax, ay] in `out`, world units a tick, before the PULL grid), or false when it
 * doesn't pull it. `p`: the puller as it ended the tick before (null: not had, and the kind needs it: no pull)
 */
export function fieldPull(f: Readonly<PullFieldRec>, p: Readonly<PullerPose> | null, at: Readonly<PulledBody>, terrain: Terrain | null | undefined, out: [number, number]): boolean {
  const a = f.a;
  switch (f.kind) {
    case PULL_FIELD.CONE: {
      if (!p) return false;
      const c = dcos(p.angle), s = dsin(p.angle);
      // (her front only: beside or behind her, nothing pulls)
      if ((at.x - p.x) * c + (at.y - p.y) * s <= 0) return false;
      const x = p.x + c * a[0], y = p.y + s * a[0];
      if (a[3] && rayTerrain(terrain, x, y, at.x, at.y) < 1) return false;
      return towards(at, x, y, a[1], a[2], out);
    }
    case PULL_FIELD.LANE: {
      if (!p) return false;
      const c = dcos(p.angle), s = dsin(p.angle);
      const x = p.x + c * a[0], y = p.y + s * a[0];
      const dx = at.x - x, dy = at.y - y, along = dx * c + dy * s, across = -dx * s + dy * c;
      if (along < a[4] || along > a[5] || Math.abs(across) > a[3]) return false;
      if (a[6] && rayTerrain(terrain, x, y, at.x, at.y) < 1) return false;
      return towards(at, x, y, a[1], a[2], out);
    }
    case PULL_FIELD.POINT:
      if (!p) return false;
      return towards(at, p.x, p.y, a[0], a[1], out);
    case PULL_FIELD.REEL: {
      if (!p) return false;
      const d = dhypot(at.x - p.x, at.y - p.y);
      // (a tow, not a sling: no more pull once it's coming in at reelMax, so it isn't hurled into the boat's hull)
      const ux = (p.x - at.x) / (d || 1), uy = (p.y - at.y) / (d || 1);
      const closing = ((at.vx ?? 0) - p.vx) * ux + ((at.vy ?? 0) - p.vy) * uy;
      if (!(d > a[0] && closing < a[1])) return false;
      return towards(at, p.x, p.y, a[2], a[3], out);
    }
    case PULL_FIELD.STAR: {
      const dx = a[0] - at.x, dy = a[1] - at.y, d = dhypot(dx, dy), r = a[2];
      if (d > r || d < 1) return false;
      const k = a[3] * (1 - d / r) * (1 - d / r) * 2;
      out[0] = (dx / d) * k;
      out[1] = (dy / d) * k;
      return true;
    }
    default:
      return false;
  }
}

/** Does a field act on ship `id` at tick t (its ticks, its target, not its skip, not its own puller) */
export function fieldOn(f: Readonly<PullFieldRec>, id: number, t: number): boolean {
  return t >= f.t0 && t < f.t1 && id !== f.from && id !== f.skip && (f.target < 0 || f.target === id);
}

/** The fields held, by id (the server's: every system's; a client's: its system's) */
export class PullBook {
  private readonly fields = new Map<number, PullFieldRec>();
  /** The fields in puller order (from, then id): the order a ship's pulls go in (env.ts PullSource) */
  private sorted: PullFieldRec[] | null = [];

  get size(): number {
    return this.fields.size;
  }

  get(id: number): PullFieldRec | undefined {
    return this.fields.get(id);
  }

  /** In puller order (from, then id) */
  all(): readonly PullFieldRec[] {
    return (this.sorted ??= [...this.fields.values()].sort((x, y) => x.from - y.from || x.id - y.id));
  }

  /**
   * A field's record (new, or what is known of it now): the earliest tick whose pulls it changes (null: none). An end
   * moved changes from the earlier of the two ends; a new one from its start
   */
  put(rec: PullFieldRec): number | null {
    const was = this.fields.get(rec.id);
    this.fields.set(rec.id, rec);
    this.sorted = null;
    if (!was) return rec.t0;
    if (was.t0 !== rec.t0 || was.from !== rec.from || was.kind !== rec.kind || was.target !== rec.target || was.skip !== rec.skip || !sameArgs(was.a, rec.a)) return Math.min(was.t0, rec.t0);
    return was.t1 === rec.t1 ? null : Math.min(was.t1, rec.t1);
  }

  /** Fields that ended before tick t go (a re-step never goes that far back) */
  prune(t: number): void {
    for (const [id, f] of this.fields) if (f.t1 < t) { this.fields.delete(id); this.sorted = null; }
  }

  remove(id: number): void {
    if (this.fields.delete(id)) this.sorted = null;
  }

  clear(): void {
    this.fields.clear();
    this.sorted = [];
  }
}

function sameArgs(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const OUT: [number, number] = [0, 0];
const NONE: readonly (readonly [number, number, number])[] = [];

/**
 * The fields' pulls on ship `id` at tick t, in puller order ([from, ax, ay] each, as PullSource gives them): every field
 * of `fields` acting on it then (`sys`: the server's, only that system's), each puller as `pose` has it at t - 1
 */
export function fieldPulls(fields: readonly PullFieldRec[], id: number, t: number, at: Readonly<PulledBody>, pose: (from: number, t: number) => PullerPose | null, terrain: Terrain | null | undefined, sys?: number): readonly (readonly [number, number, number])[] {
  let out: [number, number, number][] | null = null;
  for (const f of fields) {
    if (!fieldOn(f, id, t) || (sys !== undefined && f.sys !== sys)) continue;
    const p = fieldNeedsPuller(f.kind) ? pose(f.from, t - 1) : null;
    if (fieldNeedsPuller(f.kind) && !p) continue;
    if (fieldPull(f, p, at, terrain, OUT)) (out ??= []).push([f.from, OUT[0], OUT[1]]);
  }
  return out ?? NONE;
}

// ---- On the wire: the `pulls` message (server to client, before the snapshot it goes with) ----

/** A field as sent: [id, from, kind, t0, t1 (-1: open), target, skip, ...a] */
export type PullFieldRow = number[];

/** The server's fields a client hasn't been told as they now stand (records that opened, or ended early) */
export interface ServerPullsMessage {
  type: 'pulls';
  f: PullFieldRow[];
  /** 1: forget every field held first (a new system's) */
  r?: 1;
}

export function packPullField(f: Readonly<PullFieldRec>): PullFieldRow {
  return [f.id, f.from, f.kind, f.t0, Number.isFinite(f.t1) ? f.t1 : -1, f.target, f.skip, ...f.a];
}

export function unpackPullField(r: readonly number[]): PullFieldRec {
  return { id: r[0], from: r[1], kind: r[2], t0: r[3], t1: r[4] < 0 ? Infinity : r[4], target: r[5], skip: r[6], a: r.slice(7) };
}

// ---- The server's side: fields declared a tick ahead, kept alive while declared ----

/** What a move declares: the field's shape, its target, the ship it skips, and the last tick it means to pull on */
export interface PullDecl {
  kind: number;
  target: number;
  skip?: number;
  a: readonly number[];
  /** The last tick it will pull on if it keeps going (undefined: open until it stops saying so) */
  until?: number;
}

interface Open { rec: PullFieldRec; seen: number; key: string }

/**
 * Fields as the server's moves declare them: a declaration on tick n opens (or keeps open) a field acting from n + 1;
 * one not declared again on a tick it acts on ends there. Each change of a record (opened, ended early, run past its
 * `until`) is handed to `changed`, which sends it on
 */
export class PullDeclarer {
  readonly book = new PullBook();
  private readonly open = new Map<string, Open>();
  private nextId = 1;

  constructor(private readonly changed: (rec: PullFieldRec) => void = () => {}) {}

  /**
   * Puller `from` (in system `sys`) pulls on tick now + 1 as `d` says; `key` names the field among its own (one per
   * move: its harpoon, its magnet). The same declaration again keeps it open; a different one ends the old and opens a new
   */
  declare(sys: number, from: number, key: string, d: PullDecl, now: number): void {
    const k = `${from}:${key}`, o = this.open.get(k), t = now + 1;
    const t1 = d.until === undefined ? Infinity : Math.max(t, d.until) + 1;
    if (o && o.seen >= now - 1 && o.rec.kind === d.kind && o.rec.target === d.target && o.rec.skip === (d.skip ?? -1) && sameArgs(o.rec.a, d.a) && t >= o.rec.t0) {
      o.seen = now;
      // (Run past the end it gave: a new end)
      if (t >= o.rec.t1) this.update(o, { ...o.rec, t1 });
      return;
    }
    if (o) this.close(o, Math.min(o.rec.t1, Math.max(o.rec.t0, t)));
    const rec: PullFieldRec = { id: this.nextId++, from, kind: d.kind, t0: t, t1, target: d.target, skip: d.skip ?? -1, a: [...d.a], sys };
    const n: Open = { rec, seen: now, key: k };
    this.open.set(k, n);
    this.book.put(rec);
    this.changed(rec);
  }

  /**
   * The start of tick `now` (before any pilot steps), for the systems `on` says are stepped now: a field not declared
   * on the tick before doesn't act from now on (it ends at `now` if it would have gone on)
   */
  settle(now: number, on: (sys: number) => boolean = () => true): void {
    for (const o of [...this.open.values()]) {
      if (!on(o.rec.sys ?? -1)) continue;
      if (o.seen >= now - 1) continue;
      this.close(o, Math.min(o.rec.t1, Math.max(o.rec.t0, o.seen + 2)));
    }
    // (Ended fields are kept a while: a shadow or a client's re-step reads them back)
    if (now % 60 === 0) this.book.prune(now - 600);
  }

  /** Every field of a puller ends now (it's gone): from tick `now` on nothing of it acts */
  drop(from: number, now: number): void {
    for (const o of [...this.open.values()]) if (o.rec.from === from) this.close(o, Math.min(o.rec.t1, Math.max(o.rec.t0, now)));
  }

  /** Fields acting at tick t (any system) */
  activeAt(t: number): PullFieldRec[] {
    return this.book.all().filter((f) => t >= f.t0 && t < f.t1);
  }

  private close(o: Open, t1: number): void {
    this.open.delete(o.key);
    if (t1 !== o.rec.t1) this.update(o, { ...o.rec, t1 });
  }

  private update(o: Open, rec: PullFieldRec): void {
    o.rec = rec;
    this.book.put(rec);
    this.changed(rec);
  }

  clear(): void {
    this.open.clear();
    this.book.clear();
  }
}

/** A PullSource over a book: `pose` reads a puller at a tick, `terrain` the rock, `sysOf` a ship's system (the server's) */
export function bookSource(book: PullBook, pose: (from: number, t: number) => PullerPose | null, terrain: (id: number) => Terrain | null | undefined, sysOf?: (id: number) => number): PullSource {
  return {
    on(id, t, at) {
      if (!book.size) return NONE;
      return fieldPulls(book.all(), id, t, at, pose, terrain(id), sysOf?.(id));
    },
  };
}
