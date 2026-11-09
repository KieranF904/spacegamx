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
 * Its step is the whole one (Stage 3b: step): the one stepper (common sim/ownStep.ts stepOwnShip) on its full state,
 * stores, guns, hazards and priming kept here by tick, its guns' fire events kept by tick for the drawing side to take
 * (takeEvents, once per tick as the prediction reaches it). It is stepped up to the prediction's tick and drawn from
 * there (ShipClient.ownStepTo / ownPose): its ship is stepped once a tick, not once here and once by a prediction.
 *
 * Its check (takeCheck): a hash of its full state (common sim/headHash.ts ownStateHash) at the last snapshot's tick
 * on an input that goes anyway, as often as its record calls for: NORMAL to start, ROUGH after a clean stretch, STRICT
 * after the server had to fix it (a keyframe of its own ship after the first), stepping back down after each clean one.
 * A snapshot's head hash it disagrees with sends it at once. Put right: its keyframe (the pose) and an ownSync (the
 * rest, exact: onOwnSync).
 */
import {
  applyOwnCauses, applyCauseRows, cargoBefore, buildFlightInputs, controlBits, quantizeReplicaAngle, unpackControlRow, controlRowId, ownBodyHash, ownHpHash,
  ownCheckRules, CONFIRM, CONTACT_BIG_BODY, OWN_CAUSE, CONTACT_FLAG, placeRows, pairPlace, type CauseRow,
  type OwnTimeline, type ShipReplicaSet, type ShipDerived, type ShipState, type ShipTuning, type FlightBody, type OwnCheck,
  type OwnCauseEnv, type OwnShape, type PlacedGeom, type ServerSnapshotMessage, type ClientInputMessage, type Vec2,
  headAgrees, headHashOfWord, ownStateHash, pilotAimQ, cloneCharge, stepOwnShip, ownStructure, seedOwnExtras, unpackOwnSync, ownSyncHazards, remapCharge, NO_OWN_INPUT, type HeadHash, type HazardState,
  type OwnExtras, type OwnInputExtras, type ServerOwnSyncMessage, type SimShipState, type SimEvent, type SimEnv, type FieldEnv, type ReplicaEnv,
} from '@space-game/common';
import type { StructSource } from '../ShipStore.js';
import type { ContactWorld } from '../causes/ContactWorld.js';
import { MidCursors } from '../causes/MidCursors.js';
import { aheadContacts } from './ownAhead.js';

export interface OwnTickHost {
  /** The ships' structures (its own and the others it touches) */
  store: StructSource;
  reps: ShipReplicaSet;
  /** Its own ship's id */
  self(): number;
  tuning: ShipTuning;
  /** What its check's state byte adds for a snapshot (CAPS.CAUSES: every other ship it holds, ShipCauses.heldByte) */
  extraHash?(tick: number): number | undefined;
  /** The contact pairs it finds itself (CAPS.CONTACTS), when it does */
  contacts?(): ContactWorld | null;
  /** Another ship on tick t just before the cause at `place` (ShipCauses.midOf): what a pair found here reads of it */
  otherMid?(id: number, t: number, place: number): FlightBody | null;
}

/** Ticks of inputs kept (a snapshot window is never this far behind the inputs it needs) */
const KEEP_TICKS = 600;
/** Ticks of full states and their events kept (the replica set keeps 240 of its own) */
const KEEP_STATES = 300;
/** Ticks of fire events handed out at most at once (a long stall's are not drawn: they are long gone) */
const PRESENT_TICKS = 8;

/** The own step's env (stepOwnShip's: guns in the step), filled from the replica set's world each tick */
const OWN_FIELDS: FieldEnv = { central: null };
const OWN_ENV: SimEnv = { tick: 0, tuning: undefined as unknown as SimEnv['tuning'], gravity: null, fields: OWN_FIELDS, terrain: null };

/** What takeEvents hands out: a tick's events and its full state after its step */
export interface OwnTickEvents { tick: number; events: SimEvent[]; state: Readonly<SimShipState> }
/** Clean ticks for its check to step down a level (as part E's) */
const CLEAN_TICKS = 600;

export class OwnTick implements OwnTimeline {
  /** Its own replica is stepped from here (from its welcome: start); before that there is no ship of its own */
  on = false;
  private id = -1;
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
  readonly stats = { inputs: 0, causes: 0, failed: 0, fixes: 0, exc: 0, checks: 0, heads: 0, headMisses: 0, syncs: 0, ahead: 0 };
  /** The newest snapshot's head hash, to judge at its next check (sim/headHash.ts), and a miss not yet sent */
  private head: { tick: number; h: HeadHash } | null = null;
  private missed = false;
  /** Its inputs' fire, jump and aim distance from their target ticks (held between): parallel, by tick */
  private readonly inTicks: number[] = [];
  private readonly inVals: OwnInputExtras[] = [];
  /**
   * Its raw aim from each tick it changed (its inputs by target tick, and the server's exception rows where it said):
   * parallel, by tick. Between changes the replica set holds the controls the ship flew, whose aim is the applied one
   * (common sim/aimHold.ts), not what its inputs say, so the step takes its raw aim from here (aimAt)
   */
  private readonly aimTicks: number[] = [];
  private readonly aimQs: number[] = [];
  /** Its full state after each tick's step, before that tick's causes (where its guns fired, what they did) */
  private readonly stepped = new Map<number, SimShipState>();
  /** Its stores, guns, hazards and priming as each tick ended (after its causes: a rebuild's stores remapped) */
  private readonly full = new Map<number, OwnExtras>();
  /** Each tick's fire and fx events, as last stepped, and the newest tick they were handed out through */
  private readonly evs = new Map<number, SimEvent[]>();
  private presented = -Infinity;
  /** ...and the newest tick a snapshot confirmed them through (takeConfirmed), and the tick of the newest ownSync */
  private confirmedTo = -Infinity;
  syncedAt = -Infinity;
  /** The server's extras by the tick they ended (ownSync): a step of that tick ends with these, whatever it worked out */
  private readonly synced = new Map<number, OwnExtras>();
  /** ...or its hazards alone (an ownSync of them: packOwnHazards): that tick ends with these, the rest its own */
  private readonly hazTold = new Map<number, HazardState>();
  /** What it starts from with nothing earlier (its record's gun state, full stores) */
  private seed: OwnExtras | null = null;
  /** The weapon groups selection as the inputs sent so far have it (packGroupSel) */
  private sel = 0;
  /** Its contacts predicted past the newest snapshot, by tick (ownAhead.ts: stepped again from each snapshot) */
  private readonly ahead = new Map<number, CauseRow[]>();
  /** Ships the server said were pinned when its ship last touched them (OTHER_PINNED): a predicted contact takes them so */
  private readonly pinned = new Set<number>();

  constructor(private readonly host: OwnTickHost) {}

  /** Its pilot is known (welcome): its own replica is stepped from here from now on (again, if its ship changed) */
  start(): void {
    const id = this.host.self();
    if (this.on && id === this.id) return;
    this.on = true;
    this.id = id;
    this.causes.clear();
    this.until = null;
    this.keyed = false;
    this.stepped.clear(); this.full.clear(); this.evs.clear();
    this.presented = -Infinity;
    this.confirmedTo = -Infinity;
    this.syncedAt = -Infinity;
    this.synced.clear();
    this.hazTold.clear();
    this.seed = null;
    this.sel = 0;
    this.ahead.clear();
    this.pinned.clear();
    this.host.reps.setOwn(id, this);
  }

  /** An input it sent (kept from before its start too: the inputs already sent ahead are needed) */
  noteInput(msg: ClientInputMessage): void {
    const t = msg.targetTick;
    if (t === undefined) return;
    // (The aim as the server's step flies it (pilotAimQ): what its control rows say and its head hash hashes)
    const q = pilotAimQ(Number(msg.targetAngle) || 0);
    this.ctls.set(t, [controlBits(buildFlightInputs(msg, false)), q]);
    this.setAim(t, q);
    const dist = Number(msg.cursorDist) || 0;
    // (The weapon groups selection is state: an input carries it only where it changes, so the rest hold the last: weaponGroups.ts)
    if (msg.weaponGroups !== undefined) this.sel = msg.weaponGroups;
    this.noteExtras(t, { fire: !!msg.fireLeft, fireAlt: !!msg.fireRight, jumpDist: dist, aimDist: dist, sel: this.sel });
    this.stats.inputs++;
    if (this.ctls.size > KEEP_TICKS) for (const k of [...this.ctls.keys()]) if (k < t - KEEP_TICKS) this.ctls.delete(k);
    if (this.on) this.host.reps.rewind(this.host.self(), t);
  }

  private noteExtras(t: number, v: OwnInputExtras): void {
    const ts = this.inTicks;
    let i = ts.length;
    while (i > 0 && ts[i - 1] > t) i--;
    if (i > 0 && ts[i - 1] === t) this.inVals[i - 1] = v;
    else { ts.splice(i, 0, t); this.inVals.splice(i, 0, v); }
    if (ts.length > 256) { const cut = ts.findIndex((k) => k >= t - KEEP_TICKS); if (cut > 0) { ts.splice(0, cut); this.inVals.splice(0, cut); } }
  }

  private setAim(t: number, q: number): void {
    const ts = this.aimTicks;
    let i = ts.length;
    while (i > 0 && ts[i - 1] > t) i--;
    if (i > 0 && ts[i - 1] === t) this.aimQs[i - 1] = q;
    else { ts.splice(i, 0, t); this.aimQs.splice(i, 0, q); }
    // (the newest change before the oldest tick kept stays: it is the aim from there on)
    if (ts.length > 256) { const cut = ts.findIndex((k) => k >= t - KEEP_TICKS); if (cut > 1) { ts.splice(0, cut - 1); this.aimQs.splice(0, cut - 1); } }
  }

  /** Its raw aim on tick t (the newest change at or before it; undefined: none known) */
  aimAt(t: number): number | undefined {
    const ts = this.aimTicks;
    let lo = 0, hi = ts.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 ? this.aimQs[at] : undefined;
  }

  /** Its input's fire, jump and aim distance on tick t (the newest with a target tick at or before it) */
  inputAt(t: number): Readonly<OwnInputExtras> {
    const ts = this.inTicks;
    let lo = 0, hi = ts.length - 1, at = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ts[m] <= t) { at = m; lo = m + 1; } else hi = m - 1; }
    return at >= 0 ? this.inVals[at] : NO_OWN_INPUT;
  }

  /** Its stores, guns, hazards and priming as tick t ended (undefined: not stepped there) */
  extrasAt(t: number): Readonly<OwnExtras> | undefined {
    return this.full.get(t);
  }

  /** Its full state after tick t's step, before its causes (undefined: not stepped there) */
  steppedAt(t: number): Readonly<SimShipState> | undefined {
    return this.stepped.get(t);
  }

  /** What it ended the newest tick before t with (a keyframe's tick has none of its own: its path's before it) */
  private extrasBefore(t: number): OwnExtras | undefined {
    const x = this.full.get(t - 1);
    if (x) return x;
    let best = -Infinity;
    for (const k of this.full.keys()) if (k < t && k > best) best = k;
    return best > -Infinity ? this.full.get(best) : undefined;
  }

  /**
   * Tick t's whole step (OwnTimeline.step: the replica set asks, for every tick it steps its own ship flown): the one
   * stepper on its full state from what tick t - 1 ended with, its guns' events kept for the drawing side (takeEvents)
   */
  step(t: number, body: FlightBody, bits: number, q: number, derived: ShipDerived, env: ReplicaEnv, heldQ: number): Readonly<{ bits: number; q: number }> | null {
    const self = this.host.self(), ship = this.host.store.get(self);
    if (!this.on || !ship || ship.kind !== 'ship') return null;
    const prev = this.extrasBefore(t) ?? (this.seed ??= seedOwnExtras(ship));
    OWN_ENV.tick = t; OWN_ENV.tuning = this.host.tuning; OWN_ENV.gravity = env.gravity; OWN_ENV.terrain = env.terrain ?? null; OWN_ENV.hazard = env.hazard;
    // (Its pulls: the fields' it works out, or what the server told for the tick, pulls(t); in its step, after the motion)
    OWN_ENV.pulls = env.pulls;
    // (Docking Clamps, common sim/clampPair.ts: steering, it flies the pair; the other pilot, it rides the leader's replica)
    OWN_ENV.clamp = env.clamp;
    OWN_FIELDS.central = env.central; OWN_FIELDS.lodestones = env.lodestones;
    const events: SimEvent[] = [];
    // (On its raw aim (its inputs': `q`, held between changes, is the applied one) and the one it was applied at last tick:
    // its state's applied aim, as the server works it out, sim/aimHold.ts)
    const raw = this.aimAt(t) ?? q;
    const s = stepOwnShip(self, prev, body, bits, raw, this.inputAt(t), ownStructure(derived, ship), OWN_ENV, events, heldQ);
    this.stepped.set(t, s);
    this.evs.set(t, events);
    if (this.stepped.size > KEEP_STATES + 64) for (const mp of [this.stepped, this.full, this.evs] as Map<number, unknown>[]) for (const k of [...mp.keys()]) if (k < t - KEEP_STATES) mp.delete(k);
    return s.ctl;
  }

  /** Tick t's step done and its causes worked out: what it ended the tick with (a rebuild's stores remapped) */
  private finish(t: number): void {
    const s = this.stepped.get(t);
    if (!s) return;
    // (The server said how this tick ended: that, exact (its snapshot steps this tick again after the ownSync came))
    const told = this.synced.get(t);
    if (told) { this.full.set(t, told); return; }
    const x: OwnExtras = { charge: s.charge, guns: s.guns, hazard: this.hazTold.get(t) ?? s.hazard, jumpPrime: s.jumpPrime };
    // (A rebuild at the tick's end (the structure it flies the next tick with isn't this one's) moves the stores to the new
    // structure, as the server's rebuild does)
    const was = this.derived(t), now = this.derived(t + 1);
    if (was && now && was !== now) x.charge = remapCharge(was, now, cloneCharge(x.charge));
    this.full.set(t, x);
  }

  /**
   * The fire and fx events of the ticks after the last handed out, through tick `through` (the prediction's newest),
   * as each was last stepped; at most the newest `cap` (a stall's are not drawn)
   */
  takeEvents(through: number, out: OwnTickEvents[] = [], cap = PRESENT_TICKS): OwnTickEvents[] {
    this.eventsFrom(Math.max(this.presented + 1, through - cap + 1), through, out);
    if (through > this.presented) this.presented = through;
    return out;
  }

  /**
   * The fire and fx events of the ticks a snapshot at `through` confirms (those after the last it confirmed), as its
   * layer has them now, the snapshot's keyframe, causes and ownSync in: what its own shells are built from (OwnShells)
   */
  takeConfirmed(through: number, out: OwnTickEvents[] = []): OwnTickEvents[] {
    this.eventsFrom(Math.max(this.confirmedTo + 1, through - KEEP_STATES + 1), through, out);
    if (through > this.confirmedTo) this.confirmedTo = through;
    return out;
  }

  private eventsFrom(from: number, through: number, out: OwnTickEvents[]): void {
    out.length = 0;
    if (!Number.isFinite(from)) { from = through + 1; for (const k of this.evs.keys()) if (k < from) from = k; }
    for (let t = from; t <= through; t++) {
      const events = this.evs.get(t), state = this.stepped.get(t);
      if (events && state) out.push({ tick: t, events, state });
    }
  }

  /**
   * The server's word on its stores, guns, hazards and priming as tick m.t ended (exact; it comes just before that
   * tick's snapshot): taken as that tick's, and its ship stepped again from the next (its pose comes by its keyframe).
   * That window's own shells are the server's to tell, as a keyframed window's are (syncedAt: ShipClient.preSnapshot)
   */
  onOwnSync(m: ServerOwnSyncMessage): void {
    if (!this.on) return;
    if (!m.c) {
      // (Its hazards alone: a hazard the server decided. That tick ends with them, and it's stepped again from the next;
      // the ticks it already flew under it come with the snapshot's control row. Its own shells' window is still its own)
      const h = ownSyncHazards(m), had = this.full.get(m.t);
      this.hazTold.set(m.t, h);
      if (this.hazTold.size > 8) this.hazTold.delete(this.hazTold.keys().next().value!);
      if (had) this.full.set(m.t, { ...had, hazard: h });
      this.stats.syncs++;
      this.host.reps.rewind(this.host.self(), m.t + 1);
      return;
    }
    const x = unpackOwnSync(m), ship = this.host.store.get(this.host.self());
    if (ship) x.charge = seedOwnExtras({ derived: ship.derived }, x.charge).charge;
    this.full.set(m.t, x);
    this.synced.set(m.t, x);
    if (this.synced.size > 8) this.synced.delete(this.synced.keys().next().value!);
    this.syncedAt = m.t;
    this.stats.syncs++;
    this.host.reps.rewind(this.host.self(), m.t + 1);
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
    // frame's structure and causes were in, a boss's body reading its target)
    let earliest = prev + 1;
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
      // (Its aims there are the server's too: its raw ones, Replication's exception row)
      for (let i = this.aimTicks.length - 1; i >= 0; i--) if (this.aimTicks[i] >= lo && this.aimTicks[i] <= m.tick) { this.aimTicks.splice(i, 1); this.aimQs.splice(i, 1); }
      for (const [ago, , q] of ev) this.setAim(m.tick - ago, q);
      earliest = Math.min(earliest, lo);
      this.stats.exc++;
    }
    for (const r of m.own ?? []) {
      const t = m.tick - r[0];
      const at = this.causes.get(t);
      if (at) at.push(r.slice(1)); else this.causes.set(t, [r.slice(1)]);
      earliest = Math.min(earliest, t);
      this.stats.causes++;
      if (r[1] === OWN_CAUSE.CONTACT) {
        const os = this.host.store.get(r[2]);
        if (os) this.kept.set(t + ':' + r[2], os);
        if (r[3] & CONTACT_FLAG.OTHER_PINNED) this.pinned.add(r[2]); else this.pinned.delete(r[2]);
      }
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
    // (What it predicted up to here is the snapshot's now; ids gone from its view needn't be remembered)
    for (const k of [...this.ahead.keys()]) if (k <= m.tick) this.ahead.delete(k);
    for (const id of m.removed ?? []) this.pinned.delete(id);
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

  /**
   * Its pulls on tick t as the server told them (where it can't work them out: a pull only the server has, or a field
   * whose puller it doesn't hold as the server had it): its step takes all of them in place of the fields' (common
   * network/ownTick.ts PULL). Undefined: none told, its step works its pulls out itself
   */
  pulls(t: number): readonly (readonly number[])[] | undefined {
    const rows = this.causes.get(t);
    return rows?.some((r) => r[0] === OWN_CAUSE.PULL) ? rows : undefined;
  }

  /** Finding contact pairs itself (ContactWorld) */
  private finds(): ContactWorld | null {
    return this.host.contacts?.() ?? null;
  }

  /**
   * Its causes on tick t in the order the server's step had them: those told and (CAPS.CONTACTS) the pairs found here,
   * each by its place in the pass
   */
  rowsAt(t: number): CauseRow[] | undefined {
    // (Past the newest snapshot (its ship stepped ahead, the prediction): no pairs found there. What it would touch
    // isn't known yet, and the other ships aren't stepped ahead for it; the snapshot's window finds them once, final)
    const told = this.causes.get(t), w = t <= this.snapTick ? this.finds() : null;
    // (...but its own contacts there are predicted, as it was stepped: ownAhead.ts)
    if (!told && t > this.snapTick) return this.ahead.get(t);
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
    // (Past the newest snapshot, nothing told: its contacts predicted from its body after this step, ownAhead.ts)
    const ahead = t > this.snapTick && !this.causes.has(t);
    if (ahead) this.predictAhead(t, body);
    const rows = this.rowsAt(t);
    this.finish(t);
    if (!rows) return;
    this.fired.set(t, { ...body });
    if (this.fired.size > 64) for (const k of [...this.fired.keys()]) if (k < t - KEEP_TICKS) this.fired.delete(k);
    // (Finding pairs itself: through its cursor, the states others read of it kept, MidCursors)
    if (this.finds() && t <= this.snapTick) { if (!this.cursors.after(this.host.self(), t, body, () => ({ pre: body, rows, env: this.env(t) }))) this.stats.failed++; return; }
    if (!applyOwnCauses(body, rows.map((r) => r.row), ahead ? this.aheadEnv(t) : this.env(t))) this.stats.failed++;
  }

  /** Did the server say ship `id` was pinned when its ship last touched it (the PT layer's pass takes it so: predict/world.ts)? */
  pinnedOther(id: number): boolean {
    return this.pinned.has(id);
  }

  /** Its contacts on tick t past the newest snapshot, predicted (ownAhead.ts) and kept for rowsAt until a snapshot covers t */
  private predictAhead(t: number, body: FlightBody): void {
    const d = this.derived(t);
    const rows = d && d.mass > 0 ? aheadContacts(this.host, t, body, d.radius, (id) => this.pinned.has(id)) : undefined;
    if (rows) { this.ahead.set(t, rows); this.stats.ahead += rows.length; } else this.ahead.delete(t);
  }

  /**
   * The env a predicted contact is worked out with: the other's structure as it has it now, its pose from the row
   * (CONTACT_FLAG.STATE), nothing stepped for it (it's part way through its own ship's step)
   */
  private aheadEnv(t: number): OwnCauseEnv {
    const store = this.host.store;
    return {
      ...this.env(t),
      other: (id) => {
        const ship = store.get(id);
        return ship ? { shape: shapeOf(ship, store.derivedAt?.(id, t) ?? ship.derived, store.geometry(ship)), body: { x: 0, y: 0, angle: 0, vx: 0, vy: 0 } } : null;
      },
    };
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
    const st = this.host.reps.at(self, hd.tick), x = this.full.get(hd.tick);
    this.stats.heads++;
    if (headAgrees(hd.h, st && x ? ownStateHash(self, st.body, st.bits, st.q, x, hd.tick) : undefined)) return;
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
    const self = this.host.self(), docked = this.host.reps.docked(self), st = docked ?? this.host.reps.at(self, this.snapTick), ship = this.host.store.get(self);
    if (!st || !ship) return undefined;
    // (Its full state, as the head hash has it; docked, its keyframe's pose, as the server holds it)
    const x = docked ? undefined : this.full.get(this.snapTick);
    const own = x ? ownStateHash(self, st.body, st.bits, st.q, x, this.snapTick) : ownBodyHash(st.body, st.bits, st.q);
    const body = (own + (this.host.extraHash?.(this.snapTick) ?? 0)) & 0xff, hp = ownHpHash(ship.hp);
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
