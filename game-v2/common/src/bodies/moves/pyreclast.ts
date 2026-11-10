/**
 * The Pyreclast's moves (its brain, which picks them and works its vents' heat, is the server's:
 * server/src/game/brains/pyreclast.ts, where its fight is described). The same on both sides: the server runs them for
 * real, a client running its body draws their tells and straight shots from its MOVE, HARASS and PERSONAL decisions.
 */
import { MOB_IDS } from '../../constants.js';
import { datan2, dcos, dhypot, dsin } from '../../math/detTrig.js';
import { wantAim, wantDrive, wantFace, wantFly, wantHold } from '../decisions.js';
import type { StagedFlightTables } from '../stagedFlight.js';
import type { MoveHost, MoveOrigin } from './host.js';
import { StagedMoves, wrapTurn as wrap, type Move } from './staged.js';

const P = (name: string) => `pyreclast_${name}`;

/** Its moves (a MOVE's index) and its personal attacks (a PERSONAL's name index) */
export const PYRECLAST_MOVES = ['barrage', 'broadside', 'scythe', 'mortar', 'dash', 'lance', 'crystal', 'ring', 'swarm', 'vent'] as const;
export const PYRECLAST_PERSONAL_NAMES = ['mark', 'lob', 'ember', 'flak', 'synapse', 'spark'] as const;
/** Personal attacks by stage (docs 5.4): a quarter chance a beat each */
export const PYRECLAST_PERSONAL = { beat: 120, chance: 0.25, ticks: 240, pool: [['lob', 'ember', 'flak'], ['lob', 'synapse'], ['spark', 'lob']] };
/** Heat reaches this far round a vent (its look's radius) */
export const PYRECLAST_HEAT_REACH = 700;
/** Its vent window's length (its heart's: the vent move's look lasts its tell and the window) */
export const PYRECLAST_VENT_TICKS = 360;

/** What each attack bites (x the boss's damage scale): a shot's (x its kind's damage), a strike's or a beam's a tick */
const BITE = {
  barrage: 3, broadside: 4, scythe: 450, mortar: 300, lance: 24, crystal: 18, ring: 2.5, swarm: 2.6,
  lob: 430, lobPool: 18, ember: 4, flak: 160, synapse: 260, spark: 3,
};
/** The scythe's reach off its hull: inside the first it can't reach you */
const SCYTHE_NEAR = 900, SCYTHE_FAR = 3400;
/** Between its scythe's pass and its pass back (ticks) */
const SCYTHE_BEAT = 20;
/** Its heart's harassing spark: the glint's warning (ticks) */
const GLINT = 40;
/** Turning side-on (a broadside, a scythe, a ring pulse) takes at most this long (ticks) */
const ROLL = 150, ROLL_EVERY = 8;
/** The crystal's beams in order (x BEAM_STEP radians off its heading) */
const BEAMS = [0, -1, 1, -2, 2, -3, 3], BEAM_STEP = 0.3;
/** Its ring pulse: how many rings, how far apart (ticks), how far it turns between (its sparks: tuning.json heart_spark, 20 a tick out to the walls) */
const RINGS = 5, RING_EVERY = 32, RING_TURN = 0.12;

type Due = { x: number; y: number; at: number };

export class PyreclastMoves extends StagedMoves {
  readonly names = PYRECLAST_MOVES;
  /** Turrets' magma swelling, then hurled (at where the target is then: never ahead) */
  private swelling: { part: number; at: number; fan: number; bite: number; aim: number; o: MoveOrigin }[] = [];
  /** Its harassing sparks due (from the part that glinted, at where its pilot was then) */
  private glints: { part: number; x: number; y: number; at: number; o: MoveOrigin }[] = [];
  /** Ground left burning by magma lobs */
  private pools: { x: number; y: number; next: number; until: number }[] = [];

  constructor(h: MoveHost, eid: number, flight: StagedFlightTables) {
    super(h, eid, flight, [1, 1, 1]);
  }

  make(id: string): Move | null {
    switch (id) {
      case 'barrage': return this.wingGuns().length ? this.barrage() : null;
      case 'broadside': return this.wingGuns().length ? this.broadside() : null;
      case 'scythe': return this.roots().length ? this.scythe() : null;
      case 'mortar': return this.working('magma_mortar').length ? this.mortarWall() : null;
      case 'dash': return this.working('dash_coil').length ? this.dashChain() : null;
      case 'lance': return this.named(P('lance')) >= 0 ? this.lanceSweep() : null;
      case 'crystal': return this.named(P('s3_mineral')) >= 0 ? this.crystalBeams() : null;
      case 'ring': return this.core() >= 0 ? this.ringPulse() : null;
      case 'swarm': return this.core() >= 0 ? this.swarm() : null;
      case 'vent': return this.vents().length ? this.ventOpen() : null;
    }
    return null;
  }

  personalMove(name: string, target: number, seed: number): Move | null {
    switch (name) {
      case 'lob': { const from = this.lobFrom(target); return from >= 0 ? this.lob(target, from) : null; }
      case 'ember': { const bay = this.sideOf(this.working('brood_bay'), target); return bay >= 0 && this.h.mobs ? this.ember(target, bay) : null; }
      case 'flak': { const f = this.sideOf([this.named(P('wing_flak_l')), this.named(P('wing_flak_r'))].filter((i) => i >= 0), target); return f >= 0 ? this.flak(target, f, seed) : null; }
      case 'synapse': return this.named(P('spine')) >= 0 ? this.synapse(target) : null;
      case 'spark': return this.core() >= 0 ? this.sparkFan(target) : null;
    }
    return super.personalMove(name, target, seed);
  }

  /** (stage three) it darts to a new angle once, before its crystal */
  around(m: Move, name: string): Move {
    return this.stage === 3 && name === 'crystal' ? this.darting(m) : m;
  }

  private *darting(m: Move): Move {
    yield* this.dart(1000, 20, 30);
    yield* m;
  }

  onStop(): void {
    this.swelling = [];
    this.glints = [];
    this.pools = [];
  }

  /** Anything of its still due (magma swelling, sparks, pools) */
  busy(): boolean {
    return this.swelling.length > 0 || this.pools.length > 0 || this.glints.length > 0;
  }

  // ---- Its limbs ----

  /** Its wing turrets (stage one's magma cannons) still working */
  wingGuns(): number[] {
    return this.working('magma_cannon').filter((i) => this.ofStageOf(i) === 1);
  }

  /** Its scythes' roots still working */
  private roots(): number[] {
    return [this.named(P('scythe_root_l')), this.named(P('scythe_root_r'))].filter((i) => i >= 0);
  }

  /** The vents of the stage it's fighting (its body's two, or its heart's three) still working */
  vents(): number[] {
    return this.working('heat_vent').filter((i) => this.ofStageOf(i) === this.stage);
  }

  ofStageOf(i: number): number {
    return this.h.catalog.pieces.get(this.ship.blueprint.parts[i].piece)?.stage ?? 0;
  }

  /** Its heart's core while it's on */
  core(): number {
    const ship = this.ship, i = ship.blueprint.parts.findIndex((p) => p.piece === P('s3_core'));
    return i >= 0 && this.alive(i) ? i : -1;
  }

  /** Of these parts, the one on a pilot's side of it (the nearest: -1 none) */
  sideOf(parts: number[], target: number): number {
    let best = -1, bd = Infinity;
    const tp = this.at(target);
    for (const i of parts) {
      const m = this.mount(i), d = dhypot(tp.x - m.x, tp.y - m.y);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** What lobs magma at a pilot: a wing turret (stage one), a horn gun or a mortar (two), a vent (three) */
  private lobFrom(target: number): number {
    const from = this.stage === 1 ? this.wingGuns()
      : this.stage === 2 ? [...this.working('magma_cannon').filter((i) => this.ofStageOf(i) === 2), ...this.working('magma_mortar')]
        : this.vents();
    return this.sideOf(from, target);
  }

  /** A part's mount in the world (its brain's vents' heat reads it too) */
  mountOf(i: number): { x: number; y: number; dir: number } {
    return this.mount(i);
  }

  /**
   * It turns side-on to its target, `side` (+1: its target off its left as it counts, -1 its right) towards it, following
   * the target as it turns (at most ROLL ticks); returns the heading it settled on, held from there
   */
  private *roll(side: number, most = ROLL): Generator<void, number, void> {
    const t = this.target;
    let heading = this.me().angle;
    for (let i = 0; i < most && t >= 0; i++) {
      const me = this.me(), tp = this.at(t);
      // (re-aimed every ROLL_EVERY ticks, not every tick: each new heading is a want, a decision on the wire)
      if (i % ROLL_EVERY === 0) heading = datan2(tp.y - me.y, tp.x - me.x) - side * Math.PI / 2;
      if (i >= 12 && Math.abs(wrap(me.angle - heading)) < 0.08) break;
      this.want = wantFace(heading);
      yield;
    }
    return heading;
  }

  // ---- Stage one: the fortress ----

  /** A ball of magma swelling on a turret (the turret glowing: clients draw it), hurled `grow` ticks on at where its target is then */
  private swell(part: number, grow: number, fan: number, bite: number, aim: number): void {
    const at = this.bodyFrame(part);
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'magma', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 70, ticks: grow });
    this.swelling.push({ part, at: this.h.tick() + grow, fan, bite, aim, o: this.h.origin });
  }

  /** Magma due now is hurled (slow: tuning.json magma): a fan at where its target is (never where it's going) */
  private hurl(now: number): void {
    const o = this.h.origin;
    for (let i = this.swelling.length - 1; i >= 0; i--) {
      const s = this.swelling[i];
      if (now < s.at) continue;
      this.swelling.splice(i, 1);
      const t = s.aim, tp = t >= 0 ? this.h.pose(t) : null;
      if (!tp || !this.alive(s.part)) continue;
      this.h.origin = s.o;
      const m = this.mount(s.part), a = datan2(tp.y - m.y, tp.x - m.x);
      for (let k = 0; k < s.fan; k++) {
        const ak = a + (s.fan > 1 ? (k / (s.fan - 1) - 0.5) * 0.36 : 0);
        this.fire('magma', m.x + dcos(ak) * 50, m.y + dsin(ak) * 50, ak, s.bite);
      }
    }
    this.h.origin = o;
  }

  /**
   * Its wing turrets clockwise, two at once from opposite sides (their fans cross on you), each a fan of three slow
   * balls at where you are; then the other two, a beat later
   */
  private *barrage(): Move {
    const order = this.clockwise(this.wingGuns()), grow = 66, gap = 24, t = this.target, half = Math.ceil(order.length / 2);
    for (let k = 0; k < half; k++) {
      for (const part of [order[k], order[k + half]]) if (part !== undefined && this.alive(part)) this.swell(part, grow, 3, BITE.barrage, t);
      for (let i = 0; i < gap; i++) { this.want = wantAim(); yield; }
    }
    // (held still while it throws: its balls don't take its speed with them)
    while (this.swelling.length) { this.want = wantAim(); yield; }
  }

  /**
   * It rolls side-on to its target; that wing's turrets swing together and draw lanes, parallel, straight out from
   * that side (two a turret); fast shells only down the lanes. Then the recoil shoves it back
   */
  private *broadside(): Move {
    const t = this.target;
    if (t < 0) return;
    // (the side with turrets on it, the target's if it has them)
    const guns = this.wingGuns(), local = (i: number) => this.bodyFrame(i);
    const me0 = this.me(), tp = this.at(t), toT = datan2(tp.y - me0.y, tp.x - me0.x);
    const tSide = Math.sign(wrap(toT - me0.angle)) || 1;
    let side = tSide;
    if (!guns.some((g) => Math.sign(local(g).y) === side)) side = -side;
    // Two salvos: it rolls side-on (that wing towards the target, its heading a quarter turn off the way to it), and
    // for the second follows the target round again, briefly, and draws its lanes afresh where they've gone
    let heading = yield* this.roll(side);
    for (let salvo = 0; salvo < 2; salvo++) {
      if (salvo) heading = yield* this.roll(side, 50);
      const wing = this.wingGuns().filter((g) => Math.sign(local(g).y) === side);
      if (!wing.length) return;
      // The lanes: straight out from that side, from each turret and beside it
      const lanes = wing.flatMap((g) => { const at = local(g); return [-220, 220].map((dx) => ({ part: g, x: Math.round(at.x + dx), y: Math.round(at.y) })); });
      const warn = salvo ? 54 : 66, rel = side * Math.PI / 2;
      for (const l of lanes) this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'lane', bodyId: this.eid, x: l.x, y: l.y, angle: rel, length: 3600, width: 200, ticks: warn });
      for (let i = 0; i < warn; i++) { this.want = wantFace(heading); yield; }
      const me = this.me(), c = dcos(me.angle), s = dsin(me.angle), a = me.angle + rel;
      for (let shot = 0; shot < (salvo ? 2 : 3); shot++) {
        for (const l of lanes) {
          if (!this.alive(l.part)) continue;
          const x = me.x + l.x * c - l.y * s, y = me.y + l.x * s + l.y * c;
          this.fire('magma', x + dcos(a) * 60, y + dsin(a) * 60, a, BITE.broadside);
        }
        for (let i = 0; i < 6; i++) { this.want = wantFace(heading); yield; }
      }
    }
    // The recoil: shoved back, away from that side
    const away = toT + Math.PI;
    this.want = wantDrive(away, heading, 6);
    yield;
    for (let i = 0; i < 12; i++) { this.want = wantDrive(away, heading); yield; }
  }

  /**
   * A scythe's root glows and the blade draws back (a grinding scrape), then it sweeps that whole side from its nose
   * to its tail, reaching SCYTHE_NEAR to SCYTHE_FAR off its hull: close in, under its reach, it can't touch you
   */
  private *scythe(): Move {
    const t = this.target;
    if (t < 0) return;
    const roots = this.roots(), local = (i: number) => this.bodyFrame(i);
    const me0 = this.me(), tp = this.at(t), toT = datan2(tp.y - me0.y, tp.x - me0.x);
    let side = Math.sign(wrap(toT - me0.angle)) || 1;
    if (!roots.some((r) => Math.sign(local(r).y) === side)) side = -side;
    const root = roots.find((r) => Math.sign(local(r).y) === side)!;
    // Side-on, the scythe's side to its target; then it draws back
    const heading = yield* this.roll(side), warn = 72, at = local(root), r = this.ship.derived.radius;
    const rm = this.mount(root);
    this.launchFx(rm.x, rm.y);
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'scythe', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 160, ticks: warn });
    // (Where it starts: off its nose on that side; faint, its reach can't be read off the hull)
    this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'scythe', bodyId: this.eid, x: 0, y: 0, angle: side * 0.25, length: Math.round(r + SCYTHE_FAR), width: 120, ticks: warn });
    for (let i = 0; i < warn; i++) { this.want = wantFace(heading); yield; }
    // Nose to tail, a beat, and back tail to nose (each pass cuts a pilot once)
    for (let pass = 0; pass < 2; pass++) {
      if (this.named(this.ship.blueprint.parts[root].piece) < 0) return;
      if (pass) for (let i = 0; i < SCYTHE_BEAT; i++) { this.want = wantFace(heading); yield; }
      const sweep = 44, hit = new Set<number>(), from = pass ? Math.PI - 0.25 : 0.25, to = pass ? 0.25 : Math.PI - 0.25;
      // (the blade, drawn over its reach only: client BossFx 'scythe')
      this.h.fx({ type: 'bossBeam', kind: 'scythe', bodyId: this.eid, x: 0, y: 0, a0: side * from, a1: side * to, ticks: sweep, length: Math.round(r + SCYTHE_FAR), width: 220 });
      for (let i = 0; i <= sweep; i++) {
        // (from just off its nose round that side to just off its tail, and back)
        const me = this.me(), a = me.angle + side * (from + (to - from) * (i / sweep));
        const ux = dcos(a), uy = dsin(a);
        if (this.h.work) {
          const inReach = (q: number) => {
            const qp = this.at(q), dx = qp.x - me.x, dy = qp.y - me.y, along = dx * ux + dy * uy, across = Math.abs(dx * uy - dy * ux);
            return along >= r + SCYTHE_NEAR && along <= r + SCYTHE_FAR && across <= 180 && !this.walled(me.x, me.y, q);
          };
          const struck = new Set(hit);
          for (const q of this.h.work.players()) if (!hit.has(q) && !inReach(q)) struck.add(q);
          for (const q of this.cut(me.x + ux * (r + SCYTHE_NEAR), me.y + uy * (r + SCYTHE_NEAR), me.x + ux * (r + SCYTHE_FAR), me.y + uy * (r + SCYTHE_FAR), 180, BITE.scythe, { type: 'kinetic', pen: 3 }, struck)) hit.add(q);
        }
        this.want = wantFace(heading);
        yield;
      }
    }
  }

  // ---- Stage two: the hunter ----

  /**
   * A lane of shells round its target along their line of flight (straight out from it, if they're still): a wall
   * down either side, a cap across the far end where they'd be when the shells land (one mortar left: no cap). Turn,
   * a wall; on, the cap: reverse out the way you came
   */
  private *mortarWall(): Move {
    const mortars = this.working('magma_mortar'), t = this.target, me = this.me();
    if (t < 0) return;
    // Its beds thump twice and puff ash
    for (let k = 0; k < 2; k++) {
      for (const m of this.working('magma_mortar')) { const w = this.mount(m); this.launchFx(w.x, w.y); }
      for (let i = 0; i < 24; i++) { this.want = wantAim(); yield; }
    }
    const tp = this.at(t), tx = tp.x, ty = tp.y, d = dhypot(tx - me.x, ty - me.y) || 1;
    const tv = dhypot(tp.vx, tp.vy);
    const [ux, uy] = tv > 4 ? [tp.vx / tv, tp.vy / tv] : [(tx - me.x) / d, (ty - me.y) / d];
    const nx = -uy, ny = ux, lane = 420, radius = 200, warn = 72;
    const reach = Math.max(1100, tv * warn);
    const spots: [number, number][] = [];
    for (const side of [-1, 1]) for (let along = -600; along <= reach; along += 360) spots.push([tx + ux * along + nx * side * lane, ty + uy * along + ny * side * lane]);
    if (mortars.length > 1) for (let across = -lane + 210; across <= lane - 210; across += 210) spots.push([tx + ux * (reach + 160) + nx * across, ty + uy * (reach + 160) + ny * across]);
    spots.sort((a, b) => dhypot(a[0] - me.x, a[1] - me.y) - dhypot(b[0] - me.x, b[1] - me.y));
    const now = this.h.tick();
    const due: Due[] = spots.map(([x, y], i) => {
      const ticks = warn + Math.floor(i / 2) * 3;
      this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'impact', x: Math.round(x), y: Math.round(y), radius, ticks });
      return { x, y, at: now + ticks };
    });
    while (due.length) { this.land(due, radius, BITE.mortar); this.want = wantAim(); yield; }
  }

  /** Dashes round its target, each streaked first (fewer coils, fewer dashes); the last overshoots */
  private *dashChain(): Move {
    const coils0 = this.working('dash_coil').length, dashes = 3 + coils0;
    for (let k = 0; k < dashes; k++) {
      const t = this.target, coils = this.working('dash_coil').length;
      if (t < 0 || !coils) return;
      const last = k === dashes - 1, me = this.me(), tp = this.at(t);
      const dx = tp.x - me.x, dy = tp.y - me.y, d = dhypot(dx, dy) || 1;
      // Across the line to the target, alternating, pulling back to its range; the last one through
      this.side = this.rnd() < 0.75 ? (-this.side as 1 | -1) : this.side;
      const ux = dx / d, uy = dy / d, range = this.flight.range[1];
      const radial = last ? 0.6 : Math.max(-0.9, Math.min(0.9, (d - range) / range));
      const l0 = dhypot(-uy * this.side + ux * radial, ux * this.side + uy * radial) || 1;
      const [vx, vy] = this.homeward((-uy * this.side + ux * radial) / l0, (ux * this.side + uy * radial) / l0, last ? 2200 : 1500);
      const dir = datan2(vy, vx), wind = 54;
      this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'dash', bodyId: this.eid, x: 0, y: 0, angle: wrap(dir - me.angle), length: last ? 2400 : 1700, width: 160, ticks: wind });
      for (let i = 0; i < wind; i++) { this.want = wantHold(); yield; }
      const share = 0.45 + 0.55 * Math.min(1, coils / Math.max(1, coils0));
      const speed = this.ship.derived.dash.speed * share * 1.1 * (last ? 1.5 : 1);
      this.want = wantDrive(dir, undefined, speed);
      yield;
      for (let i = 0; i < (last ? 16 : 9); i++) { this.want = wantDrive(dir); yield; }
      for (let i = 0; i < (last ? 30 : 14); i++) { this.want = last ? wantHold() : wantFly(); yield; }
    }
  }

  /**
   * The prow lance: a red line, then a burning sweep across its front, always towards the side it first glowed on, and
   * straight back again (its front half only, both ways: behind it, nothing reaches)
   */
  private *lanceSweep(): Move {
    const lance = this.named(P('lance'));
    if (lance < 0) return;
    yield* this.hold(12);
    const swing = this.rnd() < 0.5 ? 1 : -1, a0 = -0.75 * swing, a1 = 0.75 * swing;
    const at = this.bodyFrame(lance), length = 14000, width = 90, warn = 72;
    const heading = this.me().angle;
    this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'lance', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), angle: a0, length, width, ticks: warn });
    for (let i = 0; i < warn; i++) { this.want = wantFace(heading); yield; }
    const ticks = 80;
    for (let i = 0; i < ticks * 2; i++) {
      if (this.named(P('lance')) < 0) return;
      if (i === 0 || i === ticks) this.h.fx({ type: 'bossBeam', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), a0: i ? a1 : a0, a1: i ? a0 : a1, ticks, length, width });
      const k = i < ticks ? i / ticks : 1 - (i - ticks) / ticks;
      this.beam(at, a0 + (a1 - a0) * k, length, width, BITE.lance);
      this.want = wantFace(heading);
      yield;
    }
  }

  // ---- Stage three: the heart ----

  private coreAt(): { x: number; y: number } {
    const m = this.mount(this.core());
    return { x: m.x, y: m.y };
  }

  /** Its core flares (`ring`: a ring pulse coming) or its seams glow (`seams`: a swarm): something's coming out of it */
  private *flare(ticks: number, want = wantHold(), kind = 'ring'): Move {
    const at = this.bodyFrame(this.core());
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind, bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius: kind === 'seams' ? 420 : 260, ticks });
    for (let i = 0; i < ticks; i++) { this.want = want; yield; }
  }

  /** One spark out of its core (tuning.json heart_spark: 20 a tick, out to the vault's walls) */
  private spark(c: { x: number; y: number }, a: number, bite: number, off = 140): void {
    this.fire('heart_spark', c.x + dcos(a) * off, c.y + dsin(a) * off, a, bite);
  }

  /** Seven beams from its crystal in a set order across its front, each a white line 0.9 s first */
  private *crystalBeams(): Move {
    yield* this.hold(12);
    const heading = this.me().angle, warn = 54, gap = 15, burn = 22, length = 9000, width = 60;
    const end = (BEAMS.length - 1) * gap + warn + burn;
    for (let i = 0; i < end; i++) {
      const crystal = this.named(P('s3_mineral'));
      if (crystal < 0) return;
      const at = this.bodyFrame(crystal);
      BEAMS.forEach((k, n) => {
        const rel = k * BEAM_STEP, start = n * gap;
        if (i === start) this.h.fx({ type: 'bossTelegraph', shape: 'line', kind: 'crystal', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), angle: rel, length, width, ticks: warn });
        if (i === start + warn) this.h.fx({ type: 'bossBeam', kind: 'crystal', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), a0: rel, a1: rel, ticks: burn, length, width });
        if (i >= start + warn && i < start + warn + burn) this.beam(at, rel, length, width, BITE.crystal);
      });
      this.want = wantFace(heading);
      yield;
    }
  }

  /**
   * Side-on to its target, its core flares twice: five rings of fast sparks out to the vault's walls, the gaps always at
   * its nose and tail as it faces when each is thrown; it turns a little between rings (one way a volley), so the gaps
   * swing with it
   */
  private *ringPulse(): Move {
    const t = this.target;
    if (t < 0) return;
    let heading = yield* this.roll(this.rnd() < 0.5 ? 1 : -1);
    const turn = this.rnd() < 0.5 ? RING_TURN : -RING_TURN;
    yield* this.flare(36, wantFace(heading));
    yield* this.flare(36, wantFace(heading));
    const n = 28, gapW = 3;
    for (let r = 0; r < RINGS; r++) {
      if (this.core() < 0) return;
      const c = this.coreAt(), a0 = this.me().angle;
      // (spark j's middle at a0 + j/n of a turn: the gaps centred on its nose (j = 0) and its tail (j = n/2))
      for (let j = 0; j < n; j++) {
        const off = j <= gapW / 2 || n - j <= gapW / 2 || Math.abs(j - n / 2) <= gapW / 2;
        if (!off) this.spark(c, a0 + (j / n) * Math.PI * 2, BITE.ring);
      }
      heading = a0 + turn;
      for (let i = 0; i < RING_EVERY; i++) { this.want = wantFace(heading); yield; }
    }
  }

  /** A hiss, its seams glowing: eight seekers in two waves of four, out all round it, then hunting, shared among the pilots */
  private *swarm(): Move {
    const w = this.h.work, who = this.present?.length ? this.present : this.pilots(6000);
    if (w && !who.length) return;
    yield* this.flare(72, wantHold(), 'seams');
    const a0 = this.rnd() * Math.PI * 2;
    for (let wave = 0; wave < 2; wave++) {
      if (this.core() < 0) return;
      const c = this.coreAt();
      for (let k = 0; k < 4; k++) {
        const j = wave * 4 + k, a = a0 + (k / 4) * Math.PI * 2 + wave * Math.PI / 4;
        // (homing: its guide is the server's)
        w?.homing('heart_seeker', c.x + dcos(a) * 90, c.y + dsin(a) * 90, a, w.damageScale * BITE.swarm, who[j % who.length]);
      }
      for (let i = 0; i < 36; i++) { this.want = wantFly(); yield; }
    }
  }


  /** Spent: it goes still and its vents blaze (the heat reaches HEAT_REACH round each); its window is the big one */
  private *ventOpen(): Move {
    const warn = 72;
    for (const v of this.vents()) {
      const at = this.bodyFrame(v), m = this.mount(v);
      this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'vent', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius: PYRECLAST_HEAT_REACH, ticks: warn + PYRECLAST_VENT_TICKS });
      this.launchFx(m.x, m.y);
    }
    for (let i = 0; i < warn; i++) { this.want = wantHold(); yield; }
  }

  // ---- Personal attacks (each aimed at one pilot; never sets the boss's want) ----

  /** A turret (or mortar, or vent) on your side thumps; a faint circle where you are: a ball of magma lands 1.3 s on, and the ground burns 3 s */
  private *lob(target: number, from: number): Move {
    const m = this.mount(from), tp = this.at(target), x = tp.x, y = tp.y, radius = 240, fall = 78;
    this.launchFx(m.x, m.y);
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'lob', x: Math.round(x), y: Math.round(y), radius, ticks: fall });
    for (let i = 0; i < fall; i++) yield;
    this.land([{ x, y, at: 0 }], radius, BITE.lob);
    const now = this.h.tick();
    this.pools.push({ x, y, next: now + 20, until: now + 180 });
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'embers', x: Math.round(x), y: Math.round(y), radius: 200, ticks: 180 });
  }

  /** A bay on your side glows: one ember drone hunts you (keep moving, or shoot it) */
  private *ember(target: number, bay: number): Move {
    const m = this.mount(bay);
    this.launchFx(m.x, m.y);
    for (let i = 0; i < 40; i++) yield;
    const w = this.h.work;
    if (!w) return;
    const mb = this.mount(bay), tp = this.at(target), a = datan2(tp.y - mb.y, tp.x - mb.x);
    w.mob(MOB_IDS.emberDrone, mb.x + dcos(a) * 40, mb.y + dsin(a) * 40, a, 13, w.damageScale * BITE.ember);
  }

  /** Its wing flak swings to you with a click: five bursts round where you are (move off the spot) */
  private *flak(target: number, gun: number, seed: number): Move {
    const m = this.mount(gun), tp = this.at(target), x = tp.x, y = tp.y, radius = 170, fuse = 60;
    this.launchFx(m.x, m.y);
    const now = this.h.tick(), due: Due[] = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + (seed % 628) / 100, r = k === 0 ? 0 : 260;
      const bx = x + (k === 0 ? 0 : dcos(a) * r), by = y + (k === 0 ? 0 : dsin(a) * r);
      this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'flak', x: Math.round(bx), y: Math.round(by), radius, ticks: fuse + k * 4 });
      due.push({ x: bx, y: by, at: now + fuse + k * 4 });
    }
    while (due.length) { this.land(due, radius, BITE.flak / 3); yield; }
  }

  /** A crackle along its wires: three marks on your line ahead, struck 0.8 s later (change direction) */
  private *synapse(target: number): Move {
    const fuse = 48, radius = 190, now = this.h.tick(), due: Due[] = [], tp = this.at(target);
    for (const ahead of [20, 40, 60]) {
      const x = tp.x + tp.vx * (ahead + fuse), y = tp.y + tp.vy * (ahead + fuse);
      this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'synapse', x: Math.round(x), y: Math.round(y), radius, ticks: fuse });
      due.push({ x, y, at: now + fuse });
    }
    for (let i = 0; i < fuse; i++) yield;
    const me = this.me();
    for (const d of due) this.h.fx({ type: 'detonation', kind: 'synapse', x: Math.round(d.x), y: Math.round(d.y), radius, from: [Math.round(me.x), Math.round(me.y)] });
    this.land(due.map((d) => ({ ...d, at: 0 })), radius, BITE.synapse, '');
  }

  /** A spark of light at its core facing you: a fan of three sparks at where you are (sidestep) */
  private *sparkFan(target: number): Move {
    const at = this.bodyFrame(this.core());
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'spark', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 120, ticks: 54 });
    for (let i = 0; i < 54; i++) yield;
    if (this.core() < 0) return;
    const c = this.coreAt(), tp = this.at(target), aim = datan2(tp.y - c.y, tp.x - c.x);
    for (let k = 0; k < 3; k++) this.spark(c, aim + (k - 1) * 0.14, BITE.spark);
  }

  // ---- Its light threat (the brain's harass): between moves and in its window ----

  /**
   * One harassing shot at a pilot: the turret (stage one), horn gun (two) or core (three) on their side glints (the
   * glint: an aimed shot, as the Mother's), and spits one fast spark at where they were (no splash, no shove). Sidestep
   */
  harassShot(t: number): boolean {
    const from = this.stage === 3 ? this.core() : this.sideOf(this.stage === 1 ? this.wingGuns() : this.working('magma_cannon').filter((i) => this.ofStageOf(i) === 2), t);
    if (from < 0) return false;
    const at = this.bodyFrame(from), tp = this.at(t);
    this.h.fx({ type: 'bossTelegraph', shape: 'circle', kind: 'glint', bodyId: this.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 90, ticks: GLINT });
    this.glints.push({ part: from, x: tp.x, y: tp.y, at: this.h.tick() + GLINT, o: this.h.origin });
    return true;
  }

  /** Its harassing sparks due: one from the part that glinted, at where the pilot was then */
  private throwGlints(now: number): void {
    const o = this.h.origin;
    for (let k = this.glints.length - 1; k >= 0; k--) {
      const g = this.glints[k];
      if (now < g.at) continue;
      this.glints.splice(k, 1);
      if (!this.alive(g.part)) continue;
      this.h.origin = g.o;
      const c = this.mount(g.part);
      this.spark(c, datan2(g.y - c.y, g.x - c.x), BITE.spark, 60);
    }
    this.h.origin = o;
  }

  /** Ground left burning by lobs hurts what's in it (the server's) */
  private burnPools(now: number): void {
    for (let k = this.pools.length - 1; k >= 0; k--) {
      const p = this.pools[k];
      if (now >= p.until) { this.pools.splice(k, 1); continue; }
      if (now < p.next) continue;
      p.next = now + 20;
      this.land([{ x: p.x, y: p.y, at: 0 }], 200, BITE.lobPool, '');
    }
  }

  passives(now: number): void {
    this.hurl(now);
    this.throwGlints(now);
    this.burnPools(now);
  }
}
