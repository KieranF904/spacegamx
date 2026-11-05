/**
 * A staged boss's moves, the same on both sides (decision-inputs stage 4; the brain that picks them is the server's:
 * server/src/game/brains/staged.ts). A move is a generator stepped once a tick from the tick its MOVE decision took
 * effect; it sets `want` (its flight: on the server a WANT decision, as before) and draws, shoots and strikes through
 * its host (moves/host.ts). What outlives a move (rivets due down a gun line, pools, shells swelling) is kept here and
 * worked by `passives` each tick, each with the decision it came of.
 *
 * Per tick, in the server's order (the brain's `orders`; a client's MoveRunner keeps it):
 *   a MOVE starts its move (begin, make), passives, a HARASS shot, the move steps, PERSONAL attacks start, then every
 *   personal attack steps (newest first)
 */
import { datan2, dcos, dhypot, dsin } from '../../math/detTrig.js';
import { rayTerrain } from '../../terrain.js';
import { isRuined } from '../../ships/stages.js';
import { shipPointToWorld } from '../../ships/shot.js';
import { localToWorldDir } from '../../ships/flight.js';
import { EffectType } from '../../network/protocol.js';
import { wantAim, wantDrive, wantFly, wantHold, type WantRec } from '../decisions.js';
import type { StagedFlightTables } from '../stagedFlight.js';
import { moveRng, PART_STATE, type MoveHost, type MovePose, type MoveHurt } from './host.js';

export type Move = Generator<void, void, void>;

export const wrapTurn = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

const NOBODY: MovePose = { x: 0, y: 0, angle: 0, vx: 0, vy: 0 };

/** A personal attack running: its name, on whom, its move, the tick it was drawn and the tick its time is up */
export interface PersonalRun { name: string; target: number; move: Move; at: number; until: number }

export abstract class StagedMoves {
  /** What its move wants of the ship this tick */
  want: WantRec = wantFly();
  /** Its target, stage and side as its body has them this tick (the brain's, on the server) */
  target = -1;
  stage = 1;
  /** Enraged (its last phase) as its move's decision said: warnings × RAGE */
  rage = false;
  /** Its ground (its body's home) */
  homeX = 0;
  homeY = 0;
  /** Which way round it circles (a dash flips it: the brain's own side, on the server) */
  side: 1 | -1 = 1;
  /** Its arena's pilots, in slot order (the server's: its swarm is shared among them) */
  present: readonly number[] | undefined;
  /** Personal attacks running, in the order they were drawn */
  runs: PersonalRun[] = [];
  /** Its move's rolls (moveRng of its decision's seed) */
  protected rnd: () => number = () => 0;

  constructor(readonly h: MoveHost, readonly eid: number, readonly flight: StagedFlightTables, readonly haste0: readonly number[]) {}

  /** Its moves by name, in its MOVE table's order (a MOVE's first arg is the index) */
  abstract readonly names: readonly string[];
  /** A move by name, or null if it can't now (its part is gone) */
  abstract make(name: string): Move | null;
  /** Every tick it's fighting: what its moves left running */
  passives(_now: number): void {}
  /** One harassing shot at a pilot: false if it can't now */
  harassShot(_t: number): boolean { return false; }
  /** Its stages beaten (or a stop): what its moves left running goes */
  onStop(): void {}
  /** Wrapped round a move (a dart first) */
  around(m: Move, _name: string): Move { return m; }

  /** A MOVE: its rolls from here come from its seed */
  begin(seed: number, tick: number): void {
    this.rnd = moveRng(seed, tick);
  }

  /** Everything stops (its stage beaten, it's dying): personal attacks and what its moves left */
  stop(): void {
    this.runs = [];
    this.onStop();
  }

  /** A personal attack by name on a pilot, or null if it can't now. Every boss has 'mark' */
  personalMove(name: string, target: number, seed: number): Move | null {
    return name === 'mark' ? this.mark(target, seed) : null;
  }

  /** A personal attack starts (drawn at `at`, running `ticks` at most): false if it can't */
  startPersonal(name: string, target: number, seed: number, at: number, ticks: number): boolean {
    const o = this.h.origin;
    this.h.origin = { t: at, who: target };
    const move = this.personalMove(name, target, seed);
    this.h.origin = o;
    if (!move) return false;
    this.runs.push({ name, target, move, at, until: at + ticks });
    return true;
  }

  /** Every personal attack running steps once (newest first; `cause` told which, for the dev damage log) */
  stepPersonal(cause?: (r: PersonalRun | null) => void): void {
    const o = this.h.origin;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      const r = this.runs[i];
      cause?.(r);
      this.h.origin = { t: r.at, who: r.target };
      if (r.move.next().done) this.runs.splice(i, 1);
    }
    this.h.origin = o;
    cause?.(null);
  }

  /** Drop personal attacks whose time is up (bosses/personal.ts pruneDraws): how many still run */
  pruneRuns(now: number): number {
    this.runs = this.runs.filter((r) => now < r.until);
    return this.runs.length;
  }

  // ---- What it reads ----

  protected me(): MovePose {
    return this.h.me();
  }

  /** A pilot as its step reads it */
  protected at(id: number): MovePose {
    return this.h.pose(id) ?? NOBODY;
  }

  protected get ship() {
    return this.h.ship();
  }

  /** Is this part on (the structure at the tick: a client's from PART decisions, PART_STATE) */
  protected alive(i: number): boolean {
    const s = this.h.part?.(i);
    return s === undefined ? !!this.ship.derived.alive[i] : (s & PART_STATE.GONE) === 0;
  }

  /** Is this part a wreck (a ruin piece worn out) */
  protected ruined(i: number): boolean {
    const s = this.h.part?.(i);
    return s === undefined ? isRuined(this.h.catalog, this.ship, i) : (s & PART_STATE.RUINED) !== 0;
  }

  /** Parts of this function still on and working (a wreck does nothing) */
  protected working(fn: string): number[] {
    const ship = this.ship, cat = this.h.catalog;
    return ship.blueprint.parts.flatMap((p, i) => (p.fn === fn && this.alive(i) && !this.ruined(i) ? [i] : []));
  }

  /** A part by its piece's name, if it's still on and working, else -1 */
  protected named(piece: string): number {
    const ship = this.ship, i = ship.blueprint.parts.findIndex((p) => p.piece === piece);
    return i >= 0 && this.alive(i) && !this.ruined(i) ? i : -1;
  }

  /** A part's mount (or its middle) in the world, and the way it points */
  protected mount(part: number): { x: number; y: number; dir: number } {
    const ship = this.ship, g = this.h.geometry(ship)[part];
    const at = g.mount?.at ?? g.centroid, d = g.mount?.dir ?? [0, -1];
    const p = this.me();
    const [x, y] = shipPointToWorld(ship, p, at, this.h.cellSize);
    const [dx, dy] = localToWorldDir(d, p.angle);
    return { x, y, dir: datan2(dy, dx) };
  }

  /** A point on the body in its own frame (world units, nose along +x): what telegraphs and beams ride on */
  protected bodyFrame(part: number): { x: number; y: number } {
    const m = this.mount(part), p = this.me();
    const dx = m.x - p.x, dy = m.y - p.y, c = dcos(-p.angle), s = dsin(-p.angle);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  /** Parts in clockwise order round its middle (as seen: y down), from its nose */
  protected clockwise(parts: number[]): number[] {
    const geo = this.h.geometry(this.ship), c = this.ship.derived.com;
    const turn = (i: number) => { const [x, y] = geo[i].centroid; return (datan2(y - c[1], x - c[0]) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI); };
    return [...parts].sort((a, b) => turn(a) - turn(b));
  }

  /** Pilots near it (within `r`), its target first (the server's: only it knows every pilot) */
  protected pilots(r = 5000): number[] {
    const w = this.h.work;
    if (!w) return this.target >= 0 ? [this.target] : [];
    const me = this.me(), t = this.target;
    const near = w.players().filter((q) => { if (q === t) return false; const p = this.at(q); return dhypot(p.x - me.x, p.y - me.y) < r; });
    return t >= 0 ? [t, ...near] : near;
  }

  protected haste(ticks: number): number {
    return Math.round(ticks * this.haste0[this.stage - 1] * (this.rage ? 0.8 : 1));
  }

  protected fromHome(x: number, y: number): number {
    return dhypot(x - this.homeX, y - this.homeY);
  }

  /** A unit way to go, bent back in if `reach` along it would take it off its ground */
  protected homeward(vx: number, vy: number, reach: number): [number, number] {
    const me = this.me();
    if (this.fromHome(me.x + vx * reach, me.y + vy * reach) <= this.flight.homeR) return [vx, vy];
    const hx = this.homeX - me.x, hy = this.homeY - me.y, hl = dhypot(hx, hy) || 1;
    const bx = vx * 0.3 + (hx / hl) * 0.9, by = vy * 0.3 + (hy / hl) * 0.9, bl = dhypot(bx, by) || 1;
    return [bx / bl, by / bl];
  }

  // ---- What it does ----

  /** A glow on a part (`kind`: its colour, BossFx) for `ticks` */
  protected glow(part: number, kind: string, ticks: number, radius = 220): void {
    if (part < 0) return;
    const at = this.bodyFrame(part);
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind, bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius, ticks });
  }

  /** A flash where something comes out of its hull */
  protected launchFx(x: number, y: number): void {
    this.h.fx({ type: 'effect', effectType: EffectType.WarpOut, x: Math.round(x), y: Math.round(y), data: [0] });
  }

  /** A straight shell (`scale`: × its damage scale) */
  protected fire(kind: string, x: number, y: number, a: number, scale: number, speed?: number): void {
    this.h.shoot({ kind, x, y, angle: a, scale: scale * (this.h.work?.damageScale ?? 1), speed });
  }

  /** Strikes due now come down: `kind` the detonation clients see ('': none, a lingering hurt) */
  protected land(due: { x: number; y: number; at: number }[], radius: number, damage: number, kind = 'eruption'): void {
    const n = this.h.tick(), w = this.h.work;
    for (let i = due.length - 1; i >= 0; i--) {
      if (n < due[i].at) continue;
      const { x, y } = due[i];
      due.splice(i, 1);
      w?.splash(x, y, radius, damage * w.damageScale);
      if (kind) this.h.fx({ type: 'detonation', kind, x: Math.round(x), y: Math.round(y), radius });
    }
  }

  /** A beam's burn this tick from a point on the body (its own frame) at an angle off its heading; it stops at rock */
  protected beam(at: { x: number; y: number }, rel: number, length: number, width: number, damage: number): void {
    const w = this.h.work;
    if (!w) return;
    const me = this.me(), a = me.angle + rel, c = dcos(me.angle), s = dsin(me.angle);
    const x0 = me.x + at.x * c - at.y * s, y0 = me.y + at.x * s + at.y * c;
    const reach = length * rayTerrain(this.h.terrain(), x0, y0, x0 + dcos(a) * length, y0 + dsin(a) * length);
    const x1 = x0 + dcos(a) * reach, y1 = y0 + dsin(a) * reach;
    for (const p of w.players()) {
      const part = w.segmentHit(p, x0, y0, x1, y1, width / 2);
      if (part >= 0) w.damage(p, part, damage * w.damageScale, { type: 'thermal', pen: 1.5 });
    }
  }

  /** Hurt the first part a segment crosses on each pilot not yet struck (`struck` kept): the ones struck now */
  protected cut(x0: number, y0: number, x1: number, y1: number, half: number, damage: number, how: MoveHurt, struck: Set<number>, near?: (q: MovePose) => boolean): number[] {
    const w = this.h.work, out: number[] = [];
    if (!w) return out;
    for (const q of w.players()) {
      if (struck.has(q) || (near && !near(this.at(q)))) continue;
      const part = w.segmentHit(q, x0, y0, x1, y1, half);
      if (part < 0) continue;
      struck.add(q);
      w.damage(q, part, damage * w.damageScale, how);
      out.push(q);
    }
    return out;
  }

  /** Rock (or an arena's barrier) between a point and a pilot: pulls and burns don't reach through it */
  protected walled(x: number, y: number, q: number): boolean {
    const t = this.h.terrain(), p = this.at(q);
    return !!t && rayTerrain(t, x, y, p.x, p.y) < 1;
  }

  /** A pull on one pilot towards a point (`k` a tick at its middle, none at `r`), not through rock (the server's) */
  protected pullOne(q: number, x: number, y: number, r: number, k: number): void {
    const p = this.at(q), dx = x - p.x, dy = y - p.y, d = dhypot(dx, dy);
    if (d > r || d < 1 || this.walled(x, y, q)) return;
    const f = k * (1 - d / r);
    this.h.work?.push(q, (dx / d) * f, (dy / d) * f);
  }

  // ---- Shared moves ----

  /** Hold still, turning to face its target, for `ticks` */
  protected *hold(ticks: number): Move {
    for (let i = 0; i < ticks; i++) {
      this.want = this.target >= 0 ? wantAim() : wantHold();
      yield;
    }
  }

  /** A short, quick burst to a new angle on its target, warned by a streak (its side from its move's seed) */
  protected *dart(reach = 1000, speed = 20, warnTicks = 24): Move {
    const t = this.target, me = this.me();
    if (t < 0) return;
    const tp = this.at(t), dx = tp.x - me.x, dy = tp.y - me.y, d = dhypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, side = this.rnd() < 0.5 ? 1 : -1;
    const range = this.flight.range[this.stage - 1], radial = Math.max(-0.7, Math.min(0.7, (d - range) / range));
    const l0 = dhypot(-uy * side + ux * radial, ux * side + uy * radial) || 1;
    const [vx, vy] = this.homeward((-uy * side + ux * radial) / l0, (ux * side + uy * radial) / l0, reach);
    const wind = this.haste(warnTicks);
    this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'dash', bodyId: this.eid, x: 0, y: 0, angle: wrapTurn(datan2(vy, vx) - me.angle), length: reach, width: 140, ticks: wind });
    for (let i = 0; i < wind; i++) { this.want = wantHold(); yield; }
    const dir = datan2(vy, vx);
    this.want = wantDrive(dir, undefined, speed);
    yield;
    for (let i = 0; i < 14; i++) { this.want = wantDrive(dir); yield; }
  }

  /** The plain personal attack: a faint ring under a pilot, then a strike there (move off it) */
  protected *mark(target: number, seed: number): Move {
    const warn = 84, radius = 260 + (seed % 40), p = this.at(target);
    const x = p.x + p.vx * 20, y = p.y + p.vy * 20;
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'impact', x: Math.round(x), y: Math.round(y), radius, ticks: warn });
    for (let i = 0; i < warn; i++) yield;
    this.land([{ x, y, at: this.h.tick() }], radius, 60);
  }

  /** Aimed at where a pilot will be when a shot `speed` fast gets there */
  protected aimAt(t: number, x: number, y: number, speed: number): number {
    const p = this.at(t), k = dhypot(p.x - x, p.y - y) / speed;
    return datan2(p.y + p.vy * k - y, p.x + p.vx * k - x);
  }
}
