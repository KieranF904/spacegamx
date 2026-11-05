/**
 * A staged boss's brain (docs/boss-design.md): what every one shares, so a new boss only writes its moves.
 *
 *   its loop     each stage a fixed loop of moves (`loop`), gone through in order, a move it can't do skipped; a
 *                move is its moves' (common bodies/moves: the same on every client running its body), a generator
 *                setting `want` each tick, started by a MOVE decision (its seed for its rolls)
 *   flying       between moves it circles its target at its stage's range (`range`, `circle`), held to its ground;
 *                lighter stages drive harder (`drive`); it turns as its hull lets it, braking onto its heading (bosses.json `turn`)
 *   its stages   its pieces' `stage` (stages.ts): when the one it's fighting with has nothing deciding left standing,
 *                it stops everything (`stop`), can't be hurt, holds still, and blows that stage away piece by piece
 *                (`blowStage`); its last stage beaten, it shudders and every piece blows apart at once (`die`)
 *   its rules    signature moves open weak-point windows, pilots present draw personal attacks (fightRules.ts)
 *   phases       a boss with `exposure` (rework 2026-11 section 15) chains its stage's loop into one attack phase: each
 *                move straight into the next (`chain` ticks apart), then one window. Between its signature moves and
 *                in its window (after the rest beat) it keeps up a light threat of its own (`harass`: its moves' harassShot)
 *   dev          `forceShed` steps through its stages' looks: shot off, wrecked, blown away; the boss tools
 *                (game/dev/bossDev.ts) hold it, play a move next, open a window, force a personal attack
 *
 * Its moves on the wire (decision-inputs stage 4, CAPS.MOVES): what the brain picks goes as decisions (MOVE, HARASS,
 * PERSONAL, WINDOW, HOLD, CAP: common bodies/decisions.ts), and a client running its body runs the same moves from them
 * (common bodies/moves/track.ts), drawing their tells and straight shells itself. What only the server knows (who is
 * near for the density cap, damage, pulls, homing shells, mobs) is the moves' `work`, here.
 */

import {
  Position, Velocity, Rotation, ShipState, currentStage, deciding, isRuined, pointInConvex, stageOf, stagedIntegrity, RUIN_HP, datan2, dcos, dhypot, dsin,
  CTL, DECISION, WANT, BODY_KINDS, MOVES_HOLD, NO_ORIGIN, STAGED_MOVES, applyDecision, sameWant, stagedFlight, syncArgs, wantFly, wantHold, dequantizeCursorAngle,
  hashString, restBeat, staggered, capMask, moveShotSeed, partState, StagedMoves,
  type BodyState, type StagedFlightTables, type WantRec, type WindowSpec, type MoveHost, type MovePose,
} from '@space-game/common';
import type { PilotOrders } from '../../ships/ShipBridge.js';
import { BossBrain, BossView, BrainHost, partMount, pose, strike } from './kit.js';
import { FightRules, DEV_WINDOW, type FightTables } from './fightRules.js';

export type Move = Generator<void, void, void>;

/**
 * What a move wants of the ship this tick (common bodies/decisions.ts WANT: fly, hold, hold facing its target or a
 * heading or where its target is going, drive a way with a kick). Its body flies the ship from it, on the server and on
 * the clients that run it alike (common bodies/stagedFlight.ts): a want that changes is a decision sent them
 */
export type Want = WantRec;

/** A staged boss's shape of fight: its tables, by stage (index 0 its first); its flight is its body's (common bodies/registry.ts) */
export interface StagedTables extends FightTables {
  /** Its moves in the order it goes through them */
  loop: string[][];
  /** Ticks of rest between moves */
  rest: number[];
  /** Warnings × this */
  haste: number[];
  /** (attack phases: `exposure`) ticks between one chained move's end and the next's start, by stage */
  chain?: number[];
  /** Ticks between its harassing shots (outside its signature moves, rest beats and staggers), by stage (0: none) */
  harass?: number[];
}

/** (attack phases) Nothing in its loop it can do now: it flies (harassing) this long, and after two of these shows its window as ever */
const EMPTY_SLOT = 180;

/** Between stages: ticks it holds still before (and after) blowing a stage away, and between each blast */
const BLOW_PAUSE = 45, BLOW_GAP = 6;
/** Blowing a stage away: how hard its pieces drift clear, within how long they crumble (no cover left lying about) */
const BLOW_FLING = 3, BLOW_CRUMBLE = 200;
/** Dying: ticks it shudders before it blows apart, how hard its chunks are thrown, and how long they last before they crumble */
const DEATH_SHUDDER = 75, DEATH_FLING = 13, DEATH_CRUMBLE = 300;
/** Enraged (its last phase): rests and warnings × this */
const RAGE = 0.8;

/** A staged boss with no moves of its own yet (the Brood Mother) */
class NoMoves extends StagedMoves {
  readonly names: readonly string[] = [];
  make(): null { return null; }
}

export abstract class StagedBrain implements BossBrain {
  protected view!: BossView;
  protected ship!: ShipState;
  protected target = -1;
  protected want: Want = wantFly();
  protected move: Move | null = null;
  /** The tick the move under way started (its MOVE) */
  private moveAt = -Infinity;
  /** Its place in its stage's loop */
  protected step = 0;
  protected restUntil = 0;
  protected side = 1;
  /** The stage it's fighting in, and between stages, what it's still to blow away (and when) */
  protected stage = 1;
  protected blows: { at: number; run: () => void }[] = [];
  protected dying = false;
  /** Its drones (mobs it launched) */
  protected drones = new Set<number>();
  private forced = 0;
  /** (attack phases) empty slots flown since its last window; its next harassing shot, and how many so far */
  private empty = 0;
  private harassAt = 0;
  private harassN = 0;
  /** Its flight (its body's: range, circle, drive and ground by stage) */
  protected readonly flight: StagedFlightTables;
  /** Its body's state as its decisions have left it (the clients that run its body fold the same decisions in) */
  readonly body: BodyState;
  /** Its windows and personal attacks (fightRules.ts) */
  readonly fight: FightRules;
  /** The move it's in (by name: '' none) */
  moveName = '';
  /** (dev) held still, no moves; the move it plays next */
  devHold = false;
  private devNext: string | null = null;
  /** Its moves (common bodies/moves), made at its first tick (when it knows its ship) */
  private moves: StagedMoves | null = null;
  /** Its moves' HOLD as last decided (MOVES_HOLD), its shells this tick (their seeds), its density caps this tick */
  private hold = MOVES_HOLD.RUN as number;
  private shots = { tick: -1, n: 0 };
  private caps = { tick: -1, k: 0 };
  /** Its parts' states as its moves last read them (PART_STATE) */
  private parts: Uint8Array | null = null;

  constructor(protected host: BrainHost, protected tables: StagedTables, private readonly brain: string) {
    const kind = Math.max(0, BODY_KINDS.findIndex((k) => k.brain === brain));
    this.flight = BODY_KINDS[kind].flight!;
    this.body = { kind, homeX: 0, homeY: 0, stage: 1, side: 1, target: -1, want: wantFly(), wantAt: 0, on: false };
    this.fight = new FightRules(host, tables, hashString(brain));
    this.fight.opened = (w) => this.decide(DECISION.WINDOW, [w.ticks, w.cap]);
  }

  /** Its moves (common bodies/moves: by its brain) */
  protected get mv(): StagedMoves {
    if (!this.moves) {
      const h = this.moveHost(), k = STAGED_MOVES[this.brain];
      this.moves = k ? k.make(h, this.view.eid, this.flight) : new NoMoves(h, this.view.eid, this.flight, [1, 1, 1]);
    }
    return this.moves;
  }

  /** Its personal attacks' names (a PERSONAL's name index) */
  private get personalNames(): readonly string[] {
    return STAGED_MOVES[this.brain]?.personalNames ?? ['mark'];
  }

  /** A move by name, or null if it can't do it now (its part is gone) */
  protected make(id: string): Move | null {
    return this.mv.make(id);
  }

  /** Every tick it's fighting (between moves too): its own passive work besides its moves' (a boss's heat, its window's look) */
  protected passives(_now: number): void {}
  /** A move that cuts in ahead of its loop (a punish), or null */
  protected interrupt(_now: number): Move | null { return null; }
  /** Its stages beaten: hooks to stop what its brain leaves running */
  protected onStop(): void {}
  /** Of a volley's shots (out of (x, y) along `angles`), those its density cap keeps (none: all) */
  protected capped(_x: number, _y: number, angles: number[]): number[] {
    return angles;
  }

  orders(base: PilotOrders | null, ship: ShipState, view: BossView): PilotOrders | null {
    this.view = view;
    this.ship = ship;
    const now = this.host.tick();
    const t = base?.target ?? -1;
    this.target = t;
    this.want = wantFly();
    const mv = this.mv;
    mv.target = t; mv.want = wantFly(); mv.homeX = this.body.homeX; mv.homeY = this.body.homeY;
    this.partsNow();
    this.shedding(now);
    mv.stage = this.stage;
    // (blown apart: nothing left to fly)
    if (!this.host.ships.get(view.eid)) return null;
    if (this.blows.length && base) {
      this.move = null;
      this.want = wantHold();
      if (t >= 0) return this.fly(base, t);
      this.bodyOff();
      return { ...base, firing: false };
    }
    if (t < 0) { this.move = null; this.moveName = ''; this.bodyOff(); return base; }
    this.fight.tickWindow(view.eid, view.systemNum, now);
    // (A window running (open, or a crack's stagger), or held by the dev tools: no move starts; staggered, it holds still)
    if (this.fight.staggered(now) || this.devHold) { this.move = null; this.moveName = ''; this.holdMoves(MOVES_HOLD.PAUSE); this.want = wantHold(); return this.fly(base!, t); }
    this.holdMoves(MOVES_HOLD.RUN);
    if (!this.move && now >= this.restUntil && !this.fight.holding(now)) {
      this.move = this.pick(now);
      if (!this.move && this.tables.exposure) {
        // (Its whole loop broken off: it flies, harassing, and shows its window as ever: safer, not slower)
        this.restUntil = now + EMPTY_SLOT;
        if (++this.empty >= 2) { this.empty = 0; this.expose(now); }
      }
    }
    mv.side = this.side > 0 ? 1 : -1;
    mv.present = view.present;
    mv.passives(now);
    this.passives(now);
    this.harassing(now);
    this.fight.cause = this.moveName;
    if (this.move) {
      mv.h.origin = { t: this.moveAt, who: -1 };
      const done = this.move.next().done;
      mv.h.origin = NO_ORIGIN;
      if (done) {
        const name = this.moveName;
        this.move = null;
        this.moveName = '';
        if (this.tables.exposure) {
          // (Attack phases: the next move of its loop straight on; its loop done, its one window, then its rest)
          this.empty = 0;
          if (this.phaseOver()) this.expose(now);
          else this.restUntil = now + (this.tables.chain?.[this.stage - 1] ?? 0);
        } else {
          // (A windowed boss's rest comes after its window, and is never scaled by how many fight it: rework 2.3)
          this.fight.finished(name, view.eid, view.systemNum, now);
          const w = this.fight.windowed ? this.fight.window : null;
          this.restUntil = (w && w.at === now ? w.at + w.ticks : now)
            + Math.round(this.tables.rest[this.stage - 1] * this.rage() / (this.fight.windowed ? 1 : 1 + 0.15 * (view.fighters - 1)));
        }
      }
    }
    this.side = mv.side;
    this.want = mv.want;
    this.fight.personal(view.eid, this.stage, now, view.present ?? this.pilots(), this.fight.isSignature(this.moveName), mv, this.personalNames,
      (op, args) => this.host.decide?.(view.eid, op, args, this.body));
    return this.fly(base!, t);
  }

  idle(): boolean {
    return !this.move && !this.blows.length && !this.dying;
  }

  /**
   * Its parts as its moves read them (PART_STATE: on, gone, a wreck): a change is a PART
   * decision, so the clients running its moves read each part as it was on the tick (part damage is the server's)
   */
  private partsNow(): void {
    const ship = this.ship, cat = this.host.ships.catalog, n = ship.blueprint.parts.length;
    if (!this.parts || this.parts.length !== n) { this.parts = Uint8Array.from({ length: n }, (_, i) => partState(cat, ship, i)); return; }
    for (let i = 0; i < n; i++) {
      const s = partState(cat, ship, i);
      if (s === this.parts[i]) continue;
      this.parts[i] = s;
      this.decide(DECISION.PART, [i, s]);
    }
  }

  /** Its moves' HOLD: the clients running them stop or go on with them as it does */
  private holdMoves(mode: number): void {
    if (this.hold === mode) return;
    this.hold = mode;
    this.decide(DECISION.HOLD, [mode]);
  }

  // ---- Its moves' host (common bodies/moves/host.ts): the server's side ----

  private moveHost(): MoveHost {
    const b = this, host = this.host;
    const poseOf = (e: number): MovePose => ({ x: Position.x[e], y: Position.y[e], angle: Rotation.angle[e], vx: Velocity.x[e], vy: Velocity.y[e] });
    const h: MoveHost = {
      tick: () => host.tick(),
      me: () => poseOf(b.view.eid),
      pose: (id) => (host.ships.get(id) ? poseOf(id) : null),
      ship: () => b.ship,
      catalog: host.ships.catalog,
      geometry: (s) => host.ships.geometry(s),
      cellSize: host.ships.tuning.cellSize,
      terrain: () => host.terrain?.(b.view.systemNum),
      fx: (msg) => {
        if (host.moveFx) host.moveFx(b.view.systemNum, b.view.eid, h.origin, msg);
        else host.send(b.view.systemNum, msg);
      },
      shoot: (s) => {
        const now = host.tick();
        if (b.shots.tick !== now) b.shots = { tick: now, n: 0 };
        const seed = moveShotSeed(b.view.eid, now, b.shots.n++);
        if (host.moveShot) host.moveShot(b.view.eid, s.kind, s.x, s.y, s.angle, s.scale, s.speed, seed, h.origin);
        else host.fire(b.view.eid, s.kind, s.x, s.y, s.angle, s.scale, { speed: s.speed, seed });
      },
      cap: (x, y, angles) => {
        const now = host.tick();
        if (b.caps.tick !== now) b.caps = { tick: now, k: 0 };
        const k = b.caps.k++, kept = b.capped(x, y, angles);
        if (kept.length < angles.length) b.decide(DECISION.CAP, [k, capMask(angles, kept)]);
        return kept;
      },
      get mobs() { return !!host.mobs; },
      work: {
        players: () => host.players(b.view.systemNum),
        segmentHit: (id, x0, y0, x1, y1, half) => {
          const sh = host.ships.get(id), r = sh && host.ships.segmentHit(id, sh, x0, y0, x1, y1, half);
          return r ? r.part : -1;
        },
        damage: (id, part, amount, how) => host.ships.damagePartBy(id, part, amount, b.view.eid, how),
        splash: (x, y, r, amount) => strike(host, b.view.systemNum, x, y, r, amount, b.view.eid),
        push: (id, dx, dy) => host.ships.push(id, dx, dy),
        homing: (kind, x, y, a, scale, target) => host.fire(b.view.eid, kind, x, y, a, scale, { target }),
        mob: (kind, x, y, a, speed, scale, target) => {
          const d = host.mobs?.spawn(kind, b.view.systemNum, x, y, a, speed, b.view.eid, scale, target) ?? -1;
          if (d >= 0) b.drones.add(d);
          return d;
        },
        say: (msg) => host.send(b.view.systemNum, msg),
        get damageScale() { return b.view.damage; },
      },
      origin: NO_ORIGIN,
    };
    return h;
  }

  // ---- Attack phases (tables' `exposure`) ----

  /** Is its attack phase over: its loop gone round, or nothing left in it it can do */
  private phaseOver(): boolean {
    const loop = this.tables.loop[this.stage - 1], at = this.step % loop.length;
    if (at === 0) return true;
    for (let k = at; k < loop.length; k++) if (this.make(loop[k])) return false;
    return true;
  }

  /** Its attack phase done: its one window opens (its stage's), its rest after it; the next phase from the top of its loop */
  protected expose(now: number): void {
    const spec = this.tables.exposure?.[this.stage - 1];
    this.step = 0;
    if (!spec) { this.restUntil = now + this.tables.rest[this.stage - 1]; return; }
    this.fight.open(spec, this.view.eid, this.view.systemNum, now);
    this.onExpose(now, spec);
    this.restUntil = now + spec.ticks + this.tables.rest[this.stage - 1];
  }

  /** Its window opened (a boss's own look or state for it; clients draw the exposure from the window itself) */
  protected onExpose(_now: number, _spec: WindowSpec): void {}

  /**
   * Its light threat between signature moves and in its window (after the rest beat; never in a stagger): a harassing
   * shot every `harass` ticks at its pilots in turn (its moves' `harassShot`; a HARASS decision, its pilot's client
   * works it out)
   */
  private harassing(now: number): void {
    const every = this.tables.harass?.[this.stage - 1] ?? 0;
    if (!every || now < this.harassAt || this.blows.length || this.dying) return;
    if (this.move && this.fight.isSignature(this.moveName)) return;
    const w = this.fight.window;
    if (w && (restBeat(w, now) || staggered(w, now))) return;
    const who = this.view.present?.length ? this.view.present : this.pilots();
    if (!who.length) return;
    const t = who[this.harassN % who.length], mv = this.mv;
    mv.h.origin = { t: now, who: t };
    const shot = mv.harassShot(t);
    mv.h.origin = NO_ORIGIN;
    if (shot) { this.harassN++; this.harassAt = now + every; this.decide(DECISION.HARASS, [t + 1]); }
    else this.harassAt = now + 20;
  }

  dispose(): void {
    // (Let go of (despawned, defeated): its body stops on every client running it, and its decisions are forgotten)
    if (this.view) this.bodyOff();
    if (this.view) this.host.mobs?.clear(this.view.systemNum, this.view.eid);
    this.drones.clear();
  }

  // ---- Flying ----

  /**
   * Flown by its body (common bodies/stagedFlight.ts) from its decisions: what changed since the last tick (its target,
   * which way round, its stage, what its move wants) is decided first, at this tick, then the body works the controls and
   * its drive's push out, as every client running the body does from the same decisions
   */
  protected fly(base: PilotOrders, t: number): PilotOrders {
    const now = this.host.tick(), b = this.body, eid = this.view.eid;
    if (!b.on) {
      // (Its body takes over (again): the whole state; the clients running it start from it here)
      b.on = true;
      b.homeX = Math.round(this.view.home.x); b.homeY = Math.round(this.view.home.y);
      b.target = t; b.stage = this.stage; b.side = this.side > 0 ? 1 : -1; b.want = this.want; b.wantAt = now;
      this.host.decide?.(eid, DECISION.SYNC, syncArgs(b), b);
      // (its moves held: a SYNC says nothing of that, so it goes again)
      if (this.hold !== MOVES_HOLD.RUN) this.decide(DECISION.HOLD, [this.hold]);
    }
    if (b.target !== t) this.decide(DECISION.TARGET, [t + 1]);
    if (b.stage !== this.stage) this.decide(DECISION.STAGE, [this.stage]);
    // (Which way round it circles: now and then it turns about, rolled here, never by its body)
    if (this.want[0] === WANT.FLY && this.host.rng() < 0.004) this.side = -this.side;
    if ((b.side > 0) !== (this.side > 0)) this.decide(DECISION.SIDE, [this.side > 0 ? 1 : 0]);
    if (!sameWant(b.want, this.want)) this.decide(DECISION.WANT, this.want);
    const me = { x: Position.x[eid], y: Position.y[eid], angle: Rotation.angle[eid], vx: Velocity.x[eid], vy: Velocity.y[eid] };
    const tg = { x: Position.x[t], y: Position.y[t], angle: Rotation.angle[t], vx: Velocity.x[t], vy: Velocity.y[t] };
    const out = stagedFlight(this.flight, b, me, tg, now);
    const controls = {
      forward: (out.bits & CTL.forward) !== 0, backward: (out.bits & CTL.backward) !== 0, left: (out.bits & CTL.left) !== 0, right: (out.bits & CTL.right) !== 0,
      boost: (out.bits & CTL.boost) !== 0, targetAngle: dequantizeCursorAngle(out.q),
    };
    // (it turns as its hull lets it, braking onto its heading: bosses.json turn)
    return { ...base, controls, firing: false, impulse: out.ix || out.iy ? [out.ix, out.iy] : undefined, body: out };
  }

  /** A decision: folded into its body's state now, and sent to the clients that run it (BrainHost.decide) */
  protected decide(op: number, args: readonly number[]): void {
    applyDecision(this.body, op, args, this.host.tick());
    this.host.decide?.(this.view.eid, op, args, this.body);
  }

  /** No target: the enemy AI flies it, not its body */
  private bodyOff(): void {
    if (this.body.on) this.decide(DECISION.OFF, []);
  }

  protected keepHome(x: number, y: number): [number, number] {
    const h = this.view.home, dx = x - h.x, dy = y - h.y, d = dhypot(dx, dy), R = this.flight.homeR;
    return d <= R ? [x, y] : [h.x + (dx / d) * R, h.y + (dy / d) * R];
  }

  // ---- Choosing ----

  /** A move picked: its rolls from a seed of its own (its MOVE decision: every client running its moves starts it too) */
  private started(name: string, m: Move, now: number): Move {
    const mv = this.mv, idx = mv.names.indexOf(name), seed = Math.floor(this.host.rng() * 256), rage = this.rage() < 1 ? 1 : 0;
    mv.rage = rage === 1;
    mv.begin(seed, now);
    this.moveAt = now;
    if (idx >= 0) this.decide(DECISION.MOVE, [idx, seed, rage]);
    return mv.around(m, name);
  }

  private pick(now: number): Move | null {
    if (this.devNext) {
      const name = this.devNext, m = this.make(name);
      this.devNext = null;
      if (m) {
        // (the loop goes on from it)
        const loop = this.tables.loop[this.stage - 1], at = loop.indexOf(name);
        if (at >= 0) this.step = at + 1;
        this.moveName = name;
        return this.started(name, m, now);
      }
    }
    const cut = this.interrupt(now);
    if (cut) { this.moveName = 'interrupt'; return cut; }
    const loop = this.tables.loop[this.stage - 1];
    for (let k = 0; k < loop.length; k++) {
      const name = loop[this.step++ % loop.length], m = this.make(name);
      if (m) { this.moveName = name; return this.started(name, m, now); }
    }
    return null;
  }

  // ---- Dev (game/dev/bossDev.ts) ----

  /** Its moves, every stage's (to play one next) */
  devMoves(): string[] {
    return [...new Set(this.tables.loop.flat())];
  }

  /** Its personal attacks (to force one) */
  devPersonal(): string[] {
    return [...new Set(['mark', ...(this.tables.personal?.pool.flat() ?? [])])];
  }

  /** This move next (the one under way stops), and the loop goes on from it */
  devPlay(name: string): void {
    this.devNext = name;
    this.move = null;
    this.restUntil = 0;
  }

  /** Shed to the start of stage n (from a fresh boss: forceShed's steps for every stage before it) */
  devToStage(n: number): void {
    if (!this.ship) return;
    const cat = this.host.ships.catalog, last = this.tables.loop.length;
    let steps = 0;
    for (let st = 1; st < Math.min(n, last + 1); st++) steps += this.outermostFirst(this.ofStage(st, (i) => deciding(cat, this.ship, i))).length + 1;
    this.forceShed(steps);
  }

  /** A window now: its stage's attack-phase window, or its signature's if it has one by this name, else the dev default */
  devWindow(name?: string): void {
    if (!this.view) return;
    const phase = this.tables.exposure?.[this.stage - 1];
    if (phase) { this.move = null; this.moveName = ''; this.expose(this.host.tick()); return; }
    const own = name ? this.tables.signature?.[name] : undefined;
    const spec: WindowSpec = own ?? Object.values(this.tables.signature ?? {})[0] ?? DEV_WINDOW;
    this.fight.open(spec, this.view.eid, this.view.systemNum, this.host.tick());
  }

  /** A personal attack on this pilot now (a PERSONAL decision, as a drawn one) */
  devPersonalOn(name: string, target: number): boolean {
    const now = this.host.tick(), seed = now & 0xffff;
    if (!this.fight.start(name, target, seed, now, this.mv)) return false;
    this.decide(DECISION.PERSONAL, [-1, 0, seed, target + 1, this.personalNames.indexOf(name)]);
    return true;
  }

  /** The stage it's fighting in */
  get stageNow(): number {
    return this.stage;
  }

  /** What share of a hit its windows let through now (BossBrain.windowShare) */
  windowShare(): number {
    return this.fight.share(this.host.tick());
  }

  /**
   * Damage it took (as taken, after armour): into its window. Filling the cap early cracks it: the bonus is dealt to
   * its sturdiest standing plate of its stage at once (divided by what it takes now, so the bonus lands whole)
   */
  landed(amount: number): void {
    if (!this.view || !this.ship) return;
    const now = this.host.tick(), bonus = this.fight.landed(amount, this.view.eid, this.view.systemNum, now);
    if (bonus <= 0) return;
    const plates = this.ofStage(this.stage, (i) => this.ship.derived.alive[i] && deciding(this.host.ships.catalog, this.ship, i));
    if (!plates.length) return;
    const best = plates.reduce((a, b) => (this.ship.hp[b] > this.ship.hp[a] ? b : a));
    this.host.ships.damagePartBy(this.view.eid, best, bonus / Math.max(0.05, this.fight.share(now) * this.taken()), -1);
  }

  protected rage(): number {
    return this.view.phase >= 4 ? RAGE : 1;
  }

  // ---- Its parts ----

  /** Parts of this function still on and working (a wreck does nothing) */
  protected working(fn: string): number[] {
    const ship = this.ship;
    return ship.blueprint.parts.flatMap((p, i) => (p.fn === fn && ship.derived.alive[i] && !isRuined(this.host.ships.catalog, ship, i) ? [i] : []));
  }

  /** Where a part's mount (or middle) is in the world, and the way it points */
  protected mount(i: number): { x: number; y: number; dir: number } {
    return partMount(this.host, this.view.eid, this.ship, i);
  }

  /** Pilots near it (within `r`), its target first */
  protected pilots(r = 5000): number[] {
    const eid = this.view.eid, t = this.target;
    const near = this.host.players(this.view.systemNum).filter((q) => q !== t && dhypot(Position.x[q] - Position.x[eid], Position.y[q] - Position.y[eid]) < r);
    return t >= 0 ? [t, ...near] : near;
  }

  // ---- Its stages ----

  protected ofStage(st: number, keep: (i: number) => boolean = () => true): number[] {
    return this.ship.blueprint.parts.flatMap((_, i) => (stageOf(this.host.ships.catalog, this.ship, i) === st && keep(i) ? [i] : []));
  }

  protected skeleton(i: number): boolean {
    return !!this.host.ships.catalog.pieces.get(this.ship.blueprint.parts[i].piece)?.skeleton;
  }

  /** Each side's pair together (by name, less its _l/_r), outermost (from its core) first, its core last */
  protected outermostFirst(parts: number[]): number[][] {
    const ship = this.ship, geo = this.host.ships.geometry(ship);
    const core = ship.blueprint.parts.findIndex((p) => p.fn === 'core'), c = geo[core]?.centroid ?? ship.derived.com;
    const groups = new Map<string, number[]>();
    for (const i of parts) { const k = ship.blueprint.parts[i].piece.replace(/_[lr]$/, ''); groups.set(k, [...(groups.get(k) ?? []), i]); }
    const last = (g: number[]) => (g.includes(core) ? 1 : 0);
    const far = (g: number[]) => Math.max(...g.flatMap((i) => geo[i].polygon.map(([x, y]) => dhypot(x - c[0], y - c[1]))));
    return [...groups.values()].sort((a, b) => last(a) - last(b) || far(b) - far(a));
  }

  integrity(): number {
    return this.ship ? stagedIntegrity(this.host.ships.catalog, this.ship) ?? 1 : 1;
  }

  invulnerable(): boolean {
    return this.blows.length > 0;
  }

  private shedding(now: number): void {
    if (this.blows.length) {
      while (this.blows.length && this.blows[0].at <= now) this.blows.shift()!.run();
      return;
    }
    const st = currentStage(this.host.ships.catalog, this.ship);
    const last = this.tables.loop.length;
    if (this.stage < last && st !== this.stage) this.blowStage(now);
    else if (this.stage === last && st !== last && !this.dying) this.die(now);
  }

  /** A stage beaten: whatever it was doing stops (its moves too, on every client running them: HOLD STOP) */
  protected stop(): void {
    this.move = null;
    this.moveName = '';
    this.fight.clear();
    this.step = 0;
    this.empty = 0;
    this.host.mobs?.clear(this.view.systemNum, this.view.eid);
    this.drones.clear();
    this.mv.stop();
    this.hold = MOVES_HOLD.STOP;
    this.decide(DECISION.HOLD, [MOVES_HOLD.STOP]);
    this.onStop();
  }

  /** Where a part is in the world */
  protected at(i: number): { x: number; y: number } {
    const g = this.host.ships.geometry(this.ship)[i].centroid, me = pose(this.view.eid), cs = this.host.ships.tuning.cellSize;
    const lx = (g[0] - this.ship.derived.com[0]) * cs, ly = (g[1] - this.ship.derived.com[1]) * cs, c = dcos(me.angle), s = dsin(me.angle);
    return { x: me.x + lx * c - ly * s, y: me.y + lx * s + ly * c };
  }

  protected boom(i: number, radius: number, kind = 'eruption'): void {
    const p = this.at(i);
    this.host.send(this.view.systemNum, { type: 'detonation', kind, x: Math.round(p.x), y: Math.round(p.y), radius });
  }

  /** Parts in eight groups by which way round its middle they lie (its core alone) */
  private sectors(parts: number[]): number[][] {
    const geo = this.host.ships.geometry(this.ship), c = this.ship.derived.com, out: number[][] = Array.from({ length: 9 }, () => []);
    for (const i of parts) {
      if (this.ship.blueprint.parts[i].fn === 'core') { out[8].push(i); continue; }
      const [x, y] = geo[i].centroid, a = datan2(y - c[1], x - c[0]);
      out[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 8) % 8].push(i);
    }
    return out.filter((g) => g.length);
  }

  /** Shed what's left of these (as built: it isn't damage); flung out from its middle (`whole`: together), crumbling within `crumble` ticks */
  protected drop(parts: number[], fling = 0, whole = false, crumble = 0, clusters = false): void {
    // (Not what's gone already this tick, ahead of its rebuild: bridge/rebuild.ts)
    const live = parts.filter((i) => this.ship.derived.alive[i] && !this.ship.detached[i]);
    if (!live.length) return;
    // (all of it only to be seen: a boss's debris is scenery, not more bodies in the fight; `clusters`: a few great chunks by where they lie)
    const groups = clusters ? this.sectors(live) : fling && !whole ? live.map((i) => [i]) : [live];
    this.host.ships.shed(this.view.eid, groups, fling, crumble, true);
    const s = this.host.ships.get(this.view.eid);
    if (s) this.ship = s;
  }

  /**
   * The stage it's fighting beaten: it stops (nothing hurts it) and blows that stage away. Stage one with a skeleton:
   * what was under each plate, one after another, outermost first (bossBlow), then the lot; otherwise piece by piece,
   * outermost first, its core last
   */
  protected blowStage(now: number): void {
    const st = this.stage;
    this.stage = st + 1;
    this.stop();
    let t = now + BLOW_PAUSE;
    const parts = this.ofStage(st), skel = parts.filter((i) => this.skeleton(i));
    if (skel.length) {
      const geo = this.host.ships.geometry(this.ship);
      const over = parts.filter((i) => !this.skeleton(i) && skel.some((k) => geo[k].convex.some((c) => pointInConvex(c, geo[i].centroid[0], geo[i].centroid[1]))));
      for (const i of this.outermostFirst(over).flat()) {
        this.blows.push({ at: t, run: () => { this.host.send(this.view.systemNum, { type: 'bossBlow', bodyId: this.view.eid, part: i }); this.boom(i, 220); } });
        t += BLOW_GAP;
      }
      this.blows.push({ at: t, run: () => { for (const k of skel) this.boom(k, 520); this.drop(this.ofStage(st), BLOW_FLING, true, BLOW_CRUMBLE); } });
    } else {
      for (const g of this.outermostFirst(parts)) {
        this.blows.push({ at: t, run: () => { this.boom(g[0], g.length > 1 ? 300 : 220); this.drop(g, BLOW_FLING, true, BLOW_CRUMBLE); } });
        t += BLOW_GAP;
      }
    }
    this.blows.push({ at: t + BLOW_PAUSE, run: () => {} });
  }

  /** Its last stage's deciding pieces all wrecked: it shudders (nothing hurts it), bursts flickering across it, then every piece blows apart at once */
  protected die(now: number): void {
    this.dying = true;
    this.stop();
    const round = this.ofStage(this.stage).filter((i) => deciding(this.host.ships.catalog, this.ship, i));
    for (let t = 6; t < DEATH_SHUDDER; t += 6) {
      const i = round[Math.floor(this.host.rng() * round.length)];
      this.blows.push({ at: now + t, run: () => { if (this.ship.derived.alive[i]) this.boom(i, 120 + t * 2); } });
    }
    this.blows.push({ at: now + DEATH_SHUDDER, run: () => this.burst() });
  }

  /** Every piece blows apart at once (its core with them: it's destroyed) */
  protected burst(): void {
    const all = this.ship.blueprint.parts.flatMap((_, i) => (this.ship.derived.alive[i] ? [i] : []));
    const core = this.ship.blueprint.parts.findIndex((p) => p.fn === 'core');
    if (core >= 0 && this.ship.derived.alive[core]) this.boom(core, 1100);
    for (const i of all) if (deciding(this.host.ships.catalog, this.ship, i) && this.host.rng() < 0.5) this.boom(i, 260);
    this.drop(all, DEATH_FLING, false, DEATH_CRUMBLE, true);
  }

  /** What it takes of a hit (braced, laid open): all of it, unless a boss says otherwise */
  taken(): number {
    return 1;
  }

  /**
   * (dev) Its fight moved on `n` steps at once: its first stage's plates shot off one group at a time (outermost
   * first), then that stage blown away; each later stage's deciding pieces wrecked a group at a time (a stage without
   * `ruin` pieces: shot off), then blown away; its last stage, then it blows apart. (Stop just short of a stage's end
   * and the next tick it blows that stage away itself, as in a fight)
   */
  forceShed(n: number): void {
    if (!this.ship) return;
    const cat = this.host.ships.catalog, last = this.tables.loop.length, steps: (() => void)[] = [];
    for (let st = 1; st <= last; st++) {
      const groups = this.outermostFirst(this.ofStage(st, (i) => deciding(cat, this.ship, i)));
      for (const g of groups) steps.push(() => {
        const ruin = g.some((i) => cat.pieces.get(this.ship.blueprint.parts[i].piece)?.ruin);
        if (ruin) { for (const i of g) if (this.ship.hp[i] > RUIN_HP) { this.ship.hp[i] = RUIN_HP; this.ship.dirty = true; } }
        else this.drop(g, 0, false, BLOW_CRUMBLE);
      });
      const s = st;
      steps.push(s < last
        ? () => { this.stage = s + 1; this.stop(); this.drop(this.ofStage(s), BLOW_FLING, true, BLOW_CRUMBLE); }
        : () => { this.dying = true; this.stop(); this.burst(); });
    }
    this.blows = [];
    // (Each step as if a tick apart: what it changed rebuilt before the next looks)
    for (; this.forced < Math.min(n, steps.length); this.forced++) { steps[this.forced](); this.host.ships.settle(this.view.eid); }
  }
}
