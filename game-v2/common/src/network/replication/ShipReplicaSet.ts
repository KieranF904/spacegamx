/**
 * @contract network.replication.set
 * owns:       the client's ShipReplicaSet: every other ship's timeline rebuilt from keyframes, control changes, pulls,
 *             clamp links and causes, stepped on demand with the shared replicaStep and rewound when news comes late
 * needs:      common/ships (replicaStep, ReplicaMode), common/sim (StateRing, ReplicaState, sources, pull fields, clamp
 *             links), network/clampProtocol types, network/replication/{wire,hooks,rep,pose,debris}
 * invariants: a client rebuilds every other ship exactly from keyframes, control changes and causes against the
 *             server's state — server/src/net/replication.test.ts
 *             a far ship costs nothing; coming into focus it is sent on its own and leaving is told once —
 *             server/src/net/replication.test.ts
 *             clamped pairs step as the server steps them — common/src/network/clampReplicas.test.ts
 * extend:     a new thing a replica is moved by is a source or cause passed in (hooks.ts), not a branch in its step
 */

import { ReplicaMode, ReplicaEnv, FlightBody, ShipTuning, ShipDerived, replicaStep } from '../../ships/index.js';
import { StateRing } from '../../sim/ring.js';
import { ReplicaState } from '../../sim/c-replicaState.js';
import { CtlChangeInputs, DriverInputs } from '../../sim/d-sources.js';
import type { InputSource } from '../../sim/input.js';
import type { PullSource } from '../../sim/env.js';
import { PullBook, fieldPulls, unpackPullField, type PullerPose, type PullFieldRow } from '../../sim/pullFields.js';
import { ClampLinks, linksSource, type ClampSource } from '../../sim/clampPair.js';
import type { ServerClampLinkMessage, ServerClampBreakMessage } from '../clampProtocol.js';
import { controlRowId, replicaAngle, unpackControlRow, unpackKeyframe, type ControlRow, type Keyframe, type KeyframeRow } from './wire.js';
import type { BodyDriver, DebrisShape, DebrisWorld, OwnTimeline, ReplicaCauses, ReplicaRewinds, ReplicaSideSteps, Step } from './hooks.js';
import { HISTORY, cloneBody, dropKeepingKf, rewrote, type Rep } from './rep.js';
import { GAP_MAX, bendPose, dropFixesFrom, noteKeyframeFix, poseBetween, poseComingIn, type DrawnPose, type RawPose } from './pose.js';
import { DebrisSteps } from './debris.js';

const NO_PULLS: readonly (readonly [number, number, number])[] = [];

/** stepPreNow's scratch: the ship before the step, as its input source reads it */
const PREV: { id: number; body: FlightBody; ctl: { bits: number; q: number } } = { id: 0, body: undefined as unknown as FlightBody, ctl: { bits: 0, q: 0 } };

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

  /** The env a step here flies in: the world's, with the pulls and the clamps' links (a copy: the host's may be shared) */
  private stepEnv(): ReplicaEnv {
    return this.clamps.size ? { ...this.env(), pulls: this.pullSource, clamp: this.clampSource } : { ...this.env(), pulls: this.pullSource };
  }

  /**
   * Docking Clamps' links (sim/clampPair.ts: the clampLink and clampBreak records): a leader is stepped as the pair, its
   * follower placed on it (the leader as it ended the tick), the tick an undock lets go each gets its push
   */
  readonly clamps = new ClampLinks();
  private readonly clampSource: ClampSource = linksSource(this.clamps,
    (id, t) => (this.own?.id === id ? this.own.src.derived(t) : this.causes?.derived(id, t)) || this.derived(id),
    (id, t) => { const st = this.at(id, t); return st ? { body: st.body, bits: st.bits } : null; });

  /** A lock or a swap (clampLink): both ships are stepped again from its tick */
  noteClampLink(m: Pick<ServerClampLinkMessage, 'tick' | 'leader' | 'follower' | 'lc' | 'fc' | 'offset' | 'fcargo'>): void {
    const from = this.clamps.link({ tick: m.tick, leader: m.leader, follower: m.follower, lc: m.lc, fc: m.fc, offset: m.offset, fcargo: m.fcargo });
    if (from !== Infinity) { this.rewindHeld(m.leader, from); this.rewindHeld(m.follower, from); }
  }

  /** The pair let go (clampBreak): both stepped again from its tick (an undock's push, `push`, on the leader `a`) */
  noteClampBreak(m: Pick<ServerClampBreakMessage, 'tick' | 'a' | 'b'> & { push?: readonly [number, number] }): void {
    const from = this.clamps.unlink(m.a, m.b, m.tick, m.push);
    if (from !== Infinity) { this.rewindHeld(m.a, from); this.rewindHeld(m.b, from); }
    this.clamps.prune(m.tick);
  }

  /**
   * A clamped follower's leader stepped to tick t before the follower's step starts: the step reads it there (the clamp
   * source), and the steppers' scratch isn't re-entrant, so it must not be stepped from inside it
   */
  private leaderFirst(id: number, t: number): void {
    if (!this.clamps.size) return;
    const x = this.clamps.recAt(id, t);
    if (x && x.follower === id) this.at(x.leader, t);
  }

  /** The ship this one is clamped to on tick t (undefined: none): the contact pass leaves the pair out */
  clampPartner(id: number, t: number): number | undefined {
    return this.clamps.size ? this.clamps.partner(id, t) : undefined;
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
    this.debrisSteps = new DebrisSteps(this.ring, this.reps, this.debris, () => this.env(), this.tuning);
  }

  private readonly debris?: DebrisWorld;

  /** Debris is stepped all together as a world (debris.ts), as on the server */
  private readonly debrisSteps: DebrisSteps;

  /** A piece of debris worked out here (common ships/debris.ts deriveSplit): it starts at `tick` as `body` */
  spawnDebris(id: number, tick: number, body: FlightBody): void {
    this.reps.set(id, { mode: ReplicaMode.Drift, events: new Map(), kf: tick, q: 0 });
    this.ring.remove(id); this.pre.remove(id); this.ahead.remove(id);
    this.ring.keep(tick, new ReplicaState(id, ReplicaMode.Drift, cloneBody(body), 0, 0));
    this.debrisSteps.stale(tick);
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
    // (A clamped leader: its follower sits on it, so it is stepped again from there too)
    if (this.clamps.size) for (const [f, from] of this.clamps.readers(id, t)) {
      if (this.stepping > 0) this.pullRewinds.push([f, from]); else this.rewindHeld(f, from);
    }
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
    this.leaderFirst(id, t);
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
    this.leaderFirst(id, t);
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
    // (Debris steps as a world, from where it was rewound to: DebrisSteps.stepTo does its own)
    const from = r.mode === ReplicaMode.Drift ? t : Math.max(t, r.kf + 1);
    dropKeepingKf(this.ring, id, r, from);
    rewrote(r, from);
    this.dropped(id, from);
    // (Debris steps as a world (DebrisSteps.stepTo): left as it is, the world, already past t, never stepped it again: frozen)
    if (r.mode === ReplicaMode.Drift) this.debrisSteps.stale(t - 1);
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
    this.clamps.clear();
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
      // (Debris: its keyframe is how that tick ended, so that tick is stepped again, the others without it: DebrisSteps.stepTo)
      if (k.mode === ReplicaMode.Drift) this.debrisSteps.stale(tick - 1);
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
    dropFixesFrom(r, tick);
    if (!this.ring.size(id) || tick <= r.kf || k.mode !== r.mode || k.mode === ReplicaMode.Docked || tick - this.lastT(id) > GAP_MAX) return;
    const was = this.at(id, tick);
    if (!was || (this.ring.get(id, tick) as Step | undefined) !== was) return;
    noteKeyframeFix(r, tick, was, k);
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
      try { this.debrisSteps.stepTo(tick); } finally { this.stepping--; }
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

  /** Its pose at a fractional tick between two stepped states, unbent (pose.ts) */
  private rawPose(id: number, t: number): RawPose | null {
    const f = Math.floor(t);
    const coming = poseComingIn(this.reps.get(id), this.ring, id, t);
    if (coming) return coming;
    const a = this.at(id, f);
    if (!a) return null;
    const b = this.at(id, f + 1) ?? a;
    return poseBetween(a, b, t, f);
  }

  /**
   * Where a ship is drawn at a fractional tick: between two stepped states, with any keyframe's correction blended
   * in (pose.ts fixWeight), so a ship pushed off its predicted path (a boss's drive, a collision) bends onto the true
   * one instead of stepping. Drawing only: the states themselves (`at`) stay exact.
   */
  pose(id: number, t: number): DrawnPose | null {
    const raw = this.rawPose(id, t);
    if (!raw) return null;
    return bendPose(this.reps.get(id)!, raw, t, (u) => this.rawPose(id, u));
  }
}
