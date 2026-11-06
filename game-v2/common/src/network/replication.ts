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
 *          from ticksAgo on (packControlRow). The first aim goes as the step
 *          from the aim the client already has (its keyframe's or last change's:
 *          both ends keep it), each later one as the change in that step from
 *          the one before (a smooth sweep's steps are nearly equal), each
 *          wrapped to ±4096.
 *
 * q is the aim angle in the 13-bit cursor quantization; a pilot's arrives as a
 * float32 (the input encoding), so it's rounded the same way here.
 */

import { ReplicaMode, ReplicaControls, ReplicaEnv, FlightBody, ShipTuning, ShipDerived, replicaStep } from '../ships/index.js';
import { stepDebrisWorld, type DebrisBody } from '../ships/debris.js';
import { SHIP_FLIGHT_CONSTANTS } from '../ships/physics.js';
import type { Vec2 } from '../ships/types.js';
import { StateRing } from '../sim/ring.js';
import { ReplicaState } from '../sim/c-replicaState.js';
import { CtlChangeInputs, DriverInputs } from '../sim/d-sources.js';
import type { InputSource, SimInput } from '../sim/input.js';
import type { PullSource } from '../sim/env.js';
import { PullBook, fieldPulls, unpackPullField, type PullerPose, type PullFieldRow } from '../sim/pullFields.js';

/** A piece of debris's shape for the knocks (ShipReplicaSet's debrisShape): its mass, radius, centre and convex pieces */
export interface DebrisShape { mass: number; radius: number; com: Vec2; pieces: readonly (readonly Vec2[])[]; born?: number }

/**
 * What a client's debris world asks of the debris it holds (client ships/debris/DebrisSplits.ts): each piece's shape
 * on a tick, and, for a piece it runs itself (CAPS.DEBRIS: common ships/debrisLife.ts), its life on that tick
 */
export interface DebrisWorld {
  /** Its shape on tick t's step (null: not known yet; it drifts without knocking) */
  shape(id: number, t: number): DebrisShape | null;
  /** Gone before tick t's step (its time is up) */
  gone?(id: number, t: number): boolean;
  /**
   * After tick t's step, the tick's rebuild point: a crumble rebuilt it there, and what's left is recentred in place
   * (`body` moved). False: nothing was left of it (it went at t)
   */
  after?(id: number, t: number, body: FlightBody): boolean;
  /** One it runs itself (its whole life worked out here, its end too: a removal of it is no news) */
  runs?(id: number): boolean;
}
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
  const steps = events.map(([, , q], i) => stepQ(i ? events[i - 1][2] : base, q));
  // (each step after the first as its change from the one before)
  const dq = steps.map((d, i) => (i ? stepQ(steps[i - 1], d) : d));
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
  let q = base, step = 0, n = 0;
  let i = 1;
  // (the first step as it is, each later one as the change from the one before: packControlRow)
  const next = (v: number) => { step = n++ ? addQ(step + AIM_Q / 2, v) - AIM_Q / 2 : v; return step; };
  const tb = (): [number, number] => {
    const v = row[i++];
    return [v % 8 === 7 ? row[i++] : v % 8, Math.floor(v / 8)];
  };
  if (row[0] < 0) {
    const [t, b] = tb();
    for (let k = 0; i < row.length; k++) { q = addQ(q, next(row[i++])); events.push([t - k, b, q]); }
    return events;
  }
  while (i < row.length) {
    const [t, b] = tb();
    q = addQ(q, next(row[i++]));
    events.push([t, b, q]);
  }
  return events;
}

// ---------------------------------------------------------------------------
// The receiving side: every ship's timeline, stepped on demand
// ---------------------------------------------------------------------------

/** A ship's state at a tick, as `at` gives it (the ring's ReplicaState: its body and the controls it flew) */
export interface Step { readonly body: FlightBody; readonly bits: number; readonly q: number }

interface Rep {
  mode: ReplicaMode;
  dock?: { station: number; ox: number; oy: number };
  /** Control changes not yet folded into a stepped state: tick → [bits, q] */
  events: Map<number, [number, number]>;
  /** Its input source over `events` (assumed: held between rows), made on first step */
  src?: CtlChangeInputs;
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
  /** Where pose last drew it, before any bending (its path as it was then) */
  raw?: { t: number; x: number; y: number; angle: number };
  /** Its path was stepped again (control rows, decisions, causes for ticks already drawn) since: pose eases the change out */
  moved?: boolean;
}

const HISTORY = 240;
const NO_PULLS: readonly (readonly [number, number, number])[] = [];
/** A keyframe's correction is bent in over up to this many ticks before it (drawing only: `at` is always exact) */
const BEND_TICKS = 8;
/** ...or, when it came too late for that, eased out over this many after */
const SMOOTH_TICKS = 8;
/** Corrections this big or more (a teleport, a blink, the jump drive) snap */
const SMOOTH_MAX = 400;
/** The old path is stepped up to a keyframe's tick only if it's this close (ticks) */
const GAP_MAX = 60;
/** A ship drawn before its first state is drawn back along its way from it by at most this many ticks */
const BACK_TICKS = 20;

/** stepPreNow's scratch: the ship before the step, as its input source reads it */
const PREV: { id: number; body: FlightBody; ctl: { bits: number; q: number } } = { id: 0, body: undefined as unknown as FlightBody, ctl: { bits: 0, q: 0 } };
const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** How much of a correction is added to the drawn pose at tick t (drawn = stepped path + d × this) */
/** An angle difference into (-pi, pi] */
function wrapAngle(d: number): number {
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** A path stepped again from tick t: drawn there already, pose eases the change out */
function rewrote(r: Rep, t: number): void {
  if (r.raw && t <= Math.floor(r.raw.t) + 1) r.moved = true;
}

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
  /** Before its step at tick t: what goes in first (a CARGO cause: the hold's mass it flies the step with) */
  preStep?(t: number, body: FlightBody): void;
  /** Its pulls on tick t as the server told them (PULL rows, [kind, dvx, dvy]): its step takes them. Undefined: none told */
  pulls?(t: number): readonly (readonly number[])[] | undefined;
  /**
   * Its whole step at tick t, flown (a pilot's): the one stepper on its full state (stores, guns, hazards, priming:
   * the source keeps those by tick), `body` stepped in place from its state at t - 1, with the controls the timeline
   * says (`bits`, `q`), and `heldQ` the aim it was applied at on t - 1 (sim/aimHold.ts). Returns the controls it flew: the
   * CTL bits (its power and hazard bits the step's own) and its applied aim. Absent (or null back): stepped as any
   * replica is (replicaStep, its power from the bits, on `q`)
   */
  step?(t: number, body: FlightBody, bits: number, q: number, derived: ShipDerived, env: ReplicaEnv, heldQ: number): Readonly<{ bits: number; q: number }> | null;
}

/**
 * A ship flown by its body on the client's tick-aligned layer (CAPS.BODIES, bodies/): its controls and its drive's push
 * each tick come from its body (the decisions it was sent, and the replicas it reads), not from control rows. Null
 * from `step`: not this tick (the body is off: the rows fly it).
 */
export interface BodyDriver {
  /**
   * Tick t's controls and push, from the ship as it ended tick t - 1 and the aim and controls it flew that tick with; an
   * AI pilot's guns' controls too (`fire`, `aim`, `aimDist`: bodies/aiPilot.ts, flown by other ships' guns, sim/otherGuns.ts)
   */
  step(t: number, prev: FlightBody, prevQ: number, prevBits: number): { bits: number; q: number; ix: number; iy: number; fire?: boolean; aim?: number; aimDist?: number } | null;
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
  /** Before its step at tick t (only asked when it has causes then): a CARGO cause, the hold's mass it flies the step with */
  preStep?(id: number, t: number, body: FlightBody): void;
  /** Its pulls on tick t as the server told them (PULL rows, [kind, dvx, dvy]): its step takes them. Undefined: none told */
  pulls?(id: number, t: number): readonly (readonly number[])[] | undefined;
}

/**
 * A client finding contact pairs on its tick layer itself (CAPS.CONTACTS: client ships/causes/ContactWorld.ts): what
 * it worked out on a tick reads every ship of the pair there, so a ship stepped again from tick t (a rewind, a
 * keyframe, a late control row, gone) may change what it found from t on
 */
export interface ReplicaRewinds {
  rewound(id: number, t: number): void;
  /** Something is waiting to be worked out before a ship is stepped (pairs to find again, ships to step again) */
  readonly unsettled?: boolean;
  /** Work it out (asked only when the set isn't part way through a step: ShipReplicaSet.busy) */
  settle?(): void;
}

/**
 * Something stepped beside every ship's step on the tick layer (other ships' guns: sim/otherGuns.ts, client
 * ships/guns/OtherGuns.ts): told after each tick t a ship is stepped, with its state before (t - 1, after its causes),
 * after the step (before t's causes) and the input it flew, and whenever its steps from a tick on are dropped
 */
export interface ReplicaSideSteps {
  stepped(id: number, t: number, mode: ReplicaMode, prev: Readonly<Step>, now: Readonly<Step>, input: Readonly<SimInput>, derived: ShipDerived, env: ReplicaEnv): void;
  /** Its steps from tick t on are gone (a rewind, a keyframe, removed: -Infinity) */
  rewound(id: number, t: number): void;
}

/**
 * Every replicated ship a client knows: keyframes and control changes from
 * snapshots go in, states at any tick come out (stepped with the shared
 * replicaStep, exactly as the server's shadow does). A control change that
 * arrives after its tick was already stepped rewinds to just before it.
 */
export class ShipReplicaSet {
  private reps = new Map<number, Rep>();
  /**
   * Every ship's stepped states, a ReplicaState per tick (sim/ring.ts: the window, HISTORY + 1 ticks), the newest its
   * last stepped tick (sim foundation 1C: was each Rep's hist and last)
   */
  readonly ring = new StateRing(HISTORY + 1);
  /**
   * Each ship's state after a tick's step and before that tick's causes, where it had any (its own ship: every tick;
   * preAt). Was ownPre and pres
   */
  private readonly pre = new StateRing(HISTORY + 1);
  /**
   * A tick's step worked out ahead of the ship being stepped to it (preAt: what the contact pass and bodies read of it
   * there, before that tick's causes): the step then takes it as it is. Was pend
   */
  private readonly ahead = new StateRing(HISTORY + 1);

  /**
   * The pull fields of this client's system (sim/pullFields.ts, the server's `pulls` records): every pilot's step here
   * (its replica's, its own) takes their pulls after its motion, each puller as this set has it at the tick before
   */
  readonly pulls = new PullBook();
  /**
   * The step's pull source (sim/pulls.ts, through replicaStep and the own step): the pulls the server told for the ship
   * on that tick, where it did (its PULL cause rows: its own timeline's, OwnTimeline.pulls, or its causes',
   * ReplicaCauses.pulls), in place of the fields' (network/ownTick.ts PULL); else the fields' pulls
   */
  private readonly pullSource: PullSource = {
    on: (id, t, at) => {
      const told = this.own?.id === id ? this.own.src.pulls?.(t) : this.causes?.pulls?.(id, t);
      if (told) {
        const out: [number, number, number][] = [];
        for (const r of told) if (r[0] === 0 /* OWN_CAUSE.PULL */) out.push([-1, r[1], r[2]]);
        return out;
      }
      if (!this.pulls.size) return NO_PULLS;
      return fieldPulls(this.pulls.all(), id, t, at, this.pullerAt, this.env().terrain);
    },
  };

  /**
   * A puller as it ended tick t (what a field reads of it on tick t + 1): its state there exactly, stepped to it if need
   * be; null when this set doesn't hold it there (not had yet, or only from a keyframe after t). Kept as read
   * (`pullerPoses`) until the puller is stepped again from t or before: a puller removed (a boss destroyed) still pulled
   * on the ticks before it went, when a pilot is stepped again over them
   */
  private readonly pullerAt = (id: number, t: number): PullerPose | null => {
    const kept = this.pullerPoses.get(id)?.get(t);
    if (kept) return kept;
    const r = this.reps.get(id);
    const first = this.ring.first(id);
    if (!r || first === undefined || first > t || r.mode === ReplicaMode.Drift || r.mode === ReplicaMode.Docked) return null;
    const st = this.ring.get(id, t) ?? (t > this.lastT(id) ? this.at(id, t) : null);
    if (!st || this.ring.get(id, t) !== st) return null;
    const b = st.body, p = { x: b.x, y: b.y, angle: b.angle, vx: b.vx, vy: b.vy };
    let m = this.pullerPoses.get(id);
    if (!m) this.pullerPoses.set(id, (m = new Map()));
    m.set(t, p);
    if (m.size > HISTORY + 60) for (const k of m.keys()) if (k < t - HISTORY) m.delete(k);
    return p;
  };
  private readonly pullerPoses = new Map<number, Map<number, PullerPose>>();

  /** The env a step here flies in: the world's, with the pulls (a copy: the host's may be shared) */
  private stepEnv(): ReplicaEnv {
    return { ...this.env(), pulls: this.pullSource };
  }

  /**
   * The server's pull field records (a `pulls` message): each ship a changed field acts on is stepped again from the
   * first tick it changes
   */
  notePulls(rows: readonly PullFieldRow[], now?: number): void {
    for (const row of rows) {
      const rec = unpackPullField(row);
      const from = this.pulls.put(rec);
      if (from !== null) this.rewindPulled(rec.target, from);
    }
    if (now !== undefined) this.pulls.prune(now - HISTORY - 60);
  }

  /** Ships a field acts on stepped again from tick t (-1: every pilot held) */
  private rewindPulled(target: number, t: number): void {
    if (this.stepping > 0) { this.pullRewinds.push([target, t]); return; }
    if (target >= 0) { this.rewindHeld(target, t); return; }
    for (const [id, r] of this.reps) if (r.mode === ReplicaMode.Player) this.rewindHeld(id, t);
  }

  /**
   * A ship stepped again from tick t, but never from before the oldest state it holds (a field that began long ago, a
   * puller set going again from its keyframe: what came before that is gone, and a path steps on only from a state)
   */
  private rewindHeld(id: number, t: number): void {
    const first = this.ring.first(id);
    if (first === undefined || t > this.lastT(id) + 1) { this.rewind(id, t); return; }
    this.rewind(id, Math.max(t, first + 1));
  }
  /** Rewinds a puller's being stepped again asked for while a step was under way (done before the next read: at) */
  private pullRewinds: [number, number][] = [];
  /**
   * Pulls on ticks up to this one are final (the window of the snapshot before the newest: its causes and keyframes are
   * all in), and the newest snapshot's tick
   */
  private pullsFinal = -Infinity;
  private snapSeen = -Infinity;

  /** The last tick ship `id` is stepped to (-Infinity: none held) */
  private lastT(id: number): number {
    return this.ring.last(id) ?? -Infinity;
  }

  constructor(
    private tuning: ShipTuning,
    /** A ship's structure (null until its shipSync arrives) */
    private derived: (id: number) => ShipDerived | null | undefined,
    private env: () => ReplicaEnv,
    /** A station's position at a tick (docked ships ride along) */
    private stationAt?: (station: number, tick: number) => { x: number; y: number } | null,
    /** The debris it holds: each piece's shape (and a piece's life, one it runs itself) */
    debris?: ((id: number) => DebrisShape | null) | DebrisWorld,
  ) {
    this.debris = typeof debris === 'function' ? { shape: (id) => debris(id) } : debris;
  }

  private readonly debris?: DebrisWorld;

  /** Debris is stepped all together (drift, then knocks: common ships/debris.ts), as on the server: through this tick */
  private dLast = -Infinity;
  /** ...and from this tick on it must be stepped again (a keyframe or a new piece came for an earlier tick) */
  private dDirty = Infinity;

  /** A piece of debris worked out here (common ships/debris.ts deriveSplit): it starts at `tick` as `body` */
  spawnDebris(id: number, tick: number, body: FlightBody): void {
    this.reps.set(id, { mode: ReplicaMode.Drift, events: new Map(), kf: tick, q: 0 });
    this.ring.remove(id); this.pre.remove(id); this.ahead.remove(id);
    this.ring.keep(tick, new ReplicaState(id, ReplicaMode.Drift, cloneBody(body), 0, 0));
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
    const ring = this.ring;
    for (const e of this.reps) if (e[1].mode === ReplicaMode.Drift && ring.size(e[0])) drift.push(e);
    if (!drift.length) { this.dLast = Math.max(this.dLast, to); this.dDirty = Infinity; return; }
    drift.sort((a, b) => a[0] - b[0]);
    let from = Math.min(this.dLast, this.dDirty);
    if (from === -Infinity) { from = Infinity; for (const [, r] of drift) from = Math.min(from, r.kf); }
    // (Stepped again from `from`: what came after it goes, bar keyframes)
    for (const [id, r] of drift) {
      this.dropKeepingKf(id, r, from + 1);
      rewrote(r, from + 1);
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
        const prev = ring.get(id, t - 1);
        if (!prev || this.debris?.gone?.(id, t)) continue;
        const shape = this.debris?.shape(id, t);
        list.push({ id, body: cloneBody(prev.body), mass: shape?.mass ?? 0, radius: shape?.radius ?? 0, com: shape?.com ?? [0, 0], pieces: shape?.pieces ?? [], born: shape?.born });
        reps.push(r);
      }
      stepDebrisWorld(list, k, cs, restitution, t);
      for (let i = 0; i < list.length; i++) {
        // (A piece it runs: its rebuild point; nothing left of it, it has no state at t's end, and isn't stepped again)
        if (this.debris?.after && !this.debris.after(list[i].id, t, list[i].body)) continue;
        ring.keep(t, new ReplicaState(list[i].id, ReplicaMode.Drift, list[i].body, 0, 0));
      }
    }
    // (Stepped again from `from`, it's been stepped to `end` only: what came after went in the rewind. The ring keeps
    // the window)
    this.dLast = end;
    this.dDirty = Infinity;
  }

  /** A ship's states from tick t on go, bar its keyframe's */
  private dropKeepingKf(id: number, r: Rep, t: number): void {
    const kf = r.kf >= t ? this.ring.get(id, r.kf) : undefined;
    this.ring.dropFrom(id, t);
    if (kf) this.ring.keep(r.kf, kf as ReplicaState, id);
  }

  has(id: number): boolean {
    return this.reps.has(id);
  }

  /** The pilot's own ship, stepped from its own timeline (CAPS.OWN_SIM; null: from its control rows like any other) */
  private own: { id: number; src: OwnTimeline; inputs: CtlChangeInputs } | null = null;
  setOwn(id: number, src: OwnTimeline | null): void {
    this.own = src ? { id, src, inputs: new CtlChangeInputs('known', (t) => src.ctl(t)) } : null;
    this.rewind(id, -Infinity);
  }

  /** Ships flown by their bodies (CAPS.BODIES), by id */
  private drivers = new Map<number, DriverInputs>();
  setDriver(id: number, d: BodyDriver | null): void {
    if (d) this.drivers.set(id, new DriverInputs(d)); else this.drivers.delete(id);
    this.rewind(id, -Infinity);
  }

  /** Other ships' causes (CAPS.CAUSES): each such ship's state after a tick's step and before its causes goes in `pre` */
  private causes: ReplicaCauses | null = null;
  setCauses(src: ReplicaCauses | null): void {
    this.causes = src;
    for (const id of [...this.pre.ids()]) if (this.own?.id !== id) this.pre.remove(id);
    for (const id of this.reps.keys()) if (this.own?.id !== id) this.rewind(id, -Infinity);
  }

  /** Told whenever a ship is stepped again from a tick (CAPS.CONTACTS: ContactWorld) */
  private hook: ReplicaRewinds | null = null;
  setRewinds(h: ReplicaRewinds | null): void {
    this.hook = h;
  }

  /** Steps beside each ship's (other ships' guns) */
  private sides: ReplicaSideSteps | null = null;
  setSideSteps(h: ReplicaSideSteps | null): void {
    this.sides = h;
  }

  /**
   * A ship's stepped states from tick t on are gone: what was worked out ahead of them goes too. `gone`: it was removed
   * (what it was on those ticks stands, kept for its pulls: pullerAt)
   */
  private dropped(id: number, t: number, gone = false): void {
    this.ahead.dropFrom(id, t);
    this.pre.dropFrom(id, t);
    this.hook?.rewound(id, t);
    this.sides?.rewound(id, t);
    if (gone) return;
    // (A puller: the ships its fields pull from t + 1 read it at t, so they are stepped again from there too)
    // (Not the pulls of a window a snapshot has closed (pullsFinal): those the server judged with the puller as this set had
    // it then, and told where this set couldn't work them out. A puller stepped again over them later (a keyframe, its body
    // stopped and its rows flying it from an old keyframe) changes nothing that was pulled then)
    const from = Math.max(t, this.pullsFinal);
    const poses = this.pullerPoses.get(id);
    if (poses) for (const k of poses.keys()) if (k >= from) poses.delete(k);
    if (this.pulls.size) for (const f of this.pulls.all()) if (f.from === id && f.t1 > from + 1) this.rewindPulled(f.target, Math.max(from + 1, f.t0));
  }

  /** Its latest keyframe's tick (its path before it is the one it was drawn on; undefined: not held) */
  kfOf(id: number): number | undefined {
    return this.reps.get(id)?.kf;
  }

  /** The last tick it has been stepped to (undefined: not held) */
  lastOf(id: number): number | undefined {
    return this.reps.has(id) ? this.lastT(id) : undefined;
  }

  /**
   * A ship's state at tick t before that tick's causes (the own ship's pulls and contacts, CAPS.OWN_SIM): what a boss's
   * body reads of its target, as the server's boss step runs after the pilots have moved and before contacts. Any
   * other ship's is its state at t
   */
  preAt(id: number, t: number): FlightBody | null {
    const r = this.reps.get(id);
    if (!r) return null;
    let last = this.lastT(id);
    if (last >= t) {
      // (Kept as it was stepped where it had causes then (its own ship: always); otherwise its state is it)
      return this.pre.get(id, t)?.body ?? this.at(id, t)?.body ?? null;
    }
    // (Not stepped to t yet, or being stepped to it now: t's step, without its causes, worked out once: stepPre)
    const d = this.derived(id);
    if (!d || r.mode === ReplicaMode.Docked || r.mode === ReplicaMode.Drift || t <= r.kf) return this.at(id, t)?.body ?? null;
    const prev = last === t - 1 ? this.ring.get(id, t - 1) : this.at(id, t - 1);
    last = this.lastT(id);
    if (!prev || last !== t - 1) return prev?.body ?? null;
    return this.stepPre(id, r, t, prev as ReplicaState, d).body;
  }

  /**
   * Tick t's step of a ship from its state at t - 1, before that tick's causes: its controls (its own inputs, its
   * body's, or its rows), the hold's mass it flies with, its structure then. Worked out once (`ahead`) whoever asks
   * first: the step itself (at) or something reading it there before (preAt: a body reading its target, the contact pass)
   */
  private stepPre(id: number, r: Rep, t: number, prev: ReplicaState, d: ShipDerived): ReplicaState {
    const have = this.ahead.get(id, t);
    if (have) return have as ReplicaState;
    this.stepping++;
    try {
      return this.stepPreNow(id, r, t, prev, d);
    } finally {
      this.stepping--;
    }
  }

  /** Steps part way through now (stepPre's, at's, the debris world's): nothing is rewound under them (settle waits) */
  private stepping = 0;
  get busy(): boolean {
    return this.stepping > 0;
  }

  private stepPreNow(id: number, r: Rep, t: number, prev: ReplicaState, d: ShipDerived): ReplicaState {
    const own = this.own?.id === id ? this.own.src : null;
    // Its input from its source (sim/d-sources.ts): its own timeline (known) or its control rows (assumed), held
    // between changes; flown by its body, its driver's controls and push (decided, CAPS.BODIES), the rows where it doesn't
    const rows: InputSource = own ? this.own!.inputs : (r.src ??= new CtlChangeInputs('assumed', (k) => r.events.get(k)));
    const drv = this.drivers.get(id);
    if (drv) drv.fallback = rows;
    PREV.id = id; PREV.body = prev.body; PREV.ctl.bits = prev.bits; PREV.ctl.q = prev.q;
    const input = (drv ?? rows).inputAt(t, PREV);
    const bits = input.bits, q = input.q;
    const body = cloneBody(prev.body);
    if (input.impulse) { body.vx += input.impulse[0]; body.vy += input.impulse[1]; }
    const cs = own ? null : this.causes;
    // (The hold's mass it flies this step with, if that changed: a CARGO cause, CAPS.CARGO)
    if (own) own.preStep?.(t, body);
    else cs?.preStep?.(id, t, body);
    const dt = (own ? own.derived(t) : cs?.derived(id, t)) || d;
    // (Its own ship, flown: its whole step, once, by its own timeline (OwnTimeline.step); anything else its replica's)
    const env = this.stepEnv();
    // (Its applied aim as the server works it out from the same inputs: the held one where it flew the same, sim/aimHold.ts)
    const flown = own && r.mode === ReplicaMode.Player && own.step ? own.step(t, body, bits, q, dt, env, prev.q) : null;
    if (flown === null) replicaStep(r.mode, body, { bits, targetAngle: replicaAngle(r.mode, q) }, dt, this.tuning, env, t, id);
    const st = flown ? new ReplicaState(id, r.mode, body, flown.bits, flown.q) : new ReplicaState(id, r.mode, body, bits, q);
    this.ahead.keep(t, st);
    if (!own && this.sides) this.sides.stepped(id, t, r.mode, prev, st, input, dt, this.env());
    return st;
  }

  /**
   * One tick of a ship stepped off its timeline: from `prev` with the controls given (bits, aim q), its structure now,
   * no causes, nothing kept or rewound. The same step `at` takes for a tick without causes, so a state stepped here
   * equals the ring's when the controls and what came before agree. For a layer kept beside the ring (the dev
   * prediction modes' PT layer, client dev/predict). Null: not held, no structure yet, docked or debris
   */
  stepAlone(id: number, prev: Readonly<Step>, t: number, bits: number, q: number): ReplicaState | null {
    const r = this.reps.get(id), d = this.derived(id);
    if (!r || !d || r.mode === ReplicaMode.Docked || r.mode === ReplicaMode.Drift) return null;
    const body = cloneBody(prev.body);
    // (Its pulls too, the fields' (and what was told for the tick), each puller as this set has it: the PT layer's step is this)
    replicaStep(r.mode, body, { bits, targetAngle: replicaAngle(r.mode, q) }, d, this.tuning, this.stepEnv(), t, id);
    return new ReplicaState(id, r.mode, body, bits, q);
  }

  /**
   * What it was stepped to from tick t on must be stepped again (its timeline changed there); its keyframe stays, and
   * so does what came before it. A path steps on from its keyframe, never from before it, so those ticks can't be
   * stepped again: they are the path it was drawn on, which the keyframe's correction bends onto it (pose). Wiped, the
   * ticks between t and the keyframe were drawn at the keyframe (`at` gives the earliest state after a gap): a ship
   * keyed again (a body's SYNC, its target keyed) jumped ahead to it and stood there until the view caught up
   */
  rewind(id: number, t: number): void {
    const r = this.reps.get(id);
    if (!r) return;
    // (Not stepped there yet: only what was worked out ahead of it, preAt, goes)
    if (t > this.lastT(id)) { this.dropped(id, t); return; }
    // (Debris steps as a world, from where it was rewound to: stepDebrisTo does its own)
    const from = r.mode === ReplicaMode.Drift ? t : Math.max(t, r.kf + 1);
    this.dropKeepingKf(id, r, from);
    rewrote(r, from);
    this.dropped(id, from);
    // (Debris steps as a world (stepDebrisTo): left as it is, the world, already past t, never stepped it again: frozen)
    if (r.mode === ReplicaMode.Drift) this.dDirty = Math.min(this.dDirty, t - 1);
  }

  /**
   * Docked: its replica as its keyframe had it (`at` rides the station as drawn, which isn't tick-exact): what a pilot's
   * own check hashes while docked (client OwnTick; the server's Replication.ownHeld). Null when it isn't docked
   */
  docked(id: number): Step | null {
    const r = this.reps.get(id);
    return r && r.mode === ReplicaMode.Docked ? this.ring.get(id, this.lastT(id)) as ReplicaState ?? null : null;
  }

  /** Its replica's mode as last heard (undefined: not held): a pilot's is stepped before other ships each tick */
  modeOf(id: number): ReplicaMode | undefined {
    return this.reps.get(id)?.mode;
  }

  /** Is this ship docked (riding inside its station) as last heard */
  isDocked(id: number): boolean {
    return this.reps.get(id)?.mode === ReplicaMode.Docked;
  }

  /**
   * A ship gone. `tick`: a snapshot's removal at that tick. A piece of debris the client runs itself (DebrisWorld.runs)
   * knocked others in the world up to its end, which it knows (gone, after), and the snapshot's window can be long: the
   * world is stepped to the tick first, with it in. (One it's sent goes at once: the server keyframes what it knocked
   * in the window, Replication.forClient)
   */
  remove(id: number, tick?: number): void {
    if (tick !== undefined && this.reps.get(id)?.mode === ReplicaMode.Drift && this.debris?.runs?.(id)) this.at(id, tick);
    if (this.reps.delete(id)) this.dropped(id, -Infinity, true);
    this.ring.remove(id);
    this.pre.remove(id);
    this.ahead.remove(id);
  }

  clear(): void {
    for (const id of [...this.reps.keys()]) this.remove(id);
    this.ring.clear();
    this.pre.clear();
    this.ahead.clear();
    this.pulls.clear();
    this.pullRewinds.length = 0;
    this.pullerPoses.clear();
    this.pullsFinal = this.snapSeen = -Infinity;
  }

  ids(): IterableIterator<number> {
    return this.reps.keys();
  }

  /** A snapshot's keyframes and control changes */
  apply(tick: number, ships?: KeyframeRow[], ctl?: ControlRow[]): void {
    // (The window before this snapshot's is closed: its pulls stand as they were worked out, `pullsFinal`)
    if (tick > this.snapSeen) { this.pullsFinal = this.snapSeen; this.snapSeen = tick; }
    // (Steps worked out ahead, preAt, read what came before this snapshot and its frame's structures: worked out afresh)
    this.ahead.clear();
    for (const row of ships ?? []) {
      const k = unpackKeyframe(row);
      let r = this.reps.get(k.id);
      // (Its own ship, drawn ahead of the snapshots: drawn already past the keyframe's tick, so the change eases out from
      // where it was drawn, as a path stepped again does (pose: `moved`), rather than bending in before the keyframe)
      const ownKf = !!r && this.own?.id === k.id && !!r.raw && k.mode === r.mode && k.mode !== ReplicaMode.Docked;
      if (!r) { r = { mode: k.mode, events: new Map(), kf: tick, q: k.q }; this.reps.set(k.id, r); this.ring.remove(k.id); }
      else if (!ownKf) this.correction(k.id, r, tick, k);
      r.q = k.q;
      r.mode = k.mode;
      r.dock = k.dock;
      // The new path starts here; what came before stays (we may still be drawing it)
      this.ring.dropFrom(k.id, tick);
      this.dropped(k.id, tick);
      for (const t of [...r.events.keys()]) if (t <= tick) r.events.delete(t);
      this.ring.keep(tick, new ReplicaState(k.id, k.mode, k.body, k.ctl.bits, k.q));
      r.kf = tick;
      // (Its keyframe's own correction bends it (correction): not this path's being stepped again)
      if (ownKf) { r.fixes = r.fixes?.filter((f) => f.t < tick); r.moved = true; }
      else { r.moved = false; r.raw = undefined; }
      // (Debris: its keyframe is how that tick ended, so that tick is stepped again, the others without it: stepDebrisTo)
      if (k.mode === ReplicaMode.Drift) this.dDirty = Math.min(this.dDirty, tick - 1);
    }
    for (const packed of ctl ?? []) {
      const id = controlRowId(packed);
      const r = this.reps.get(id);
      // (Debris has no controls; it steps as a world, and a rewind here would leave it unstepped)
      if (!r || r.mode === ReplicaMode.Drift) continue;
      const events = unpackControlRow(packed, r.q);
      if (events.length) r.q = events[events.length - 1][2];
      for (const [ago, bits, q] of events) {
        const t = tick - ago;
        if (t <= r.kf) continue;
        r.events.set(t, [bits, q]);
        // Already stepped past it: rewind to just before
        if (t <= this.lastT(id)) {
          this.ring.dropFrom(id, t);
          rewrote(r, t);
        }
        // (a step worked out ahead for it, preAt, read the old controls)
        this.dropped(id, t);
      }
      if (!this.ring.size(id)) this.reps.delete(id); // nothing to replay from: wait for a keyframe
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
    if (!this.ring.size(id) || tick <= r.kf || k.mode !== r.mode || k.mode === ReplicaMode.Docked || tick - this.lastT(id) > GAP_MAX) return;
    const was = this.at(id, tick);
    if (!was || (this.ring.get(id, tick) as Step | undefined) !== was) return;
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
    // (What the contact pass left waiting, worked out before anything is read: never part way through a step)
    if (this.stepping === 0 && this.hook?.unsettled) this.hook.settle?.();
    // (...and ships a puller's re-step reaches, asked for part way through one)
    if (this.stepping === 0 && this.pullRewinds.length) for (const [target, t] of this.pullRewinds.splice(0)) this.rewindPulled(target, t);
    const r = this.reps.get(id);
    const ring = this.ring;
    if (!r || !ring.size(id)) return null;
    // (Debris steps as a world: all of it to this tick, knocks and all)
    if (r.mode === ReplicaMode.Drift) {
      this.stepping++;
      try { this.stepDebrisTo(tick); } finally { this.stepping--; }
    }
    const exact = ring.get(id, tick) as ReplicaState | undefined;
    if (exact) return exact;
    let last = this.lastT(id);
    if (tick < last) {
      // Before the window (or a gap): the earliest we have
      let bt = Infinity;
      for (const t of ring.ticks(id)) if (t >= tick && t < bt) bt = t;
      return (ring.get(id, bt) ?? ring.get(id, last)!) as ReplicaState;
    }
    const own = this.own?.id === id ? this.own.src : null;
    const driver = this.drivers.get(id)?.driver;
    const d = this.derived(id);
    let cur = ring.get(id, last)! as ReplicaState;
    if (r.mode === ReplicaMode.Docked) {
      const st = r.dock && this.stationAt?.(r.dock.station, tick);
      if (!st) return cur;
      const body = { ...cloneBody(cur.body), x: st.x + r.dock!.ox, y: st.y + r.dock!.oy, vx: 0, vy: 0 };
      return new ReplicaState(id, r.mode, body, cur.bits, cur.q);
    }
    if (!d || r.mode === ReplicaMode.Drift) return cur;
    // Don't run away: a ship we haven't heard about for a long time simply waits
    const to = Math.min(tick, last + 600);
    this.stepping++;
    try {
    while (last < to) {
      const t = last + 1;
      const pre = this.stepPre(id, r, t, cur, d);
      const body = cloneBody(pre.body);
      const cs = own ? null : this.causes;
      if (own) {
        // (Its own ship: what it was before its causes is kept every tick, for preAt)
        this.pre.keep(t, pre);
        own.after(t, body);
      } else if (cs?.has(id, t)) {
        // (Its causes on this tick, CAPS.CAUSES: what it was before them is kept, for a contact another ship works out)
        this.pre.keep(t, pre);
        cs.after(id, t, body);
      } else this.pre.delete(id, t);
      // (Asked of it ahead while its causes were worked out: done with now)
      this.ahead.delete(id, t);
      driver?.after?.(t, body);
      cur = new ReplicaState(id, r.mode, body, pre.bits, pre.q);
      ring.keep(t, cur);
      last = t;
    }
    } finally {
      this.stepping--;
    }
    if (r.events.size > 64) for (const t of r.events.keys()) if (t < last - HISTORY) r.events.delete(t);
    return cur;
  }

  /** Its pose at a fractional tick between two stepped states, unbent */
  private rawPose(id: number, t: number): { x: number; y: number; angle: number; b: Step } | null {
    const f = Math.floor(t);
    // Before its first state (a ship just come into view, or back into it): drawn coming in along its way, back from that
    // state, not standing at it until the view reaches its tick (it stood there, then went on: a snap and a stall). Not
    // debris (nothing before it split), a docked ship or one mid-jump; at most BACK_TICKS back
    const r = this.reps.get(id);
    const ring = this.ring;
    if (r && ring.size(id) && !ring.has(id, f) && r.mode !== ReplicaMode.Drift && r.mode !== ReplicaMode.Docked) {
      const first = ring.first(id)!;
      const s = first > f ? ring.get(id, first)! : null;
      if (s && !s.body.jump) {
        const back = Math.min(BACK_TICKS, first - t);
        return { x: s.body.x - s.body.vx * back, y: s.body.y - s.body.vy * back, angle: s.body.angle - s.body.angVel * back, b: s as ReplicaState };
      }
    }
    const a = this.at(id, f);
    if (!a) return null;
    const b = this.at(id, f + 1) ?? a;
    const k = Math.max(0, Math.min(1, t - f));
    const da = wrapAngle(b.body.angle - a.body.angle);
    return { x: a.body.x + (b.body.x - a.body.x) * k, y: a.body.y + (b.body.y - a.body.y) * k, angle: a.body.angle + da * k, b };
  }

  /**
   * Where a ship is drawn at a fractional tick: between two stepped states, with any keyframe's correction blended
   * in (fixWeight), so a ship pushed off its predicted path (a boss's drive, a collision) bends onto the true one
   * instead of stepping. Drawing only: the states themselves (`at`) stay exact.
   */
  pose(id: number, t: number): { x: number; y: number; angle: number; vx: number; vy: number; jump: number; jumpScale: number; dodge: number; dodgeDir: number; aim: number; bits: number } | null {
    const raw = this.rawPose(id, t);
    if (!raw) return null;
    const { b } = raw;
    const rep = this.reps.get(id)!;
    const mode = rep.mode;
    // (Its path stepped again where it was drawn already (a control row, a decision, a cause for a tick it had run
    // ahead to): the change eases out from where it was drawn, as a late keyframe's does, instead of a jump)
    if (rep.moved && rep.raw && rep.raw.t <= t) {
      const now = this.rawPose(id, rep.raw.t);
      if (now) {
        const dx = rep.raw.x - now.x, dy = rep.raw.y - now.y, da = wrapAngle(rep.raw.angle - now.angle);
        if ((dx || dy || da) && dhypot(dx, dy) < SMOOTH_MAX) (rep.fixes ??= []).push({ t: rep.raw.t, s: rep.raw.t, dx, dy, da });
      }
    }
    rep.moved = false;
    rep.raw = { t, x: raw.x, y: raw.y, angle: raw.angle };
    let { x, y, angle } = raw;
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
