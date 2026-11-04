/**
 * Homing shells and mobs on this client's tick-aligned layer (CAPS.WAYPOINTS; common guidance/, docs/design/awareness-model.md
 * 6.3). One in range comes once as a SYNC (its state and guide as a snapshot's tick ended), and from there it is flown
 * by the shared waypoint law, a tick at a time, as the server flies it:
 *
 *   LOST     its target is gone; TARGET a mob's brain chose another (every client is told)
 *   advance  the queued waypoint takes over at its start
 *   plan     "derived" ticks (it holds the target): the planner, from its replica of the target as the server read it
 *            (a pilot after its step, before that tick's causes: ShipReplicaSet.preAt; anything else as it ended the
 *            tick before). "sent" ticks: the server's WP and NEXT records instead (MODE says which, from a tick)
 *   steer    toward its waypoint; then it moves
 *
 * Each snapshot steps every shell it runs to the snapshot's tick: what it reads of other ships through the window is
 * final then. Its state goes to the drawing as the shell's row would have (rows); its check (byte) adds up each one's
 * hash as of the snapshot's tick, on its own check (OwnTick extraHash).
 */
import {
  EntityType, GUIDE, MODE_SENT, ReplicaMode, applyGuideRec, launchOfArgs, guideFirst, guideAdvance, guideHash, guideOfSync, guidePlan, guideRowOk, guideSteer, replicasByte,
  type EntityState, type Guide, type GuideBody, type ShipReplicaSet,
} from '@space-game/common';

/** Ticks a shell is stepped in one go at most (a long gap: it waits for the next SYNC) */
const MAX_STEP = 600;
/** Check bytes kept (snapshots) */
const KEEP_BYTES = 64;

export interface GuideRunnerHost {
  reps: ShipReplicaSet;
  /** A shell stepped to tick t (tests: compared with the server's, tick by tick) */
  onStep?(id: number, t: number, m: Readonly<GuideBody>): void;
}

interface Run {
  m: GuideBody;
  g: Guide;
  /** Its state is as tick `last` ended */
  last: number;
  syncTick: number;
  /** [from tick, mode] in tick order */
  modes: [number, number][];
  /** Records by tick ([op, ...args]) */
  recs: Map<number, number[][]>;
}

export class GuideRunner {
  on = false;
  private readonly runs = new Map<number, Run>();
  /** Each snapshot's shells as it ended ([id, hash]), for its check: summed when it's asked for (byte) */
  private readonly held = new Map<number, [number, number][]>();
  /** Shells gone since the last snapshot was noted (a told hit ends one after its snapshot went in) */
  private readonly dead = new Set<number>();
  readonly stats = { syncs: 0, offs: 0, records: 0, plans: 0, blind: 0, steps: 0, launches: 0 };

  constructor(private readonly host: GuideRunnerHost) {}

  setOn(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    if (!on) this.reset();
  }

  /** A connection afresh: the server's GuideNet runs none for it, so neither does this */
  reset(): void {
    this.runs.clear();
    this.held.clear();
    this.dead.clear();
  }

  /** Shells it runs */
  ids(): IterableIterator<number> {
    return this.runs.keys();
  }

  /** A shell's state as its last stepped tick ended (null: not run here) */
  state(id: number): { m: Readonly<GuideBody>; tick: number } | null {
    const r = this.runs.get(id);
    return r ? { m: r.m, tick: r.last } : null;
  }

  /** A snapshot's guide rows, after its keyframes, causes and decisions went in: then every shell to its tick */
  onSnapshot(tick: number, rows: readonly (readonly number[])[] | undefined): void {
    if (!this.on) return;
    for (const row of rows ?? []) {
      if (!guideRowOk(row)) continue;
      const [id, dt, op] = row, t = tick + dt, args = row.slice(3);
      if (op === GUIDE.SYNC) {
        const s = guideOfSync(args, t);
        this.runs.set(id, { m: s.m, g: s.g, last: t, syncTick: t, modes: [[t + 1, s.sent ? MODE_SENT : 0]], recs: new Map() });
        this.stats.syncs++;
        continue;
      }
      if (op === GUIDE.LAUNCH) {
        // (A volley laid at once, CAPS.LAUNCHES: each mob as its SYNC would have had it, common guidance/launch.ts)
        for (const l of launchOfArgs(args, t) ?? []) this.runs.set(l.id, { m: l.m, g: l.g, last: t, syncTick: t, modes: [[t + 1, 0]], recs: new Map() });
        this.stats.launches++;
        continue;
      }
      if (op === GUIDE.OFF) { if (this.runs.delete(id)) this.stats.offs++; continue; }
      const run = this.runs.get(id);
      if (!run || t <= run.syncTick) continue;
      if (op === GUIDE.MODE) { run.modes.push([t, args[0] ?? 0]); continue; }
      let at = run.recs.get(t);
      if (!at) run.recs.set(t, (at = []));
      at.push([op, ...args]);
      this.stats.records++;
    }
    for (const [id, run] of this.runs) this.step(id, run, tick);
  }

  /**
   * Where the drawing has the shells it runs: their rows in the snapshot (the first, which the server still sends) set
   * to its tick layer's state, the others added as such rows (`data`: the row data the drawing has for one)
   */
  draw(tick: number, entities: EntityState[], data: (id: number) => number[] | undefined): EntityState[] {
    const out: EntityState[] = [];
    if (!this.runs.size) return out;
    const rows = new Map<number, EntityState>();
    for (const e of entities) if ((e.type === EntityType.Projectile || e.type === EntityType.Enemy) && this.runs.has(e.id)) rows.set(e.id, e);
    for (const [id, r] of this.runs) {
      if (r.last !== tick) continue;
      const row = rows.get(id);
      // (a mob's heading too: it points where it steers)
      if (row) { row.x = r.m.x; row.y = r.m.y; row.vx = r.m.vx; row.vy = r.m.vy; if (r.m.a !== undefined) row.angle = r.m.a; continue; }
      const d = data(id);
      if (d) out.push({ id, type: r.m.a !== undefined ? EntityType.Enemy : EntityType.Projectile, x: r.m.x, y: r.m.y, vx: r.m.vx, vy: r.m.vy, ...(r.m.a !== undefined ? { angle: r.m.a } : {}), data: d });
    }
    return out;
  }

  /**
   * A shell gone (a snapshot's removal, or a told hit that ended it): unless a SYNC in that snapshot (`tick`) made it a
   * new one in the same id
   */
  remove(id: number, tick?: number): void {
    const r = this.runs.get(id);
    if (!r || r.syncTick === tick) return;
    this.runs.delete(id);
    this.dead.add(id);
  }

  /** After a snapshot's removals: the shells it runs as that tick ended, for its check */
  noteHeld(tick: number): void {
    if (!this.on) return;
    this.dead.clear();
    const list: [number, number][] = [];
    for (const [id, r] of this.runs) if (r.last === tick) list.push([id, guideHash(id, r.m)]);
    this.held.set(tick, list);
    if (this.held.size > KEEP_BYTES) for (const t of this.held.keys()) { this.held.delete(t); if (this.held.size <= KEEP_BYTES) break; }
  }

  /** What it adds to its own check for a snapshot's tick: those still running (one a told hit ended since isn't) */
  byte(tick: number): number {
    const list = this.held.get(tick);
    if (!list?.length) return 0;
    let sum = 0;
    for (const [id, h] of list) if (!this.dead.has(id)) sum = (sum + h) >>> 0;
    return replicasByte(sum);
  }

  private modeAt(run: Run, t: number): number {
    let mode = 0;
    for (const [from, m] of run.modes) { if (from > t) break; mode = m; }
    return mode;
  }

  /** The target as the server's planner read it at tick t (null: not held) */
  private targetAt(id: number, t: number): GuideBody | null {
    const reps = this.host.reps, mode = reps.modeOf(id);
    if (mode === undefined) return null;
    return (mode === ReplicaMode.Player ? reps.preAt(id, t) : reps.at(id, t - 1)?.body) ?? null;
  }

  private step(id: number, run: Run, to: number): void {
    const { m, g } = run;
    const end = Math.min(to, run.last + MAX_STEP);
    for (let t = run.last + 1; t <= end; t++) {
      const recs = run.recs.get(t);
      if (recs) for (const r of recs) if (guideFirst(r[0])) applyGuideRec(g, r[0], r.slice(1), m, t);
      guideAdvance(g, t);
      if (this.modeAt(run, t) === MODE_SENT) {
        if (recs) for (const r of recs) if (!guideFirst(r[0])) applyGuideRec(g, r[0], r.slice(1), m, t);
      } else {
        const tg = g.target >= 0 ? this.targetAt(g.target, t) : null;
        if (g.target >= 0 && !tg) this.stats.blind++;
        if (guidePlan(g, id, m, tg, t)) this.stats.plans++;
      }
      guideSteer(g, m, t);
      m.x += m.vx;
      m.y += m.vy;
      run.recs.delete(t);
      run.last = t;
      this.stats.steps++;
      this.host.onStep?.(id, t, m);
    }
    // (modes before the last stepped tick that a later one overrides go)
    while (run.modes.length > 1 && run.modes[1][0] <= run.last) run.modes.shift();
  }
}
