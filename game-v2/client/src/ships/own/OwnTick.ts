/**
 * This client's own ship on its tick-aligned layer (CAPS.OWN_SIM; common network/ownTick.ts, docs/design/
 * confirmed-hits.md part G). The layer's own ship (what its own shells are built from, ShipClient.preSnapshot) is a
 * replica like every other ship's (ShipReplicaSet), but stepped from this timeline instead of the server's rows:
 *
 *   controls   its own inputs, each from the tick the server ran it (its target tick); where the server says the
 *              ship flew otherwise (a control row of its own: the engines short of power, an EMP, the cold), that
 *              window's controls are the server's
 *   structure  the one it flew each tick with: a rebuild's tick (the cause) splits the old one (kept when the new one
 *              came, beforeSync) from the new
 *   causes     after each tick's step, that tick's (a pull's push, a contact worked out with the shared contact maths,
 *              a rebuild's recentring), then rounded as every body is
 *
 * The drawn ship is its prediction, untouched. Its check (takeCheck): a hash of its state at the last snapshot's tick
 * on an input that goes anyway, as often as its record calls for: NORMAL to start, ROUGH after a clean stretch, STRICT
 * after the server had to fix it (a keyframe of its own ship after the first), stepping back down after each clean one.
 */
import {
  applyOwnCauses, buildFlightInputs, controlBits, quantizeReplicaAngle, unpackControlRow, controlRowId, ownBodyHash, ownHpHash,
  ownCheckRules, CONFIRM, CONTACT_BIG_BODY, OWN_CAUSE, CONTACT_FLAG,
  type OwnTimeline, type ShipReplicaSet, type ShipDerived, type ShipState, type ShipTuning, type FlightBody, type OwnCheck,
  type OwnCauseEnv, type OwnShape, type PlacedGeom, type ServerSnapshotMessage, type ClientInputMessage, type Vec2,
} from '@space-game/common';

export interface OwnTickHost {
  /** The ships' structures (its own and the others it touches) */
  store: { get(id: number): ShipState | undefined; geometry(ship: ShipState): PlacedGeom[] };
  reps: ShipReplicaSet;
  /** Its own ship's id */
  self(): number;
  tuning: ShipTuning;
  /**
   * Is anything stepping on its layer able to read its ship before a snapshot's structure and causes are in (a boss's
   * body reading its target, CAPS.BODIES)? Then each snapshot steps it again from just after the last. Unset: always
   */
  restep?(): boolean;
}

/** Ticks of inputs kept (a snapshot window is never this far behind the inputs it needs) */
const KEEP_TICKS = 600;
/** Clean ticks for its check to step down a level (as part E's) */
const CLEAN_TICKS = 600;

export class OwnTick implements OwnTimeline {
  on = false;
  /** Control changes by tick: its inputs (by target tick), and the server's where it said */
  private readonly ctls = new Map<number, [number, number]>();
  /** Causes by tick ([kind, ...]) */
  private readonly causes = new Map<number, number[][]>();
  /** Its structure before the latest shipSync of its own ship (a rebuild in the next snapshot's window flew it until then) */
  private before: ShipDerived | null = null;
  /** Other ships' structures before their shipSync this frame, and those a contact row says the ship touched (OTHER_BEFORE), by tick and id */
  private othersBefore = new Map<number, ShipDerived>();
  private touched = new Map<string, ShipDerived>();
  /** The structure flown up to (and on) a rebuild's tick, and the centres of mass either side */
  private until: { derived: ShipDerived; tick: number; from: Vec2; to: Vec2 } | null = null;
  /** Its body after a tick's step and before that tick's causes (where its guns fired from: they fire before pulls and contacts) */
  private readonly fired = new Map<number, FlightBody>();
  private snapTick = -Infinity;
  private keyed = false;
  /** Its check's level (CONFIRM), since when, and the last check sent */
  level: number = CONFIRM.NORMAL;
  private levelSince = 0;
  private last = { tick: -Infinity, snap: -Infinity, body: -1, hp: -1 };
  readonly stats = { inputs: 0, causes: 0, failed: 0, fixes: 0, exc: 0, checks: 0 };

  constructor(private readonly host: OwnTickHost) {}

  /** Switched on or off (netCaps): its own replica is stepped from here, or from rows again */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.causes.clear();
    this.until = null;
    this.keyed = false;
    this.host.reps.setOwn(this.host.self(), on ? this : null);
  }

  /** An input it sent (kept whether or not it's on: switched on, the inputs already sent ahead are needed) */
  noteInput(msg: ClientInputMessage): void {
    const t = msg.targetTick;
    if (t === undefined) return;
    this.ctls.set(t, [controlBits(buildFlightInputs(msg, false)), quantizeReplicaAngle(Number(msg.targetAngle) || 0)]);
    this.stats.inputs++;
    if (this.ctls.size > KEEP_TICKS) for (const k of [...this.ctls.keys()]) if (k < t - KEEP_TICKS) this.ctls.delete(k);
    if (this.on) this.host.reps.rewind(this.host.self(), t);
  }

  /** Its own ship's structure is about to change (shipSync): the one it flew until now */
  beforeSync(id: number): void {
    const d = this.host.store.get(id)?.derived ?? null;
    if (id === this.host.self()) this.before = d;
    else if (d && this.on) this.othersBefore.set(id, d);
  }

  /**
   * A snapshot, after the replicas took its keyframes (and before its fire events are built): its own control row
   * (the server's controls for that window), its causes, a rebuild's split, and its own ship stepped again from the
   * earliest tick they change
   */
  onSnapshot(m: ServerSnapshotMessage): void {
    const self = this.host.self(), prev = this.snapTick;
    this.snapTick = m.tick;
    if (!this.on) { this.before = null; this.othersBefore.clear(); return; }
    // (What it stepped past the last snapshot is stepped again: something may have asked for its ship there before this
    // frame's structure and causes were in, a boss's body reading its target, CAPS.BODIES)
    let earliest = (this.host.restep?.() ?? true) ? prev + 1 : Infinity;
    if (m.ships?.some((k) => k[0] === self)) {
      // (A keyframe of its own ship after the first: the server had to put it right)
      if (this.keyed) { this.stats.fixes++; this.level = CONFIRM.STRICT; this.levelSince = m.tick; }
      this.keyed = true;
    }
    const row = m.ctl?.find((r) => controlRowId(r) === self);
    if (row) {
      const ev = unpackControlRow(row, 0);
      // (From the row's first tick: the server's window, whatever snapshots this client missed)
      const lo = m.tick - (ev[0]?.[0] ?? 0);
      for (const t of [...this.ctls.keys()]) if (t >= lo && t <= m.tick) this.ctls.delete(t);
      for (const [ago, bits, q] of ev) this.ctls.set(m.tick - ago, [bits, q]);
      earliest = Math.min(earliest, lo);
      this.stats.exc++;
    }
    for (const r of m.own ?? []) {
      const t = m.tick - r[0];
      const at = this.causes.get(t);
      if (at) at.push(r.slice(1)); else this.causes.set(t, [r.slice(1)]);
      earliest = Math.min(earliest, t);
      this.stats.causes++;
      if (r[1] === OWN_CAUSE.CONTACT && r[3] & CONTACT_FLAG.OTHER_BEFORE) {
        const d = this.othersBefore.get(r[2]);
        if (d) this.touched.set(t + ':' + r[2], d);
      }
      if (r[1] === OWN_CAUSE.REBUILD) {
        const now = this.host.store.get(self)?.derived, was = this.before ?? now;
        if (was && now) this.until = { derived: was, tick: t, from: was.com, to: now.com };
      }
    }
    this.before = null;
    this.othersBefore.clear();
    if (this.touched.size > 64) for (const k of [...this.touched.keys()]) if (Number(k.split(':')[0]) < m.tick - KEEP_TICKS) this.touched.delete(k);
    if (this.causes.size > 64) for (const t of [...this.causes.keys()]) if (t < m.tick - KEEP_TICKS) this.causes.delete(t);
    if (earliest <= m.tick) this.host.reps.rewind(self, earliest);
  }

  // ---- OwnTimeline (ShipReplicaSet steps its own ship from these) ----

  ctl(t: number): readonly [number, number] | undefined {
    return this.ctls.get(t);
  }

  derived(t: number): ShipDerived | null | undefined {
    if (this.until && t <= this.until.tick) return this.until.derived;
    return this.host.store.get(this.host.self())?.derived;
  }

  after(t: number, body: FlightBody): void {
    const rows = this.causes.get(t);
    if (!rows) return;
    this.fired.set(t, { ...body });
    if (this.fired.size > 64) for (const k of [...this.fired.keys()]) if (k < t - KEEP_TICKS) this.fired.delete(k);
    if (!applyOwnCauses(body, rows, this.env(t))) this.stats.failed++;
  }

  private env(t: number): OwnCauseEnv {
    const { store, reps, tuning } = this.host;
    const self = store.get(this.host.self());
    const d = this.derived(t);
    return {
      cellSize: tuning.cellSize,
      restitution: tuning.collision?.restitution ?? 0.3,
      self: self && d ? shapeOf(self, d, store.geometry(self)) : null,
      other: (id) => {
        const ship = store.get(id), at = reps.at(id, t);
        return ship && at ? { shape: shapeOf(ship, this.touched.get(t + ':' + id) ?? ship.derived, store.geometry(ship)), body: { x: at.body.x, y: at.body.y, angle: at.body.angle, vx: at.body.vx, vy: at.body.vy } } : null;
      },
      rebuilt: () => (this.until && this.until.tick === t ? { from: this.until.from, to: this.until.to } : null),
    };
  }

  /** Where its ship was as its guns fired on tick t (its fire events' shells are built from this, ShipClient.preSnapshot) */
  firePose(t: number): FlightBody | null {
    const st = this.host.reps.at(this.host.self(), t);
    if (!st) return null;
    return (this.causes.has(t) ? this.fired.get(t) : undefined) ?? st.body;
  }

  // ---- Its check ----

  /**
   * Its check, if one is due (`riding`: an input goes anyway; else only after its level's `alone` ticks, and only if
   * its state changed since the last): a hash of its own ship as of the last snapshot's tick
   */
  takeCheck(riding: boolean, tick: number): OwnCheck | undefined {
    if (!this.on || !this.keyed || this.snapTick === this.last.snap) return undefined;
    // (A clean stretch at a level steps it down one)
    if (this.level > CONFIRM.ROUGH && tick - this.levelSince >= CLEAN_TICKS) { this.level--; this.levelSince = tick; }
    const rules = ownCheckRules(this.level), since = tick - this.last.tick;
    if (since < rules.ride || (!riding && since < rules.alone)) return undefined;
    const self = this.host.self(), st = this.host.reps.at(self, this.snapTick), ship = this.host.store.get(self);
    if (!st || !ship) return undefined;
    const body = ownBodyHash(st.body, st.bits, st.q), hp = ownHpHash(ship.hp);
    if (!riding && body === this.last.body && hp === this.last.hp) return undefined;
    this.last = { tick, snap: this.snapTick, body, hp };
    this.stats.checks++;
    return { body, hp, tick: this.snapTick & 0xfff };
  }
}

function shapeOf(ship: ShipState, d: ShipDerived, geom: PlacedGeom[]): OwnShape {
  return { geom, alive: d.alive, com: d.com, mass: d.mass, radius: d.radius, big: ship.blueprint.parts.length > CONTACT_BIG_BODY };
}
