/**
 * A staged boss's brain (docs/boss-design.md): what every one shares, so a new boss only writes its moves.
 *
 *   its loop     each stage a fixed loop of moves (`loop`), gone through in order, a move it can't do skipped; a
 *                move is a generator setting `want` each tick (`make` builds it by name)
 *   flying       between moves it circles its target at its stage's range (`range`, `circle`), held to its ground;
 *                lighter stages drive harder (`drive`); it turns as its hull lets it, braking onto its heading (bosses.json `turn`)
 *   its stages   its pieces' `stage` (stages.ts): when the one it's fighting with has nothing deciding left standing,
 *                it stops everything (`stop`), can't be hurt, holds still, and blows that stage away piece by piece
 *                (`blowStage`); its last stage beaten, it shudders and every piece blows apart at once (`die`)
 *   dev          `forceShed` steps through its stages' looks: shot off, wrecked, blown away
 */

import {
  Position, Velocity, Rotation, ShipState, rayTerrain, currentStage, deciding, isRuined, pointInConvex, stageOf, stagedIntegrity, RUIN_HP, datan2, dcos, dhypot, dsin,
  CTL, DECISION, WANT, BODY_KINDS, applyDecision, sameWant, stagedFlight, syncArgs, wantAim, wantDrive, wantFly, wantHold, dequantizeCursorAngle,
  type BodyState, type StagedFlightTables, type WantRec,
} from '@space-game/common';
import type { PilotOrders } from '../../ships/ShipBridge.js';
import { BossBrain, BossView, BrainHost, lead, partMount, pose, strike, wrap } from './kit.js';

export type Move = Generator<void, void, void>;

/**
 * What a move wants of the ship this tick (common bodies/decisions.ts WANT: fly, hold, hold facing its target or a
 * heading or where its target is going, drive a way with a kick). Its body flies the ship from it, on the server and on
 * the clients that run it alike (common bodies/stagedFlight.ts): a want that changes is a decision sent them
 */
export type Want = WantRec;

/** A staged boss's shape of fight: its tables, by stage (index 0 its first); its flight is its body's (common bodies/registry.ts) */
export interface StagedTables {
  /** Its moves in the order it goes through them */
  loop: string[][];
  /** Ticks of rest between moves */
  rest: number[];
  /** Warnings × this */
  haste: number[];
}

/** Between stages: ticks it holds still before (and after) blowing a stage away, and between each blast */
const BLOW_PAUSE = 45, BLOW_GAP = 6;
/** Blowing a stage away: how hard its pieces drift clear, within how long they crumble (no cover left lying about) */
const BLOW_FLING = 3, BLOW_CRUMBLE = 200;
/** Dying: ticks it shudders before it blows apart, how hard its chunks are thrown, and how long they last before they crumble */
const DEATH_SHUDDER = 75, DEATH_FLING = 13, DEATH_CRUMBLE = 300;
/** Enraged (its last phase): rests and warnings × this */
const RAGE = 0.8;

export abstract class StagedBrain implements BossBrain {
  protected view!: BossView;
  protected ship!: ShipState;
  protected target = -1;
  protected want: Want = wantFly();
  protected move: Move | null = null;
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
  /** Its flight (its body's: range, circle, drive and ground by stage) */
  protected readonly flight: StagedFlightTables;
  /** Its body's state as its decisions have left it (the clients that run its body fold the same decisions in) */
  readonly body: BodyState;

  constructor(protected host: BrainHost, protected tables: StagedTables, brain: string) {
    const kind = Math.max(0, BODY_KINDS.findIndex((k) => k.brain === brain));
    this.flight = BODY_KINDS[kind].flight;
    this.body = { kind, homeX: 0, homeY: 0, stage: 1, side: 1, target: -1, want: wantFly(), wantAt: 0, on: false };
  }

  /** A move by name, or null if it can't do it now (its part is gone) */
  protected abstract make(id: string): Move | null;
  /** Every tick it's fighting (between moves too): its passive attacks */
  protected passives(_now: number): void {}
  /** A move that cuts in ahead of its loop (a punish), or null */
  protected interrupt(_now: number): Move | null { return null; }
  /** Wrapped round each move of a stage (stage three's darts) */
  protected around(m: Move): Move { return m; }
  /** Its stages beaten: hooks to stop what its moves leave running */
  protected onStop(): void {}

  orders(base: PilotOrders | null, ship: ShipState, view: BossView): PilotOrders | null {
    this.view = view;
    this.ship = ship;
    const now = this.host.tick();
    const t = base?.target ?? -1;
    this.target = t;
    this.want = wantFly();
    this.shedding(now);
    // (blown apart: nothing left to fly)
    if (!this.host.ships.get(view.eid)) return null;
    if (this.blows.length && base) {
      this.move = null;
      this.want = wantHold();
      if (t >= 0) return this.fly(base, t);
      this.bodyOff();
      return { ...base, firing: false };
    }
    if (t < 0) { this.move = null; this.bodyOff(); return base; }
    if (!this.move && now >= this.restUntil) this.move = this.pick(now);
    this.passives(now);
    if (this.move && this.move.next().done) {
      this.move = null;
      this.restUntil = now + Math.round(this.tables.rest[this.stage - 1] * this.rage() / (1 + 0.15 * (view.fighters - 1)));
    }
    return this.fly(base!, t);
  }

  idle(): boolean {
    return !this.move && !this.blows.length && !this.dying;
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
  private decide(op: number, args: readonly number[]): void {
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

  protected fromHome(x: number, y: number): number {
    return dhypot(x - this.view.home.x, y - this.view.home.y);
  }

  /** A unit way to go, bent back in if `reach` along it would take it off its ground */
  protected homeward(vx: number, vy: number, reach: number): [number, number] {
    const me = pose(this.view.eid);
    if (this.fromHome(me.x + vx * reach, me.y + vy * reach) <= this.flight.homeR) return [vx, vy];
    const hx = this.view.home.x - me.x, hy = this.view.home.y - me.y, hl = dhypot(hx, hy) || 1;
    const bx = vx * 0.3 + (hx / hl) * 0.9, by = vy * 0.3 + (hy / hl) * 0.9, bl = dhypot(bx, by) || 1;
    return [bx / bl, by / bl];
  }

  /** Hold still, turning to face its target, for `ticks` */
  protected *hold(ticks: number): Move {
    for (let i = 0; i < ticks; i++) {
      this.want = this.target >= 0 ? wantAim() : wantHold();
      yield;
    }
  }

  /** A short, quick burst to a new angle on its target, warned by a streak */
  protected *dart(reach = 1000, speed = 20, warnTicks = 24): Move {
    const t = this.target, me = pose(this.view.eid);
    if (t < 0) return;
    const dx = Position.x[t] - me.x, dy = Position.y[t] - me.y, d = dhypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, side = this.host.rng() < 0.5 ? 1 : -1;
    const range = this.flight.range[this.stage - 1], radial = Math.max(-0.7, Math.min(0.7, (d - range) / range));
    const l0 = dhypot(-uy * side + ux * radial, ux * side + uy * radial) || 1;
    const [vx, vy] = this.homeward((-uy * side + ux * radial) / l0, (ux * side + uy * radial) / l0, reach);
    const wind = this.haste(warnTicks);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'dash', bodyId: this.view.eid, x: 0, y: 0, angle: wrap(datan2(vy, vx) - me.angle), length: reach, width: 140, ticks: wind });
    for (let i = 0; i < wind; i++) { this.want = wantHold(); yield; }
    const dir = datan2(vy, vx);
    this.want = wantDrive(dir, undefined, speed);
    yield;
    for (let i = 0; i < 14; i++) { this.want = wantDrive(dir); yield; }
  }

  // ---- Choosing ----

  private pick(now: number): Move | null {
    const cut = this.interrupt(now);
    if (cut) return cut;
    const loop = this.tables.loop[this.stage - 1];
    for (let k = 0; k < loop.length; k++) {
      const m = this.make(loop[this.step++ % loop.length]);
      if (m) return this.around(m);
    }
    return null;
  }

  protected rage(): number {
    return this.view.phase >= 4 ? RAGE : 1;
  }

  protected haste(ticks: number): number {
    return Math.round(ticks * this.tables.haste[this.stage - 1] * this.rage());
  }

  // ---- Its parts ----

  /** Parts of this function still on and working (a wreck does nothing) */
  protected working(fn: string): number[] {
    const ship = this.ship;
    return ship.blueprint.parts.flatMap((p, i) => (p.fn === fn && ship.derived.alive[i] && !isRuined(this.host.ships.catalog, ship, i) ? [i] : []));
  }

  /** A part by its piece's name (bespoke id), if it's still on and working, else -1 */
  protected named(piece: string): number {
    const i = this.ship.blueprint.parts.findIndex((p) => p.piece === piece);
    return i >= 0 && this.ship.derived.alive[i] && !isRuined(this.host.ships.catalog, this.ship, i) ? i : -1;
  }

  /** Where a part's mount (or middle) is in the world, and the way it points */
  protected mount(i: number): { x: number; y: number; dir: number } {
    return partMount(this.host, this.view.eid, this.ship, i);
  }

  /** Parts in clockwise order round its middle (as seen: y down), from its nose */
  protected clockwise(parts: number[]): number[] {
    const geo = this.host.ships.geometry(this.ship), c = this.ship.derived.com;
    const turn = (i: number) => { const [x, y] = geo[i].centroid; return (datan2(y - c[1], x - c[0]) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI); };
    return [...parts].sort((a, b) => turn(a) - turn(b));
  }

  /** Pilots near it (within `r`), its target first */
  protected pilots(r = 5000): number[] {
    const eid = this.view.eid, t = this.target;
    const near = this.host.players(this.view.systemNum).filter((q) => q !== t && dhypot(Position.x[q] - Position.x[eid], Position.y[q] - Position.y[eid]) < r);
    return t >= 0 ? [t, ...near] : near;
  }

  // ---- Hurting ----

  /** Shells (or strikes) due now come down: `kind` the detonation clients see ('': none, a lingering hurt) */
  protected land(due: { x: number; y: number; at: number }[], radius: number, damage: number, kind = 'eruption'): void {
    const n = this.host.tick();
    for (let i = due.length - 1; i >= 0; i--) {
      if (n < due[i].at) continue;
      const { x, y } = due[i];
      due.splice(i, 1);
      strike(this.host, this.view.systemNum, x, y, radius, damage * this.view.damage, this.view.eid);
      if (kind) this.host.send(this.view.systemNum, { type: 'detonation', kind, x: Math.round(x), y: Math.round(y), radius });
    }
  }

  /** A beam's burn this tick from a point on the body (its own frame) at an angle off its heading; it stops at rock */
  protected beam(at: { x: number; y: number }, rel: number, length: number, width: number, damage: number): void {
    const me = pose(this.view.eid), a = me.angle + rel;
    const c = dcos(me.angle), s = dsin(me.angle);
    const x0 = me.x + at.x * c - at.y * s, y0 = me.y + at.x * s + at.y * c;
    const reach = length * rayTerrain(this.host.terrain?.(this.view.systemNum), x0, y0, x0 + dcos(a) * length, y0 + dsin(a) * length);
    const x1 = x0 + dcos(a) * reach, y1 = y0 + dsin(a) * reach, ships = this.host.ships;
    for (const p of this.host.players(this.view.systemNum)) {
      const sh = ships.get(p);
      if (!sh) continue;
      const h = ships.segmentHit(p, sh, x0, y0, x1, y1, width / 2);
      if (h) ships.damagePartBy(p, h.part, damage * this.view.damage, this.view.eid, { type: 'thermal', pen: 1.5 });
    }
  }

  /** Every pilot within `reach` of a point catches fire */
  protected scorch(x: number, y: number, reach: number, dps: number): void {
    for (const q of this.host.players(this.view.systemNum)) {
      if (dhypot(Position.x[q] - x, Position.y[q] - y) > reach) continue;
      const part = this.host.ships.ignite(q, x, y, dps * this.view.damage, 150, 1.2, this.view.eid);
      if (part >= 0) this.host.send(this.view.systemNum, { type: 'ignite', bodyId: q, part, ticks: 150 });
    }
  }

  /** Pull every pilot within `r` of a point towards it (`k` world units a tick at its middle, none at the edge) */
  protected pull(x: number, y: number, r: number, k: number): void {
    for (const q of this.host.players(this.view.systemNum)) {
      const dx = x - Position.x[q], dy = y - Position.y[q], d = dhypot(dx, dy);
      if (d > r || d < 1) continue;
      const f = k * (1 - d / r);
      // (Through the bridge: a pilot's client is told the push, TEMPORARY until boss decisions are inputs: ShipBridge.push)
      this.host.ships.push(q, (dx / d) * f, (dy / d) * f);
    }
  }

  /** Aimed at where a pilot will be when a shot `speed` fast gets there */
  protected aimAt(t: number, x: number, y: number, speed: number): number {
    const at = lead(t, dhypot(Position.x[t] - x, Position.y[t] - y) / speed);
    return datan2(at.y - y, at.x - x);
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

  /** A stage beaten: whatever it was doing stops */
  protected stop(): void {
    this.move = null;
    this.step = 0;
    this.host.mobs?.clear(this.view.systemNum, this.view.eid);
    this.drones.clear();
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
