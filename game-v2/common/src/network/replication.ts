/**
 * Ship motion on the wire (see ships/replica.ts). A snapshot carries:
 *
 *   ships  keyframes, only for ships a client is new to or that left the
 *          path their controls predicted:
 *          [id, mode, x, y, vx, vy, angle, angVel, jump, jumpScale, bits, q, cargo?, station?, ox?, oy?, dodge?, dodgeDir?]
 *          (cargo, the hold's mass, goes when it's set or the ship is docked or
 *          has dodged; station -1 when it isn't docked but a Burst Strafer's
 *          counter and way follow)
 *   ctl    control changes since the last snapshot, per ship:
 *          [id, tb, dq, tb, dq, ...]  where tb = bits × 8 + ticksAgo
 *          (ticksAgo counts back from the snapshot's tick: the step at that tick
 *          used them; one of 7 or more goes as tb = bits × 8 + 7, then ticksAgo)
 *          or, for the common case of the aim moving tick after tick with the
 *          same buttons held, [-1 - id, tb, dq, dq, dq, ...]: one change per tick
 *          from ticksAgo on (packControlRow). Each aim goes as the step
 *          from the one before, the first from the aim the client already has
 *          (its keyframe's or last change's: both ends keep it), wrapped to ±4096.
 *
 * q is the aim angle in the 13-bit cursor quantization; a pilot's arrives as a
 * float32 (the input encoding), so it's rounded the same way here.
 */

import { ReplicaMode, ReplicaControls, ReplicaEnv, FlightBody, ShipTuning, ShipDerived, replicaStep } from '../ships/index.js';
import { stepDebrisWorld, type DebrisBody } from '../ships/debris.js';
import { SHIP_FLIGHT_CONSTANTS } from '../ships/physics.js';
import type { Vec2 } from '../ships/types.js';

/** A piece of debris's shape for the knocks (ShipReplicaSet's debrisShape): its mass, radius, centre and convex pieces */
export interface DebrisShape { mass: number; radius: number; com: Vec2; pieces: readonly (readonly Vec2[])[] }
import { quantizeCursorAngle, dequantizeCursorAngle } from './cursorState.js';
import { dhypot } from '../math/detTrig.js';

export type KeyframeRow = number[];
export type ControlRow = number[];

/** The aim angle a step uses, from its quantized form */
export function replicaAngle(mode: ReplicaMode, q: number): number {
  const a = dequantizeCursorAngle(q);
  return mode === ReplicaMode.Player ? Math.fround(a) : a;
}

export function quantizeReplicaAngle(a: number): number {
  return quantizeCursorAngle(a);
}

export interface Keyframe {
  id: number;
  mode: ReplicaMode;
  body: FlightBody;
  ctl: ReplicaControls;
  q: number;
  /** Docked: the station entity and the offset from it */
  dock?: { station: number; ox: number; oy: number };
}

export function packKeyframe(k: Keyframe): KeyframeRow {
  const b = k.body;
  const row = [k.id, k.mode, b.x, b.y, b.vx, b.vy, b.angle, b.angVel, b.jump ?? 0, b.jumpScale ?? 1, k.ctl.bits, k.q];
  const dodge = !!(b.dodge || b.dodgeDir);
  if (k.dock || b.cargo || dodge) row.push(b.cargo ?? 0);
  if (k.dock) row.push(k.dock.station, Math.round(k.dock.ox * 100) / 100, Math.round(k.dock.oy * 100) / 100);
  else if (dodge) row.push(-1, 0, 0);
  // (The Burst Strafer's counter and the way it last dodged: ships/features/strafer)
  if (dodge) row.push(b.dodge ?? 0, b.dodgeDir ?? 0);
  return row;
}

export function unpackKeyframe(r: KeyframeRow): Keyframe {
  const mode = r[1] as ReplicaMode;
  return {
    id: r[0], mode,
    body: { x: r[2], y: r[3], vx: r[4], vy: r[5], angle: r[6], angVel: r[7], jump: r[8], jumpScale: r[9], ...(r[12] ? { cargo: r[12] } : {}), ...(r[16] ? { dodge: r[16] } : {}), ...(r[17] ? { dodgeDir: r[17] } : {}) },
    ctl: { bits: r[10], targetAngle: replicaAngle(mode, r[11]) },
    q: r[11],
    dock: r.length > 13 && r[13] >= 0 ? { station: r[13], ox: r[14], oy: r[15] } : undefined,
  };
}

const AIM_Q = 8192;
const stepQ = (from: number, to: number) => ((to - from) % AIM_Q + AIM_Q + AIM_Q / 2) % AIM_Q - AIM_Q / 2;
const addQ = (q: number, d: number) => ((q + d) % AIM_Q + AIM_Q) % AIM_Q;

/**
 * A ship's control changes as a row; events are [ticksAgo, bits, q] oldest
 * first, `base` the aim the client has for it already.
 */
export function packControlRow(id: number, events: [number, number, number][], base: number): ControlRow {
  const dq = events.map(([, , q], i) => stepQ(i ? events[i - 1][2] : base, q));
  const tb = (t: number, b: number) => (t < 7 ? [b * 8 + t] : [b * 8 + 7, t]);
  const run = events.length > 1 && events.every(([t, b], i) => i === 0 || (t === events[i - 1][0] - 1 && b === events[0][1]));
  if (run) return [-1 - id, ...tb(events[0][0], events[0][1]), ...dq];
  return [id, ...events.flatMap(([t, b], i) => [...tb(t, b), dq[i]])];
}

/** Whose row it is */
export function controlRowId(row: ControlRow): number {
  return row[0] < 0 ? -1 - row[0] : row[0];
}

/** The other way: the events, from the aim the client had */
export function unpackControlRow(row: ControlRow, base: number): [number, number, number][] {
  const events: [number, number, number][] = [];
  let q = base;
  let i = 1;
  const tb = (): [number, number] => {
    const v = row[i++];
    return [v % 8 === 7 ? row[i++] : v % 8, Math.floor(v / 8)];
  };
  if (row[0] < 0) {
    const [t, b] = tb();
    for (let k = 0; i < row.length; k++) { q = addQ(q, row[i++]); events.push([t - k, b, q]); }
    return events;
  }
  while (i < row.length) {
    const [t, b] = tb();
    q = addQ(q, row[i++]);
    events.push([t, b, q]);
  }
  return events;
}

// ---------------------------------------------------------------------------
// The receiving side: every ship's timeline, stepped on demand
// ---------------------------------------------------------------------------

interface Step { body: FlightBody; bits: number; q: number }

/** A ship's timeline taken out of a replica set (detach), opaque: only `attach` reads it */
export interface ReplicaHold { readonly __hold: unique symbol }

interface Rep {
  mode: ReplicaMode;
  dock?: { station: number; ox: number; oy: number };
  /** Control changes not yet folded into a stepped state: tick → [bits, q] */
  events: Map<number, [number, number]>;
  /** Stepped states by tick (a window), the newest at `last` */
  hist: Map<number, Step>;
  last: number;
  /** The latest keyframe's tick (nothing before it can change) */
  kf: number;
  /** The newest aim it was sent (control rows give aims as steps from it) */
  q: number;
  /** The tick it was last drawn at (pose; undefined: not yet) */
  drawn?: number;
  /**
   * Keyframes that moved it off the path it was being drawn on, for pose to blend: at the keyframe's tick t the old
   * path was off by (dx, dy, da) (old less new). From s (the tick it was drawn at when the keyframe came, if that
   * was before t - 1) the drawn path bends onto the keyframe by t; otherwise (it came late) the correction eases
   * out after t, over SMOOTH_TICKS.
   */
  fixes?: { t: number; s: number; dx: number; dy: number; da: number }[];
}

const HISTORY = 240;
/** A keyframe's correction is bent in over up to this many ticks before it (drawing only: `at` is always exact) */
const BEND_TICKS = 8;
/** ...or, when it came too late for that, eased out over this many after */
const SMOOTH_TICKS = 8;
/** Corrections this big or more (a teleport, a blink, the jump drive) snap */
const SMOOTH_MAX = 400;
/** The old path is stepped up to a keyframe's tick only if it's this close (ticks) */
const GAP_MAX = 60;

const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** How much of a correction is added to the drawn pose at tick t (drawn = stepped path + d × this) */
function fixWeight(f: { t: number; s: number }, t: number): number {
  // Between the tick before the keyframe and the keyframe, the stepped path runs from the old path into the new
  // one (pose's lerp): k of the correction comes in with it
  const k = Math.max(0, Math.min(1, t - (f.t - 1)));
  if (f.s < f.t - 1) return t >= f.t ? 0 : k - smoothstep((t - f.s) / (f.t - f.s));
  return t < f.t ? k : 1 - smoothstep((t - f.t) / SMOOTH_TICKS);
}

const cloneBody = (b: FlightBody): FlightBody => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: b.angle, angVel: b.angVel, jump: b.jump, jumpScale: b.jumpScale, cargo: b.cargo, dodge: b.dodge, dodgeDir: b.dodgeDir });

/**
 * A pilot's own ship on its tick-aligned layer (CAPS.OWN_SIM, network/ownTick.ts): its controls are its own inputs
 * (and what the server says where they don't tell), its structure the one it flew on each tick, and after each step
 * that tick's causes (pulls, contacts, a rebuild). The replica set steps it like any other ship but asks this instead
 * of its control rows.
 */
export interface OwnTimeline {
  /** The control change on tick t (its input with that target tick, or what the server said for it), if any */
  ctl(t: number): readonly [number, number] | undefined;
  /** The structure it flew tick t with */
  derived(t: number): ShipDerived | null | undefined;
  /** After its step at tick t: that tick's causes, then rounded */
  after(t: number, body: FlightBody): void;
}

/**
 * A ship flown by its body on the client's tick-aligned layer (CAPS.BODIES, bodies/): its controls and its drive's push
 * each tick come from its body (the decisions it was sent, and the replicas it reads), not from control rows. Null
 * from `step`: not this tick (the body is off: the rows fly it).
 */
export interface BodyDriver {
  /** Tick t's controls and push, from the ship as it ended tick t - 1 and the aim it flew that tick with */
  step(t: number, prev: FlightBody, prevQ: number): { bits: number; q: number; ix: number; iy: number } | null;
  /** After its step at tick t (the body's check is of this) */
  after?(t: number, body: FlightBody): void;
}

/**
 * Other ships' causes on the tick-aligned layer (CAPS.CAUSES, network/causes.ts): after a ship's step at a tick, what
 * else moved it then (a contact, a rebuild's recentring, a pull), worked out as the server's shadow works it out; and
 * the structure it flew a tick with where that wasn't its current one (a rebuild later in the window)
 */
export interface ReplicaCauses {
  /** The structure ship `id` flew tick t with, if not its current one */
  derived(id: number, t: number): ShipDerived | undefined;
  /** Has it causes on tick t? */
  has(id: number, t: number): boolean;
  /** After its step at tick t: that tick's causes, then rounded */
  after(id: number, t: number, body: FlightBody): void;
}

/**
 * Every replicated ship a client knows: keyframes and control changes from
 * snapshots go in, states at any tick come out (stepped with the shared
 * replicaStep, exactly as the server's shadow does). A control change that
 * arrives after its tick was already stepped rewinds to just before it.
 */
export class ShipReplicaSet {
  private reps = new Map<number, Rep>();

  constructor(
    private tuning: ShipTuning,
    /** A ship's structure (null until its shipSync arrives) */
    private derived: (id: number) => ShipDerived | null | undefined,
    private env: () => ReplicaEnv,
    /** A station's position at a tick (docked ships ride along) */
    private stationAt?: (station: number, tick: number) => { x: number; y: number } | null,
    /** A piece of debris's shape (null: not known yet; it drifts without knocking) */
    private debrisShape?: (id: number) => DebrisShape | null,
  ) {}

  /** Debris is stepped all together (drift, then knocks: common ships/debris.ts), as on the server: through this tick */
  private dLast = -Infinity;
  /** ...and from this tick on it must be stepped again (a keyframe or a new piece came for an earlier tick) */
  private dDirty = Infinity;

  /** A piece of debris worked out here (common ships/debris.ts deriveSplit): it starts at `tick` as `body` */
  spawnDebris(id: number, tick: number, body: FlightBody): void {
    this.reps.set(id, { mode: ReplicaMode.Drift, events: new Map(), hist: new Map([[tick, { body: cloneBody(body), bits: 0, q: 0 }]]), last: tick, kf: tick, q: 0 });
    this.dDirty = Math.min(this.dDirty, tick);
  }

  /**
   * Every piece of debris to tick `to`, a tick at a time and all together, in id order: each drifts, then pieces that
   * overlap are pushed apart (stepDebrisWorld, the server's step). A keyframe (or a new piece) is its state at the end
   * of its tick, after that tick's step on the server: it takes no part in that tick's step, and joins in from the next.
   * A keyframe or new piece for a tick already stepped makes them all step again from there.
   */
  private stepDebrisTo(to: number): void {
    if (to <= this.dLast && this.dDirty > this.dLast) return;
    const drift: [number, Rep][] = [];
    for (const e of this.reps) if (e[1].mode === ReplicaMode.Drift && e[1].hist.size) drift.push(e);
    if (!drift.length) { this.dLast = Math.max(this.dLast, to); this.dDirty = Infinity; return; }
    drift.sort((a, b) => a[0] - b[0]);
    let from = Math.min(this.dLast, this.dDirty);
    if (from === -Infinity) { from = Infinity; for (const [, r] of drift) from = Math.min(from, r.kf); }
    // (Stepped again from `from`: what came after it goes, bar keyframes)
    for (const [, r] of drift) {
      let last = -Infinity;
      for (const t of [...r.hist.keys()]) { if (t > from && t !== r.kf) r.hist.delete(t); else if (t > last) last = t; }
      r.last = last;
    }
    const env = this.env();
    const k = env.gravity ? { ...SHIP_FLIGHT_CONSTANTS, gravity: env.gravity } : SHIP_FLIGHT_CONSTANTS;
    const cs = this.tuning.cellSize, restitution = this.tuning.collision?.restitution ?? 0.3;
    const end = Math.min(to, from + 600);
    const list: DebrisBody[] = [], reps: Rep[] = [];
    for (let t = from + 1; t <= end; t++) {
      list.length = reps.length = 0;
      for (const [id, r] of drift) {
        // (its keyframe or spawn is this tick's end: kept as it is)
        if (r.kf === t) continue;
        const prev = r.hist.get(t - 1);
        if (!prev) continue;
        const shape = this.debrisShape?.(id);
        list.push({ id, body: cloneBody(prev.body), mass: shape?.mass ?? 0, radius: shape?.radius ?? 0, com: shape?.com ?? [0, 0], pieces: shape?.pieces ?? [] });
        reps.push(r);
      }
      stepDebrisWorld(list, k, cs, restitution);
      for (let i = 0; i < list.length; i++) {
        reps[i].hist.set(t, { body: list[i].body, bits: 0, q: 0 });
        reps[i].last = t;
      }
    }
    // (Stepped again from `from`, it's been stepped to `end` only: what came after went in the rewind)
    this.dLast = end;
    this.dDirty = Infinity;
    for (const [, r] of drift) for (const t of r.hist.keys()) if (t < end - HISTORY) r.hist.delete(t);
  }

  has(id: number): boolean {
    return this.reps.has(id);
  }

  /** The pilot's own ship, stepped from its own timeline (CAPS.OWN_SIM; null: from its control rows like any other) */
  private own: { id: number; src: OwnTimeline } | null = null;
  setOwn(id: number, src: OwnTimeline | null): void {
    this.own = src ? { id, src } : null;
    this.rewind(id, -Infinity);
  }

  /** Ships flown by their bodies (CAPS.BODIES), by id */
  private drivers = new Map<number, BodyDriver>();
  setDriver(id: number, d: BodyDriver | null): void {
    if (d) this.drivers.set(id, d); else this.drivers.delete(id);
    this.rewind(id, -Infinity);
  }

  /** The own ship's state after each tick's step and before that tick's causes (preAt) */
  private ownPre = new Map<number, FlightBody>();

  /** Other ships' causes (CAPS.CAUSES), and each such ship's state after a tick's step and before that tick's causes */
  private causes: ReplicaCauses | null = null;
  private pres = new Map<number, Map<number, FlightBody>>();
  /** The ship whose causes are being worked out now, and on which tick (its pre-cause state is the one to read) */
  private busy = new Map<number, number>();
  setCauses(src: ReplicaCauses | null): void {
    this.causes = src;
    this.pres.clear();
    for (const id of this.reps.keys()) if (this.own?.id !== id) this.rewind(id, -Infinity);
  }

  /**
   * A ship's state at tick t before that tick's causes (the own ship's pulls and contacts, CAPS.OWN_SIM): what a boss's
   * body reads of its target, as the server's boss step runs after the pilots have moved and before contacts. Any
   * other ship's is its state at t
   */
  preAt(id: number, t: number): FlightBody | null {
    if (this.own?.id !== id) {
      // (Other ships' causes, CAPS.CAUSES: its state before them; read while they're being worked out, the one kept then)
      if (this.busy.get(id) === t) return this.pres.get(id)?.get(t) ?? null;
      const st = this.at(id, t);
      return (this.causes?.has(id, t) ? this.pres.get(id)?.get(t) : undefined) ?? st?.body ?? null;
    }
    const r = this.reps.get(id);
    if (!r) return null;
    if (r.last >= t) return this.ownPre.get(t) ?? this.at(id, t)?.body ?? null;
    // (Not stepped to t yet, or being stepped to it now: t's step again, without its causes)
    const prev = r.last === t - 1 ? r.hist.get(t - 1) : this.at(id, t - 1);
    const d = this.derived(id);
    if (!prev || !d || r.mode === ReplicaMode.Docked || r.mode === ReplicaMode.Drift) return prev?.body ?? null;
    const src = this.own.src, ev = src.ctl(t);
    const body = cloneBody(prev.body);
    replicaStep(r.mode, body, { bits: ev ? ev[0] : prev.bits, targetAngle: replicaAngle(r.mode, ev ? ev[1] : prev.q) }, src.derived(t) || d, this.tuning, this.env(), t);
    return body;
  }

  /** What it was stepped to from tick t on must be stepped again (its timeline changed there); its keyframe stays */
  rewind(id: number, t: number): void {
    const r = this.reps.get(id);
    if (!r || t > r.last) return;
    for (const h of [...r.hist.keys()]) if (h >= t && h !== r.kf) r.hist.delete(h);
    r.last = Math.max(...r.hist.keys(), -Infinity);
  }

  /**
   * Docked: its replica as its keyframe had it (`at` rides the station as drawn, which isn't tick-exact): what a pilot's
   * own check hashes while docked (client OwnTick; the server's Replication.ownHeld). Null when it isn't docked
   */
  docked(id: number): Step | null {
    const r = this.reps.get(id);
    return r && r.mode === ReplicaMode.Docked ? r.hist.get(r.last) ?? null : null;
  }

  /** Its replica's mode as last heard (undefined: not held): a pilot's is stepped before other ships each tick */
  modeOf(id: number): ReplicaMode | undefined {
    return this.reps.get(id)?.mode;
  }

  /** Is this ship docked (riding inside its station) as last heard */
  isDocked(id: number): boolean {
    return this.reps.get(id)?.mode === ReplicaMode.Docked;
  }

  remove(id: number): void {
    this.reps.delete(id);
    this.pres.delete(id);
  }

  clear(): void {
    this.reps.clear();
    this.pres.clear();
  }

  /**
   * Take a ship out as it is (the focus grid's dropped-cell cache, CAPS.FOCUS: network/cells.ts), to be put back with
   * `attach`. Null: not held, or debris (stepped as a world, never kept apart)
   */
  detach(id: number): ReplicaHold | null {
    const r = this.reps.get(id);
    if (!r || r.mode === ReplicaMode.Drift || !r.hist.size) return null;
    this.reps.delete(id);
    return r as unknown as ReplicaHold;
  }

  /** Put a detached ship back with the control changes it missed since ([tick, bits, q], in tick order) */
  attach(id: number, hold: ReplicaHold, events: readonly (readonly [number, number, number])[]): void {
    const r = hold as unknown as Rep;
    r.fixes = undefined;
    r.drawn = undefined;
    for (const [t, bits, q] of events) {
      if (t <= r.kf) continue;
      r.events.set(t, [bits, q]);
      r.q = q;
      if (t <= r.last) {
        for (const h of [...r.hist.keys()]) if (h >= t && h !== r.kf) r.hist.delete(h);
        r.last = Math.max(...r.hist.keys(), -Infinity);
      }
    }
    this.reps.set(id, r);
  }

  ids(): IterableIterator<number> {
    return this.reps.keys();
  }

  /** A snapshot's keyframes and control changes */
  apply(tick: number, ships?: KeyframeRow[], ctl?: ControlRow[]): void {
    for (const row of ships ?? []) {
      const k = unpackKeyframe(row);
      let r = this.reps.get(k.id);
      if (!r) { r = { mode: k.mode, events: new Map(), hist: new Map(), last: tick, kf: tick, q: k.q }; this.reps.set(k.id, r); }
      else this.correction(k.id, r, tick, k);
      r.q = k.q;
      r.mode = k.mode;
      r.dock = k.dock;
      // The new path starts here; what came before stays (we may still be drawing it)
      for (const t of [...r.hist.keys()]) if (t >= tick) r.hist.delete(t);
      for (const t of [...r.events.keys()]) if (t <= tick) r.events.delete(t);
      r.hist.set(tick, { body: k.body, bits: k.ctl.bits, q: k.q });
      r.last = tick;
      r.kf = tick;
      // (Debris: its keyframe is how that tick ended, so that tick is stepped again, the others without it: stepDebrisTo)
      if (k.mode === ReplicaMode.Drift) this.dDirty = Math.min(this.dDirty, tick - 1);
    }
    for (const packed of ctl ?? []) {
      const id = controlRowId(packed);
      const r = this.reps.get(id);
      if (!r) continue;
      const events = unpackControlRow(packed, r.q);
      if (events.length) r.q = events[events.length - 1][2];
      for (const [ago, bits, q] of events) {
        const t = tick - ago;
        if (t <= r.kf) continue;
        r.events.set(t, [bits, q]);
        // Already stepped past it: rewind to just before
        if (t <= r.last) {
          for (const h of [...r.hist.keys()]) if (h >= t) r.hist.delete(h);
          r.last = Math.max(...r.hist.keys(), -Infinity);
        }
      }
      if (!r.hist.size) this.reps.delete(id); // nothing to replay from: wait for a keyframe
    }
  }

  /**
   * A keyframe for a ship already being drawn: the path it was on is stepped on to the keyframe's tick (the ticks
   * before it are still drawn from that path; left unstepped, they showed the keyframe early, the ship jumping ahead
   * and waiting there for the view to catch up), and how far that path was off there is kept, to ease out (pose).
   */
  private correction(id: number, r: Rep, tick: number, k: Keyframe): void {
    // (A path rewritten from here on: corrections at or after it went with it)
    if (r.fixes) { r.fixes = r.fixes.filter((f) => f.t < tick); if (!r.fixes.length) r.fixes = undefined; }
    if (!r.hist.size || tick <= r.kf || k.mode !== r.mode || k.mode === ReplicaMode.Docked || tick - r.last > GAP_MAX) return;
    const was = this.at(id, tick);
    if (!was || r.hist.get(tick) !== was) return;
    const dx = was.body.x - k.body.x, dy = was.body.y - k.body.y;
    let da = was.body.angle - k.body.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    if (dhypot(dx, dy) >= SMOOTH_MAX) { r.fixes = undefined; return; }
    if ((!dx && !dy && !da) || r.drawn === undefined) return;
    (r.fixes ??= []).push({ t: tick, s: Math.max(r.drawn, tick - BEND_TICKS), dx, dy, da });
  }

  /** The state at a whole tick, stepping forward as needed (null: unknown ship) */
  at(id: number, tick: number): Step | null {
    const r = this.reps.get(id);
    if (!r || !r.hist.size) return null;
    // (Debris steps as a world: all of it to this tick, knocks and all)
    if (r.mode === ReplicaMode.Drift) this.stepDebrisTo(tick);
    const exact = r.hist.get(tick);
    if (exact) return exact;
    if (tick < r.last) {
      // Before the window (or a gap): the earliest we have
      let best: Step | null = null, bt = Infinity;
      for (const [t, s] of r.hist) if (t >= tick && t < bt) { bt = t; best = s; }
      return best ?? r.hist.get(r.last)!;
    }
    const own = this.own?.id === id ? this.own.src : null;
    const driver = this.drivers.get(id);
    const d = this.derived(id);
    let cur = r.hist.get(r.last)!;
    if (r.mode === ReplicaMode.Docked) {
      const st = r.dock && this.stationAt?.(r.dock.station, tick);
      if (!st) return cur;
      const body = { ...cloneBody(cur.body), x: st.x + r.dock!.ox, y: st.y + r.dock!.oy, vx: 0, vy: 0 };
      return { body, bits: cur.bits, q: cur.q };
    }
    if (!d || r.mode === ReplicaMode.Drift) return cur;
    const env = this.env();
    // Don't run away: a ship we haven't heard about for a long time simply waits
    const to = Math.min(tick, r.last + 600);
    while (r.last < to) {
      const t = r.last + 1;
      const ev = own ? own.ctl(t) : r.events.get(t);
      // (Flown by its body: its controls and push from that, CAPS.BODIES)
      const by = driver?.step(t, cur.body, cur.q);
      const bits = by ? by.bits : ev ? ev[0] : cur.bits, q = by ? by.q : ev ? ev[1] : cur.q;
      const body = cloneBody(cur.body);
      if (by) { body.vx += by.ix; body.vy += by.iy; }
      const cs = own ? null : this.causes;
      replicaStep(r.mode, body, { bits, targetAngle: replicaAngle(r.mode, q) }, (own ? own.derived(t) : cs?.derived(id, t)) || d, this.tuning, env, t);
      if (own) {
        this.ownPre.set(t, cloneBody(body));
        this.ownPre.delete(t - 64);
        own.after(t, body);
      } else if (cs?.has(id, t)) {
        // (Its causes on this tick, CAPS.CAUSES: what it was before them is kept, for a contact another ship works out)
        let p = this.pres.get(id);
        if (!p) this.pres.set(id, (p = new Map()));
        p.set(t, cloneBody(body));
        if (p.size > 64) for (const k of p.keys()) if (k < t - HISTORY) p.delete(k);
        this.busy.set(id, t);
        try { cs.after(id, t, body); } finally { this.busy.delete(id); }
      }
      driver?.after?.(t, body);
      cur = { body, bits, q };
      r.hist.set(t, cur);
      r.last = t;
    }
    for (const t of r.hist.keys()) if (t < r.last - HISTORY) r.hist.delete(t);
    for (const t of r.events.keys()) if (t < r.last - HISTORY) r.events.delete(t);
    return cur;
  }

  /**
   * Where a ship is drawn at a fractional tick: between two stepped states, with any keyframe's correction blended
   * in (fixWeight), so a ship pushed off its predicted path (a boss's drive, a collision) bends onto the true one
   * instead of stepping. Drawing only: the states themselves (`at`) stay exact.
   */
  pose(id: number, t: number): { x: number; y: number; angle: number; vx: number; vy: number; jump: number; jumpScale: number; dodge: number; dodgeDir: number; aim: number; bits: number } | null {
    const f = Math.floor(t);
    const a = this.at(id, f);
    if (!a) return null;
    const b = this.at(id, f + 1) ?? a;
    const k = Math.max(0, Math.min(1, t - f));
    let da = b.body.angle - a.body.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    const rep = this.reps.get(id)!;
    const mode = rep.mode;
    let x = a.body.x + (b.body.x - a.body.x) * k, y = a.body.y + (b.body.y - a.body.y) * k, angle = a.body.angle + da * k;
    rep.drawn = t;
    if (rep.fixes) {
      let n = 0;
      for (const fix of rep.fixes) {
        // (Done with once the view is past it: bent in by its tick, or eased out after)
        if (t >= fix.t + (fix.s < fix.t - 1 ? 0 : SMOOTH_TICKS)) continue;
        rep.fixes[n++] = fix;
        const w = fixWeight(fix, t);
        x += fix.dx * w; y += fix.dy * w; angle += fix.da * w;
      }
      rep.fixes.length = n;
      if (!n) rep.fixes = undefined;
    }
    return {
      x, y, angle,
      vx: b.body.vx, vy: b.body.vy, jump: b.body.jump ?? 0, jumpScale: b.body.jumpScale ?? 1, dodge: b.body.dodge ?? 0, dodgeDir: b.body.dodgeDir ?? 0, aim: replicaAngle(mode, b.q), bits: b.bits,
    };
  }
}
