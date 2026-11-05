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
  applyOwnCauses, applyCauseRows, cargoBefore, buildFlightInputs, controlBits, quantizeReplicaAngle, unpackControlRow, controlRowId, ownBodyHash, ownHpHash,
  ownCheckRules, CONFIRM, CONTACT_BIG_BODY, OWN_CAUSE, CONTACT_FLAG, placeRows, pairPlace, type CauseRow,
  type OwnTimeline, type ShipReplicaSet, type ShipDerived, type ShipState, type ShipTuning, type FlightBody, type OwnCheck,
  type OwnCauseEnv, type OwnShape, type PlacedGeom, type ServerSnapshotMessage, type ClientInputMessage, type Vec2,
  headAgrees, headHashOfWord, ownHeadHash, type HeadHash,
} from '@space-game/common';
import type { StructSource } from '../ShipStore.js';
import type { ContactWorld } from '../causes/ContactWorld.js';
import { MidCursors } from '../causes/MidCursors.js';

export interface OwnTickHost {
  /** The ships' structures (its own and the others it touches) */
  store: StructSource;
  reps: ShipReplicaSet;
  /** Its own ship's id */
  self(): number;
  tuning: ShipTuning;
  /**
   * Is anything stepping on its layer able to read its ship before a snapshot's structure and causes are in (a boss's
   * body reading its target, CAPS.BODIES)? Then each snapshot steps it again from just after the last. Unset: always
   */
  restep?(): boolean;
  /** What its check's state byte adds for a snapshot (CAPS.CAUSES: every other ship it holds, ShipCauses.heldByte) */
  extraHash?(tick: number): number | undefined;
  /** The contact pairs it finds itself (CAPS.CONTACTS), when it does */
  contacts?(): ContactWorld | null;
  /** Another ship on tick t just before the cause at `place` (ShipCauses.midOf): what a pair found here reads of it */
  otherMid?(id: number, t: number, place: number): FlightBody | null;
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
  /** A contact's other as the snapshot found it (it may be gone by the time its ship is stepped: removed in that very snapshot) */
  private kept = new Map<string, ShipState>();
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
  readonly stats = { inputs: 0, causes: 0, failed: 0, fixes: 0, exc: 0, checks: 0, heads: 0, headMisses: 0 };
  /** The newest snapshot's head hash, to judge at its next check (sim/headHash.ts), and a miss not yet sent */
  private head: { tick: number; h: HeadHash } | null = null;
  private missed = false;

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
    // (Its head hash: judged once the snapshot is all in, at the next check)
    if (m.hh !== undefined) this.head = { tick: m.tick, h: headHashOfWord(m.hh) };
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
      if (r[1] === OWN_CAUSE.CONTACT) { const os = this.host.store.get(r[2]); if (os) this.kept.set(t + ':' + r[2], os); }
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
    for (const mp of [this.touched, this.kept] as Map<string, unknown>[]) if (mp.size > 64) for (const k of [...mp.keys()]) if (Number(k.split(':')[0]) < m.tick - KEEP_TICKS) mp.delete(k);
    if (this.causes.size > 64) for (const t of [...this.causes.keys()]) if (t < m.tick - KEEP_TICKS) this.causes.delete(t);
    if (earliest <= m.tick) this.host.reps.rewind(self, earliest);
  }

  // ---- OwnTimeline (ShipReplicaSet steps its own ship from these) ----

  ctl(t: number): readonly [number, number] | undefined {
    return this.ctls.get(t);
  }

  derived(t: number): ShipDerived | null | undefined {
    // (Each structure kept by its tick, CAPS.STRUCTS: the one it flew then)
    const kept = this.host.store.derivedAt?.(this.host.self(), t);
    if (kept) return kept;
    if (this.until && t <= this.until.tick) return this.until.derived;
    return this.host.store.get(this.host.self())?.derived;
  }

  /** Before its step at tick t: a CARGO cause, the hold's mass it flies the step with */
  preStep(t: number, body: FlightBody): void {
    const rows = this.causes.get(t);
    if (rows) cargoBefore(body, rows);
  }

  /** Finding contact pairs itself (CAPS.CONTACTS: ContactWorld) */
  private finds(): ContactWorld | null {
    const w = this.host.contacts?.();
    return w?.on ? w : null;
  }

  /**
   * Its causes on tick t in the order the server's step had them: those told and (CAPS.CONTACTS) the pairs found here,
   * each by its place in the pass
   */
  rowsAt(t: number): CauseRow[] | undefined {
    const told = this.causes.get(t), w = this.finds();
    if (!w) return told?.map((row, i) => ({ seq: i, row }));
    const self = this.host.self(), found = w.rowsFor(self, t);
    const pl = told ? placeRows(self, told) : [];
    const all: CauseRow[] = told ? told.map((row, i) => ({ seq: pl[i], row })) : [];
    if (found) {
      const have = new Set<number>();
      for (const r of all) if (r.row[0] === OWN_CAUSE.CONTACT) have.add(r.seq);
      for (const r of found) if (!have.has(r.seq)) all.push(r);
      all.sort((a, b) => a.seq - b.seq);
    }
    return all.length ? all : undefined;
  }

  after(t: number, body: FlightBody): void {
    const rows = this.rowsAt(t);
    if (!rows) return;
    this.fired.set(t, { ...body });
    if (this.fired.size > 64) for (const k of [...this.fired.keys()]) if (k < t - KEEP_TICKS) this.fired.delete(k);
    // (Finding pairs itself: through its cursor, the states others read of it kept, MidCursors)
    if (this.finds()) { if (!this.cursors.after(this.host.self(), t, body, () => ({ pre: body, rows, env: this.env(t) }))) this.stats.failed++; return; }
    if (!applyOwnCauses(body, rows.map((r) => r.row), this.env(t))) this.stats.failed++;
  }

  /** Its ship part way through a tick's causes, worked out once (CAPS.CONTACTS) */
  readonly cursors = new MidCursors();

  private env(t: number): OwnCauseEnv {
    const { store, reps, tuning } = this.host;
    const self = store.get(this.host.self());
    const d = this.derived(t);
    return {
      cellSize: tuning.cellSize,
      restitution: tuning.collision?.restitution ?? 0.3,
      self: self && d ? shapeOf(self, d, store.geometry(self)) : null,
      other: (id) => {
        // (Its replica on that tick before its own causes there: CAPS.CAUSES works them out on it, ShipReplicaSet.preAt;
        // finding pairs itself, CAPS.CONTACTS, as the pass had it just before this pair: its causes before it too)
        const w = this.finds();
        const ship = store.get(id) ?? this.kept.get(t + ':' + id), at = w && this.host.otherMid ? this.host.otherMid(id, t, pairPlace(this.host.self(), id)) : reps.preAt(id, t);
        // (No replica of it left, removed in that snapshot: the row carries its state, the server sees to that)
        return ship ? { shape: shapeOf(ship, store.derivedAt?.(id, t) ?? this.touched.get(t + ':' + id) ?? ship.derived, store.geometry(ship)), body: at ? { x: at.x, y: at.y, angle: at.angle, vx: at.vx, vy: at.vy } : { x: 0, y: 0, angle: 0, vx: 0, vy: 0 } } : null;
      },
      rebuilt: () => {
        const kept = store.rebuildAt?.(this.host.self(), t);
        if (kept !== undefined) return kept;
        return this.until && this.until.tick === t ? { from: this.until.from, to: this.until.to } : null;
      },
    };
  }

  /**
   * Its ship on tick t as the contact pass had it when it touched `other`: before that tick's causes, then its causes
   * before that contact (a contact another ship's replica works out with it, ShipCauses)
   */
  midOf(t: number, other: number): FlightBody | null {
    if (this.finds()) return this.midAt(t, pairPlace(this.host.self(), other));
    const pre = this.host.reps.preAt(this.host.self(), t);
    const rows = this.causes.get(t);
    const at = rows?.findIndex((r) => r[0] === OWN_CAUSE.CONTACT && r[1] === other) ?? -1;
    if (!pre || at <= 0) return pre;
    const body = { ...pre };
    if (!applyCauseRows(body, rows!.slice(0, at), this.env(t))) this.stats.failed++;
    return body;
  }

  /** Its ship on tick t just before the cause at `place` (CAPS.CONTACTS: its causes before that one, unrounded) */
  midAt(t: number, place: number): FlightBody | null {
    if (this.finds()) {
      const self = this.host.self();
      return this.cursors.mid(self, t, place, () => { const pre = this.host.reps.preAt(self, t); return pre && { pre, rows: this.rowsAt(t) ?? [], env: this.env(t) }; });
    }
    const pre = this.host.reps.preAt(this.host.self(), t);
    const earlier = this.rowsAt(t)?.filter((r) => r.seq < place);
    if (!pre || !earlier?.length) return pre;
    const body = { ...pre };
    if (!applyCauseRows(body, earlier.map((r) => r.row), this.env(t))) this.stats.failed++;
    return body;
  }

  /** Where its ship was as its guns fired on tick t (its fire events' shells are built from this, ShipClient.preSnapshot) */
  firePose(t: number): FlightBody | null {
    const st = this.host.reps.at(this.host.self(), t);
    if (!st) return null;
    return (this.rowsAt(t) ? this.fired.get(t) : undefined) ?? st.body;
  }

  // ---- Its check ----

  /**
   * The newest snapshot's head hash against its own ship on its layer at that tick (common sim/headHash.ts): held
   * and not keyed in that snapshot, they must agree; a miss sends its check at once (takeCheck), which the server
   * judges and puts right (its own ship keyed, its row with it)
   */
  private judgeHead(): void {
    const hd = this.head;
    if (!hd) return;
    this.head = null;
    const self = this.host.self();
    if (this.host.reps.docked(self)) return;
    const st = this.host.reps.at(self, hd.tick);
    this.stats.heads++;
    if (headAgrees(hd.h, st ? ownHeadHash(self, st.body, st.bits, st.q) : undefined)) return;
    this.stats.headMisses++;
    this.missed = true;
  }

  /** Did the newest snapshot's head hash agree with its layer (tests)? Judges it now if it wasn't yet */
  headOk(): boolean {
    this.judgeHead();
    return !this.missed;
  }

  /**
   * Its check, if one is due (`riding`: an input goes anyway; else only after its level's `alone` ticks, and only if
   * its state changed since the last): a hash of its own ship as of the last snapshot's tick
   */
  takeCheck(riding: boolean, tick: number): OwnCheck | undefined {
    if (!this.on || !this.keyed) return undefined;
    this.judgeHead();
    // (Its layer disagreed with a snapshot's head hash: the check goes now, whatever its level, sim/headHash.ts)
    const force = this.missed;
    if (!force && this.snapTick === this.last.snap) return undefined;
    // (A clean stretch at a level steps it down one)
    if (this.level > CONFIRM.ROUGH && tick - this.levelSince >= CLEAN_TICKS) { this.level--; this.levelSince = tick; }
    const rules = ownCheckRules(this.level), since = tick - this.last.tick;
    if (!force && (since < rules.ride || (!riding && since < rules.alone))) return undefined;
    // (Docked: as its keyframe had it, the server's too: Replication.ownHeld)
    const self = this.host.self(), st = this.host.reps.docked(self) ?? this.host.reps.at(self, this.snapTick), ship = this.host.store.get(self);
    if (!st || !ship) return undefined;
    const body = (ownBodyHash(st.body, st.bits, st.q) + (this.host.extraHash?.(this.snapTick) ?? 0)) & 0xff, hp = ownHpHash(ship.hp);
    if (!force && !riding && body === this.last.body && hp === this.last.hp) return undefined;
    this.missed = false;
    this.last = { tick, snap: this.snapTick, body, hp };
    this.stats.checks++;
    return { body, hp, tick: this.snapTick & 0xfff };
  }
}

function shapeOf(ship: ShipState, d: ShipDerived, geom: PlacedGeom[]): OwnShape {
  return { geom, alive: d.alive, com: d.com, mass: d.mass, radius: d.radius, big: ship.blueprint.parts.length > CONTACT_BIG_BODY };
}
