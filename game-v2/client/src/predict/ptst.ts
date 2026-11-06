/**
 * The PT/ST layer: how the client predicts every other ship (prediction mode C3, the default; C2 without the touch
 * register). Pure: no GameState, no browser, so it tests with a fake transport (ptst.test.ts) and runs in the server's
 * crowd-bench probes (server bench/crowd/probe.ts).
 *
 *   PT  every other ship stepped by the client to the own predicted tick, once per tick, in its own StateRing: each
 *       ship's input from its kind (predict/shipKinds.ts: other pilots on held last input, AI on its decisions), then that
 *       tick's contact pass over the PT states (the world's `contacts`: predict/contacts.ts RealContacts, the server's
 *       pass on predicted ticks)
 *   ST  the confirmed state, from the world (the replica layer at a tick the snapshots have told)
 *
 * Each time the confirmed tick C moves on, every ship's ST(C) is hashed against the PT(C) it recorded (shipHash, the
 * ring's). A match costs nothing more. A miss re-steps that ship once, from ST(C) to the PT head, and the drawn pose
 * eases from the old PT to the new one over `lerpMs` (an offset that fades; one bigger than `snapDist` snaps: a
 * respawn, a teleport). With `touch` (C3), ships the missed ones touched in (C, head] (the contact SimEvents the steps
 * recorded: the touch register) are re-stepped with them, and a ship the re-stepped path newly touches joins at that
 * tick; without it (C2) only the missed ships are re-stepped, the others standing as they were (a touched ship is put
 * right only when its own ST says so, later and further off).
 *
 * Ships come and go with the world's list (`ships()`): one new to the layer (into view, a focus cell, a late joiner,
 * a respawn under a new id, a ship split off) starts from its ST at the confirmed tick, stepped alone to the head; one
 * gone from the list (out of view, removed, too far for the level of detail: shipKinds.ts PT_TUNING) drops its PT.
 *
 * Bodies the world calls `fixed` (the own ship, stepped on its own layer) push in the contact pass but are never moved
 * or re-stepped here; ships that aren't `pushable` (AI flown from its decisions: its path is its body's) likewise.
 *
 * Other kinds of thing on the PT layer (shells, mobs, boss attacks: their own tracks) plug in as a PtTrack
 * (`addTrack`): told after each tick the layer steps and after each re-step, with the ships it re-stepped.
 */
import { ReplicaState, StateRing, shipHash, type FlightBody, type SimEvent } from '@space-game/common';

export interface PoseXY { x: number; y: number; angle: number }

/** A body in a tick's contact pass: its state (the pass's to change in place), and whether the change is kept */
export interface PtBody {
  s: ReplicaState;
  /** Stepped now and pushable: what the pass does to it is its PT. Otherwise a scratch copy (it pushes, and the pass reads it pushed, as the server's does) */
  moves: boolean;
}

/** A tick's contact pass on the PT layer (predict/contacts.ts) */
export interface PtContacts {
  /**
   * Tick t's contacts over `bodies` (sorted by id), run as the server's pass runs them (pairs in the pass's order,
   * each from the bodies as earlier pairs left them): each body changed in place, a contact event per pair that
   * touched pushed to `out`
   */
  pass(t: number, bodies: readonly PtBody[], out: SimEvent[]): void;
  /** Could `s` touch one of `others` on tick t (C3: a ship the re-stepped path reaches joins the re-step) */
  touches(t: number, s: ReplicaState, others: Iterable<ReplicaState>): boolean;
  /** Ticks from t on are stepped again: what was found for them goes */
  dropFrom?(t: number): void;
  reset?(): void;
}

export interface PtStWorld {
  /** The ships to predict now (any order) */
  ships(): readonly number[];
  /** ST: a ship's confirmed state at tick t (t at or before the confirmed tick); null: not known there */
  st(id: number, t: number): ReplicaState | null;
  /** One tick of a ship from `prev` (its PT at t - 1) with its predicted input: a new state (prev untouched); null: can't */
  step(id: number, prev: ReplicaState, t: number): ReplicaState | null;
  /** The contact pass on predicted ticks (absent: no contacts on the PT layer) */
  contacts?: PtContacts;
  /** Can contacts here move it (default yes)? A ship flown by its decisions isn't: its path is its body's, not PT's */
  pushable?(id: number): boolean;
  /** Bodies that push but are never pushed or re-stepped here (the own ship), at tick t */
  fixed?(t: number): readonly ReplicaState[];
}

/**
 * Something else stepped on the PT layer (shells, mobs, boss attacks: the other tracks), told as the layer moves. Its
 * own state, hash and lerp are its own; this is where it hears the layer's ticks and re-steps
 */
export interface PtTrack {
  readonly name: string;
  /** The ships' tick t is stepped (advancing: every ship; a re-step: `group` only) */
  stepped?(t: number, layer: PtStLayer, group: ReadonlySet<number> | null): void;
  /** Ships re-stepped from confirmed tick c to the head (a miss, and with touch what it touched) */
  restepped?(c: number, ids: readonly number[], layer: PtStLayer): void;
  /** The layer started over (a mode switch, a reconnect) */
  reset?(): void;
}

export interface PtStOptions {
  /** C3: re-step what a missed ship touched (the touch register) */
  touch: boolean;
  /** Ticks of PT kept per ship */
  keep?: number;
  /** ms the drawn pose takes to ease from the old PT to the new after a re-step */
  lerpMs?: number;
  /** A correction this far (world units) or more snaps instead of easing */
  snapDist?: number;
  /** Clock (ms) for the lerp and the CPU timing */
  now?: () => number;
}

export interface PtStCorrection {
  id: number;
  /** The confirmed tick that showed the miss */
  tick: number;
  from: PoseXY;
  to: PoseXY;
  /** Ticks re-stepped for it */
  ticks: number;
  /** Re-stepped only because it touched a missed ship (C3) */
  touched: boolean;
  /** Snapped (too far to ease) */
  snapped: boolean;
  at: number;
}

export interface PtStStats {
  /** Ticks the PT layer advanced (each steps every ship once) */
  ticks: number;
  /** Ship steps taken advancing (not re-steps) */
  steps: number;
  checks: number;
  matches: number;
  misses: number;
  /** Ships re-stepped (a miss, or touched by one) */
  restepShips: number;
  /** ...of which re-stepped only for a touch (C3) */
  touchShips: number;
  /** Ship-ticks re-stepped */
  restepTicks: number;
  /** Confirms that re-stepped something */
  resteps: number;
  /** ms spent re-stepping, and advancing */
  restepMs: number;
  advanceMs: number;
  /** ...of both, ms in the contact pass, and in re-reading the ship list */
  contactMs: number;
  syncMs: number;
  /** Ships started from ST (new to the layer, or out of its window) */
  seeds: number;
  /** Ships dropped (gone from the world's list) */
  drops: number;
  /** Contacts the PT steps found */
  contacts: number;
  /** Re-steps that moved a ship's head, and how far in all (world units); of them snapped */
  corrections: number;
  correctionDist: number;
  snaps: number;
}

const smoothstep = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const wrap = (d: number) => { while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const cloneBody = (b: FlightBody): FlightBody => ({ ...b });
export const copyState = (s: ReplicaState): ReplicaState => new ReplicaState(s.id, s.mode, cloneBody(s.body), s.bits, s.q);

interface Offset { dx: number; dy: number; da: number; at: number }

/** (Same as the replica layer's: a correction this big is a teleport, a blink, a respawn) */
export const PT_SNAP_DIST = 400;

export class PtStLayer {
  readonly ring: StateRing;
  /** The newest tick PT is stepped to */
  head = -Infinity;
  /** The newest confirmed tick checked */
  confirmed = -Infinity;
  readonly stats: PtStStats = PtStLayer.noStats();
  static noStats(): PtStStats {
    return { ticks: 0, steps: 0, checks: 0, matches: 0, misses: 0, restepShips: 0, touchShips: 0, restepTicks: 0, resteps: 0, restepMs: 0, advanceMs: 0, contactMs: 0, syncMs: 0, seeds: 0, drops: 0, contacts: 0, corrections: 0, correctionDist: 0, snaps: 0 };
  }
  /** The touch register: each tick's contact events */
  private readonly register = new Map<number, SimEvent[]>();
  private readonly offsets = new Map<number, Offset>();
  private live = new Set<number>();
  private pending: PtStCorrection[] = [];
  private readonly tracks: PtTrack[] = [];
  private readonly now: () => number;
  readonly opts: Required<Omit<PtStOptions, 'now'>>;

  constructor(private readonly world: PtStWorld, opts: PtStOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.opts = { touch: opts.touch, keep: opts.keep ?? 240, lerpMs: opts.lerpMs ?? 150, snapDist: opts.snapDist ?? PT_SNAP_DIST };
    this.ring = new StateRing(this.opts.keep);
  }

  /** Switch C2 <-> C3, or the lerp, live */
  set(o: Partial<Pick<PtStOptions, 'touch' | 'lerpMs'>>): void {
    if (o.touch !== undefined) this.opts.touch = o.touch;
    if (o.lerpMs !== undefined) this.opts.lerpMs = o.lerpMs;
  }

  /** Plug another kind of thing into the layer's ticks (PtTrack) */
  addTrack(t: PtTrack): void {
    this.tracks.push(t);
  }

  reset(): void {
    this.ring.clear();
    this.register.clear();
    this.offsets.clear();
    this.live.clear();
    this.pending = [];
    this.head = this.confirmed = -Infinity;
    this.world.contacts?.reset?.();
    Object.assign(this.stats, PtStLayer.noStats());
    for (const t of this.tracks) t.reset?.();
  }

  /** Corrections since last asked */
  takeCorrections(): PtStCorrection[] {
    const p = this.pending;
    this.pending = [];
    return p;
  }

  /** The ships on the layer now */
  ids(): ReadonlySet<number> {
    return this.live;
  }

  /**
   * Step PT to tick `to` (the own prediction's tick), every ship once a tick. Ships new to the layer start from their
   * ST at the confirmed tick (nothing is stepped before the first confirm). A ship gone from the world is dropped
   */
  advance(to: number): void {
    if (this.confirmed === -Infinity || (to <= this.head && this.head !== -Infinity)) return;
    const t0 = this.now();
    this.sync();
    if (this.head === -Infinity || to - this.head > this.opts.keep / 2) {
      // (Starting out, or far behind (a stall): everything from ST)
      this.head = Math.max(this.confirmed, to);
      for (const id of this.live) this.seed(id);
    }
    while (this.head < to) {
      const t = this.head + 1;
      for (const id of this.live) if (!this.ring.has(id, t - 1)) this.seed(id, t - 1);
      this.stepTick(t, null);
      this.head = t;
      this.stats.ticks++;
    }
    this.stats.advanceMs += this.now() - t0;
    for (const k of this.register.keys()) if (k <= this.confirmed - 4) this.register.delete(k);
  }

  /**
   * The confirmed tick moved on to `c`: each ship's ST(c) against its PT(c); the misses (and, with `touch`, what they
   * touched) re-stepped once from ST(c) to the head. Returns the ships re-stepped
   */
  confirm(c: number): number[] {
    if (c <= this.confirmed) return [];
    this.confirmed = c;
    if (this.head === -Infinity) return [];
    this.sync();
    if (this.head < c) {
      // (The prediction behind what's confirmed: nothing to check; PT restarts from ST)
      this.head = c;
      for (const id of this.live) this.seed(id);
      return [];
    }
    const missed = new Set<number>();
    for (const id of this.live) {
      const st = this.world.st(id, c);
      if (!st || !this.ring.has(id, c)) continue;
      this.stats.checks++;
      if (this.ring.hash(id, c) === shipHash(st)) this.stats.matches++;
      else { this.stats.misses++; missed.add(id); }
    }
    if (!missed.size) return [];
    return this.restep(c, missed);
  }

  /** Re-step `missed` (and with `touch`, what touched them) from ST(c) to the head, once */
  private restep(c: number, missed: Set<number>): number[] {
    const t0 = this.now();
    const group = new Set(missed);
    const touchedOnly = new Set<number>();
    if (this.opts.touch) {
      // (Everything the register says touched a re-stepped ship after c, and what touched those: they go together)
      let grew = true;
      while (grew) {
        grew = false;
        for (const [t, evs] of this.register) {
          if (t <= c) continue;
          for (const e of evs) {
            if (e.k !== 'contact') continue;
            const ina = group.has(e.a), inb = group.has(e.b);
            if (ina === inb) continue;
            const other = ina ? e.b : e.a;
            if (!this.live.has(other)) continue;
            group.add(other); touchedOnly.add(other); grew = true;
          }
        }
      }
    }
    const old = new Map<number, PoseXY>();
    const from = new Map<number, number>();
    for (const id of group) {
      const h = this.ring.get(id, this.head) as ReplicaState | undefined;
      if (h) old.set(id, { x: h.body.x, y: h.body.y, angle: h.body.angle });
      const st = this.world.st(id, c) ?? (this.ring.get(id, c) as ReplicaState | undefined);
      this.ring.dropFrom(id, c);
      if (st) this.ring.keep(c, copyState(st), id);
      from.set(id, c);
    }
    // (Their contacts after c go: the re-step finds them again)
    for (const [t, evs] of this.register) {
      if (t <= c) continue;
      const kept = evs.filter((e) => e.k !== 'contact' || (!group.has(e.a) && !group.has(e.b)));
      if (kept.length) this.register.set(t, kept); else this.register.delete(t);
    }
    this.world.contacts?.dropFrom?.(c + 1);
    for (let t = c + 1; t <= this.head; t++) {
      const joined = this.stepTick(t, group);
      for (const id of joined) {
        touchedOnly.add(id);
        from.set(id, t - 1);
        const h = this.ring.get(id, this.head) as ReplicaState | undefined;
        if (h && !old.has(id)) old.set(id, { x: h.body.x, y: h.body.y, angle: h.body.angle });
      }
    }
    const now = this.now();
    for (const id of group) {
      this.stats.restepShips++;
      if (touchedOnly.has(id) && !missed.has(id)) this.stats.touchShips++;
      this.stats.restepTicks += this.head - (from.get(id) ?? c);
      const was = old.get(id), h = this.ring.get(id, this.head);
      if (!was || !h) continue;
      const to = { x: h.body.x, y: h.body.y, angle: h.body.angle };
      const dx = was.x - to.x, dy = was.y - to.y, da = wrap(was.angle - to.angle);
      if (!dx && !dy && !da) continue;
      const dist = Math.hypot(dx, dy), snapped = dist >= this.opts.snapDist;
      this.stats.corrections++;
      this.stats.correctionDist += dist;
      if (snapped) { this.stats.snaps++; this.offsets.delete(id); }
      else {
        // (What's left of an earlier ease carries on into this one)
        const o = this.offsets.get(id), w = o ? this.weight(o, now) : 0;
        this.offsets.set(id, { dx: dx + (o ? o.dx * w : 0), dy: dy + (o ? o.dy * w : 0), da: da + (o ? o.da * w : 0), at: now });
      }
      this.pending.push({ id, tick: c, from: was, to, ticks: this.head - (from.get(id) ?? c), touched: !missed.has(id), snapped, at: now });
    }
    this.stats.resteps++;
    this.stats.restepMs += this.now() - t0;
    const ids = [...group];
    for (const tr of this.tracks) tr.restepped?.(c, ids, this);
    return ids;
  }

  /**
   * One tick of the layer: `group` null steps every ship; otherwise only the group (a re-step), the rest standing as
   * they were stepped. Then the tick's contact pass: every ship on the layer and the fixed bodies, what was stepped now
   * (and is pushable) taking the pushes. With `touch`, a ship a group member now touches joins the group from this tick
   * (returned)
   */
  private stepTick(t: number, group: Set<number> | null): number[] {
    const next = new Map<number, ReplicaState>();
    const ids = group ?? this.live;
    for (const id of ids) this.stepOne(id, t, next);
    if (!group) this.stats.steps += next.size;
    const joined: number[] = [];
    const cs = this.world.contacts;
    if (cs) {
      if (group && this.opts.touch) {
        // (A ship the new path touches joins: stepped now from its own tick before, then in the pass with the group)
        for (let pass = 0; pass < 4; pass++) {
          let more = false;
          for (const id of this.live) {
            if (next.has(id)) continue;
            const s = this.ring.get(id, t) as ReplicaState | undefined;
            if (!s || !cs.touches(t, s, next.values())) continue;
            this.stepOne(id, t, next);
            if (next.has(id)) { group.add(id); joined.push(id); more = true; }
          }
          if (!more) break;
        }
      }
      this.contacts(t, next, cs);
    }
    for (const [id, s] of next) this.ring.keep(t, s, id);
    for (const tr of this.tracks) tr.stepped?.(t, this, group);
    return joined;
  }

  private stepOne(id: number, t: number, next: Map<number, ReplicaState>): void {
    const prev = this.ring.get(id, t - 1) as ReplicaState | undefined;
    if (!prev) return;
    const s = this.world.step(id, prev, t);
    if (!s) return;
    next.set(id, s.body === prev.body ? copyState(s) : s);
  }

  /** The tick's contact pass: every body on the layer (and the fixed ones), sorted by id */
  private contacts(t: number, next: Map<number, ReplicaState>, cs: PtContacts): void {
    const bodies: PtBody[] = [];
    let movers = 0;
    for (const id of this.live) {
      const n = next.get(id);
      if (n && (this.world.pushable?.(id) ?? true)) { bodies.push({ s: n, moves: true }); movers++; continue; }
      const s = n ?? (this.ring.get(id, t) as ReplicaState | undefined);
      if (s) bodies.push({ s: copyState(s), moves: false });
    }
    if (!movers) return;
    for (const f of this.world.fixed?.(t) ?? []) if (!this.live.has(f.id)) bodies.push({ s: copyState(f), moves: false });
    if (bodies.length < 2) return;
    bodies.sort((a, b) => a.s.id - b.s.id);
    const evs: SimEvent[] = [];
    const t0 = this.now();
    cs.pass(t, bodies, evs);
    this.stats.contactMs += this.now() - t0;
    if (!evs.length) return;
    // (Only pairs with a ship stepped now: the rest stood as they were, their contacts already in the register)
    let reg = this.register.get(t);
    for (const e of evs) {
      if (e.k !== 'contact' || !(this.moved(e.a, next) || this.moved(e.b, next))) continue;
      if (!reg) this.register.set(t, (reg = []));
      reg.push(e);
      this.stats.contacts++;
    }
  }

  private moved(id: number, next: Map<number, ReplicaState>): boolean {
    return next.has(id) && (this.world.pushable?.(id) ?? true);
  }

  /** Bring the ship list up to date: new ones start from ST (advance), gone ones go */
  private sync(): void {
    const t0 = this.now();
    const now = new Set(this.world.ships());
    this.stats.syncMs += this.now() - t0;
    for (const id of this.live) if (!now.has(id)) { this.ring.remove(id); this.offsets.delete(id); this.stats.drops++; }
    this.live = now;
  }

  /** Start a ship at its ST at the confirmed tick, stepped alone (no contacts) up to `to` (default the head) */
  private seed(id: number, to = this.head): void {
    const c = Math.min(this.confirmed, to);
    const st = this.world.st(id, c);
    this.ring.remove(id);
    if (!st) return;
    this.stats.seeds++;
    this.ring.keep(c, copyState(st), id);
    for (let t = c + 1; t <= to; t++) {
      const prev = this.ring.get(id, t - 1) as ReplicaState;
      const s = this.world.step(id, prev, t);
      if (!s) { this.ring.remove(id); return; }
      this.ring.keep(t, s.body === prev.body ? copyState(s) : s, id);
    }
  }

  private weight(o: Offset, now: number): number {
    return 1 - smoothstep((now - o.at) / Math.max(1, this.opts.lerpMs));
  }

  /** PT at a fractional tick (between two stepped ticks; at most the head), no ease */
  ptPose(id: number, t: number): PoseXY | null {
    const f = Math.min(Math.floor(t), this.head);
    const a = this.ring.get(id, f);
    if (!a) return null;
    const b = f < this.head ? this.ring.get(id, f + 1) ?? a : a;
    const k = Math.max(0, Math.min(1, t - f));
    return { x: a.body.x + (b.body.x - a.body.x) * k, y: a.body.y + (b.body.y - a.body.y) * k, angle: a.body.angle + wrap(b.body.angle - a.body.angle) * k };
  }

  /** Where it is drawn at tick t: PT, with what's left of a correction's ease added */
  pose(id: number, t: number, now = this.now()): PoseXY | null {
    const p = this.ptPose(id, t);
    if (!p) return null;
    const o = this.offsets.get(id);
    if (o) {
      const w = this.weight(o, now);
      if (w <= 0) this.offsets.delete(id);
      else { p.x += o.dx * w; p.y += o.dy * w; p.angle += o.da * w; }
    }
    return p;
  }

  has(id: number): boolean {
    return this.ring.size(id) > 0;
  }
}
