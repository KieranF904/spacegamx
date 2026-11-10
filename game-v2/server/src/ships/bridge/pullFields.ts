/**
 * The server's pull fields (common sim/pullFields.ts): what its moves declare (a Scrap Mother's haul and intake, a
 * Scrap Crawler's magnet, a Hookboat's reel, a collapsing star), kept alive a tick at a time, and the source its
 * pilots' steps take their pulls from (bridge/flight.ts stepMovement). Each record goes to the clients of its system
 * once as it stands (forClient: the `pulls` message), and they work every pull out themselves in the same step.
 *
 * A pull on anything but a pilot isn't a field: it stays a push on the velocity (ShipBridge.push).
 */
import {
  Position, Rotation, Velocity, InSystem, PullDeclarer, bookSource, packPullField, fieldNeedsPuller,
  type PullDecl, type PullFieldRec, type PullFieldRow, type PullSource, type PullerPose, type Terrain,
} from '@space-game/common';

export class ServerPulls {
  /** Each record's version (bumped at every change): a client is sent a record whose version it wasn't told */
  private readonly ver = new Map<number, number>();
  readonly declarer = new PullDeclarer((rec) => {
    this.ver.set(rec.id, (this.ver.get(rec.id) ?? 0) + 1);
    if (this.ver.get(rec.id) === 1) { this.stats.opened++; this.stats.kinds[rec.kind] = (this.stats.kinds[rec.kind] ?? 0) + 1; }
    else this.stats.changed++;
  });
  /** Fields opened (and by kind), records changed after (ended early, run on), records sent, pulls the pilots' steps took */
  readonly stats = { opened: 0, kinds: {} as Record<number, number>, changed: 0, sent: 0, pulls: 0 };
  private readonly pose: PullerPose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 };

  constructor(
    /** Is a puller a body here (a ship or debris the bridge holds) */
    private readonly holds: (eid: number) => boolean,
    /** The rock a ship flies among (its system's) */
    private readonly terrain: (eid: number) => Terrain | null | undefined,
  ) {}

  /**
   * What a pilot's step at tick t reads (stepMovement, before anything else moves this tick): each puller as it ended
   * tick t - 1, which is where it is now; the fields of the pilot's own system only
   */
  readonly source: PullSource = bookSource(
    this.declarer.book,
    (from, t) => {
      if (!this.holds(from)) return null;
      const p = this.pose;
      p.x = Position.x[from]; p.y = Position.y[from]; p.angle = Rotation.angle[from]; p.vx = Velocity.x[from]; p.vy = Velocity.y[from];
      // (What the pulls read of it for tick t + 1: its clients work them out only if their replica of it was this, usedAt)
      const u = this.used.get(from);
      if (!u || u.t !== t) this.used.set(from, { t, x: p.x, y: p.y, angle: p.angle, vx: p.vx, vy: p.vy });
      return p;
    },
    (id) => this.terrain(id),
    (id) => InSystem.systemId[id],
  );

  /** Each puller as its fields' pulls last read it: as it ended tick t (they act on t + 1) */
  private readonly used = new Map<number, PullerPose & { t: number }>();

  /** A puller as the pulls of tick t read it (as it ended t - 1); null: none read it for t */
  usedAt(from: number, t: number): PullerPose | null {
    const u = this.used.get(from);
    return u && u.t === t - 1 ? u : null;
  }

  /** Has it any field to read (the step skips the pull phase otherwise) */
  get any(): boolean {
    return this.declarer.book.size > 0;
  }

  /** A move's pull on tick now + 1 (common sim/pullFields.ts PullDeclarer.declare) */
  declare(from: number, key: string, d: PullDecl, now: number): void {
    this.declarer.declare(InSystem.systemId[from], from, key, d, now);
  }

  /** The start of a tick, before its pilots step (`on`: the systems stepped in this pass): undeclared fields end */
  settle(now: number, on?: (sys: number) => boolean): void {
    this.declarer.settle(now, on);
  }

  /** A puller gone (forgotten by the bridge at the end of tick `now`): its fields don't act from the next tick */
  drop(from: number, now: number): void {
    this.declarer.drop(from, now + 1);
    this.used.delete(from);
  }

  /** Fields acting on tick t in a system */
  activeAt(sys: number, t: number): PullFieldRec[] {
    return this.declarer.activeAt(t).filter((f) => f.sys === sys);
  }

  /** A field by id */
  get(id: number): PullFieldRec | undefined {
    return this.declarer.book.get(id);
  }

  /**
   * Does a pull by `from` read where `from` is (a body's field), so a client works it out only if it holds `from` as the
   * server had it? False for a field from a fixed point (a collapsing star: everything it reads is in its record)
   */
  needsPuller(from: number): boolean {
    for (const f of this.declarer.book.all()) if (f.from === from && fieldNeedsPuller(f.kind)) return true;
    return false;
  }

  /** The pullers needsPuller is true of (every field's `from` whose pull reads where it is) */
  pullers(): Set<number> {
    const out = new Set<number>();
    for (const f of this.declarer.book.all()) if (fieldNeedsPuller(f.kind)) out.add(f.from);
    return out;
  }

  /**
   * One client's records: every field of its system it hasn't been told as it now stands (`told`: id -> version, its
   * connection's; cleared when it changes system). Null: none
   */
  forClient(told: Map<number, number>, sys: number): PullFieldRow[] | null {
    let out: PullFieldRow[] | null = null;
    for (const f of this.declarer.book.all()) {
      if (f.sys !== sys) continue;
      const v = this.ver.get(f.id) ?? 0;
      if (told.get(f.id) === v) continue;
      told.set(f.id, v);
      (out ??= []).push(packPullField(f));
      this.stats.sent++;
    }
    if (told.size > 256) for (const id of told.keys()) if (!this.declarer.book.get(id)) told.delete(id);
    return out;
  }
}
