/**
 * The Pyreclast (its cavern under Ashfall): a hulk the size of a station. It
 * fights in three stages (its pieces' `stage`: stages.ts), each beaten before
 * the next can be hurt (a shot at a later one hurts the nearest part of the
 * one being fought). Each stage is its own fight, a loop of moves gone through
 * in order (one it can't do any more, it skips), and the last is the hardest.
 *
 * Stage one, the fortress (its carapace and wings): slow, holding off at
 * range, its wing turrets doing the work.
 *
 *   barrage      its turrets one after another, clockwise round its wings,
 *                each a fan of three magma balls; twice round
 *   brood        (from its first phase) its bays launch a wave of ember drones
 *   broadside    it turns side-on, the turrets on that wing draw red lines,
 *                then fire down them together. Its wing plates are side-on to
 *                you while it does: a window.
 *
 *   Between moves it circles, its turrets hurling magma one at a time. Shoot
 *   turrets off, less to dodge; shoot the bays off, no more drones. Every
 *   plate gone, it stops, can't be hurt, and blows its skeletons apart where
 *   each plate was; then its wings are gone.
 *
 * Stage two, the hunter (its body): lighter, it drives harder and closes in.
 *
 *   mortar wall  a lane of shells the way you're flying: a wall either side,
 *                a cap across where you'd be when they land (brake, or slip
 *                out the way you came)
 *   dash chain   four dashes round you (each flagged by an orange streak), a
 *                fan of slag after each; the last overshoots, and it's slow to
 *                come about: a window
 *   lance        the prow lance draws a red line, then burns along it,
 *                sweeping across its front
 *   synapse lock its wires mark where you'd be flying straight on, again and
 *                again, and lightning strikes each mark a moment later: keep
 *                turning
 *   charge       only if you keep away from it, now and then: it lines up,
 *                draws its width down a red lane, and rams. Spent, it drifts a
 *                moment; longer, if it hit rock.
 *   vents        (always) anything close to its hull catches fire
 *
 *   Each piece worn out is left a smoking wreck, doing nothing more: wreck
 *   the lance, no sweeps; the coils, no dashes; the mortars, no walls. Every
 *   piece wrecked, it stops again and its body blows apart, piece by piece,
 *   outermost first, its core last.
 *
 * Stage three, the heart: small, quick, darting to a new angle before every
 * move. It fires from its crystal and its core.
 *
 *   crystal      five beams from the crystal in a set order (middle, left,
 *                right, far left, far right), each a white-hot line first
 *   ring         rings of sparks from the core, two gaps in each (never
 *                where you are), the gaps turning a little each ring
 *   spiral       two spirals of sparks (one slower) spun out of the core,
 *                turning back halfway, and fans thrown at where you're going
 *   swarm        seekers from the core, out all round it, then hunting you
 *   vent         spent, it opens its vents and holds still: the only time it
 *                takes full damage (braced, it takes far less, your hits
 *                glancing; shoot its vents off and it can't brace at all).
 *                Close to it, you burn.
 *
 *   Its round (its core and both rings) is what it's beaten by: those pieces
 *   are wrecked, not shot off, their cracks glowing as they're worn (what's
 *   hung on the round can be shot off). All wrecked, it shudders, and every
 *   piece of it blows apart at once.
 *
 * Each stage blown away, its pieces drift clear and crumble: no cover left
 * lying about, nothing to soak up its shots.
 *
 * Its magma bites less from a barrage or a resting turret than from a
 * broadside; its heart's sparks hit hard (a ring only ever catches you with
 * one). Tuned so a pilot who keeps moving finds each stage harder than the
 * last, and one who sits still is punished in all of them.
 *
 * From its last phase it's enraged: quicker, warns you for less time, more of
 * everything. More pilots, more of everything too.
 */

import { Position, Velocity, ShipState, rayTerrain, currentStage, deciding, isRuined, pointInConvex, stageOf, stagedIntegrity, RUIN_HP, datan2, dcos, dhypot, dsin } from '@space-game/common';
import type { PilotOrders } from '../../ships/ShipBridge.js';
import { BossBrain, BossView, BrainHost, bodyFrame, lead, partMount, partsWith, pose, strike, wrap } from './kit.js';

type Move = Generator<void, void, void>;

/** What a move wants of the ship this tick */
interface Want {
  /** Fly this way (unit-ish world vector), or hold still */
  move?: [number, number] | 'hold';
  /** Face this way (unset: the way it's flying, or holding its heading: its flanks and back are there to be hit) */
  face?: number;
  impulse?: [number, number];
}

/** It holds the middle of its arena: never further than this from home (the rock beyond would catch it) */
const HOME_R = 4600;
/** By stage (one, two, three): the range it holds off at between moves, and how far round it circles each time */
const RANGE = [2400, 1700, 1300], CIRCLE = [0.3, 0.4, 0.55];
/** Ticks of rest between moves, by stage */
const REST = [100, 75, 60];
/** Warnings shorten stage by stage (× these) */
const HASTE = [1, 0.85, 0.75];
/** Enraged (its last phase): rests and warnings × this */
const RAGE = 0.8;
/** How much harder than its engines it drives, by stage (world units a tick, along its way): lighter for each it's lost */
const DRIVE = [0, 0.13, 0.22];
/** Its moves, in the order it goes through them, by stage */
const LOOP = [['barrage', 'brood', 'broadside'], ['mortar', 'dash', 'lance', 'synapse'], ['crystal', 'ring', 'spiral', 'swarm', 'vent']];
/** Between moves, a ball of magma swelling on a turret before it's hurled (ticks), and ticks between turrets, by stage */
const MAGMA_GROW = [50, 42], VOLLEY_GAP = [75, 55];
/** Its magma's bite (× its damage; its burning too), by how it's thrown: a barrage's fans, a resting turret's ball, a broadside */
const BARRAGE_BITE = 0.15, VOLLEY_BITE = 0.22, BROADSIDE_BITE = 0.6;
/** Stage two's charge: its target kept away this far, this long (ticks), and no sooner than this after the last */
const CHARGE_AWAY = 2600, CHARGE_WAIT = 240, CHARGE_COOL = 1200;
/** The crystal's beams, in order (× BEAM_STEP radians off its heading) */
const BEAMS = [0, -1, 1, -2, 2], RAGE_BEAMS = [0, -1, 1, -2, 2, -3, 3], BEAM_STEP = 0.3;
/** What it takes of a hit in its heart, braced and with its vents open */
const BRACED = 0.4, OPEN = 1.5;
/** Its carapace's plates (each on both sides, the left first): the order the dev tool (forceShed) shoots them off */
const SHED = ['scythe_plate', 'wing_plate', 'scythe_heel', 'scythe', 'scythe_root', 'wing_vein', 'wing_lead', 'rib_scythe'];
/** Between stages: ticks it holds still before (and after) blowing a stage away, and between each blast (wings, body) */
const BLOW_PAUSE = 45, WING_GAP = 7, BODY_GAP = 5;
/** Blowing a stage away: how hard its pieces drift clear, and within how long they crumble (no cover left lying about, nothing to soak up its shots) */
const BLOW_FLING = 3, BLOW_CRUMBLE = 360;
/** Dying: ticks it shudders before it blows apart, how hard its chunks are thrown, and how long they last before they crumble */
const DEATH_SHUDDER = 75, DEATH_FLING = 13, DEATH_CRUMBLE = 300;

export class PyreclastBrain implements BossBrain {
  private move: Move | null = null;
  /** Its place in its stage's loop */
  private step = 0;
  private restUntil = 0;
  private want: Want = {};
  private side = 1;
  private nextVent = 0;
  private drones = new Set<number>();
  private mortars0 = -1;
  private coils0 = -1;
  private view!: BossView;
  private ship!: ShipState;
  private target = -1;
  /** Turrets' magma: when the next swells (between moves), whose turn it is, and the balls swelling */
  private nextVolley = 0;
  private turn = 0;
  private swelling: { part: number; at: number; fan: number; bite: number }[] = [];
  /** The stage it's fighting in, and between stages, what it's still to blow away (and when) */
  private stage = 1;
  private blows: { at: number; run: () => void }[] = [];
  private dying = false;
  /** (dev) forceShed's steps done */
  private forced = 0;
  /** Stage two's charge: since when its target has kept away (-1: it hasn't), and when it may charge again */
  private away = -1;
  private nextCharge = 0;
  /** Stage three: its vents are open (it takes full damage) until this tick */
  private ventUntil = -1;
  /** How far its hull reaches from its middle (world units), for the stage it was worked out for */
  private reachOf = { stage: 0, r: 0 };

  constructor(private host: BrainHost) {}

  orders(base: PilotOrders | null, ship: ShipState, view: BossView): PilotOrders | null {
    this.view = view;
    this.ship = ship;
    if (this.mortars0 < 0) this.mortars0 = Math.max(1, partsWith(this.host, ship, 'mortar').length);
    if (this.coils0 < 0) this.coils0 = Math.max(1, this.working('dash_coil').length);
    const now = this.host.tick();
    const t = base?.target ?? -1;
    this.target = t;
    this.want = {};
    this.shedding(now);
    // (blown apart: nothing left to fly)
    if (!this.host.ships.get(view.eid)) return null;
    if (this.blows.length && base) {
      // Blowing a stage away: it holds still, quiet
      this.move = null;
      this.want = { move: 'hold' };
      return t >= 0 ? this.fly(base, t) : { ...base, firing: false };
    }
    if (t < 0) {
      // Nobody to fight: let the AI take it home
      this.move = null;
      return base;
    }
    const me = pose(view.eid);
    if (dhypot(Position.x[t] - me.x, Position.y[t] - me.y) > CHARGE_AWAY) { if (this.away < 0) this.away = now; } else this.away = -1;
    if (!this.move && now >= this.restUntil) this.move = this.pick(now);
    this.passives(now);
    if (this.move && this.move.next().done) {
      this.move = null;
      this.restUntil = now + Math.round(REST[this.stage - 1] * this.rage() / (1 + 0.15 * (view.fighters - 1)));
    }
    return this.fly(base!, t);
  }

  idle(): boolean {
    return !this.move && !this.blows.length && !this.dying && !this.swelling.length;
  }

  dispose(): void {
    // Its drones burn out with it
    if (this.view) this.host.mobs?.clear(this.view.systemNum, this.view.eid);
    this.drones.clear();
  }

  // ---- Flying ----

  private fly(base: PilotOrders, t: number): PilotOrders {
    const me = pose(this.view.eid);
    const tx = Position.x[t], ty = Position.y[t];
    const si = this.stage - 1, range = RANGE[si];
    let mx = 0, my = 0;
    const w = this.want;
    if (w.move === 'hold') {
      // Brake against its own drift
      const v = dhypot(Velocity.x[this.view.eid], Velocity.y[this.view.eid]);
      if (v > 0.8) { mx = -Velocity.x[this.view.eid] / v; my = -Velocity.y[this.view.eid] / v; }
    } else if (w.move) {
      [mx, my] = w.move;
    } else {
      // Circle at range: a point round the target, a little further on each time
      if (this.host.rng() < 0.004) this.side = -this.side;
      const a = datan2(me.y - ty, me.x - tx) + CIRCLE[si] * this.side;
      const [px, py] = this.keepHome(tx + dcos(a) * range, ty + dsin(a) * range);
      const sx = px - me.x, sy = py - me.y, s = dhypot(sx, sy) || 1;
      if (s > 160) { mx = sx / s; my = sy / s; }
    }
    const face = w.face ?? (mx || my ? datan2(my, mx) : me.angle);
    const controls = {
      forward: my < -0.38, backward: my > 0.38, left: mx < -0.38, right: mx > 0.38,
      boost: !w.move && dhypot(tx - me.x, ty - me.y) > range * 1.6 && this.fromHome(me.x, me.y) < HOME_R * 0.8, targetAngle: face,
    };
    // Lighter for each stage it's lost: it drives harder than its engines alone (the same engines throughout: as built)
    let impulse = w.impulse;
    if (DRIVE[si] && w.move !== 'hold' && (mx || my)) {
      const l = dhypot(mx, my);
      impulse = [(impulse?.[0] ?? 0) + (mx / l) * DRIVE[si], (impulse?.[1] ?? 0) + (my / l) * DRIVE[si]];
    }
    return {
      ...base,
      controls,
      // (its turrets track their targets, but it fires them itself: see volleys; it turns as its hull lets it: bosses.json turn)
      firing: false,
      impulse,
    };
  }

  /** A point kept within its ground (pulled in to the edge of it) */
  private keepHome(x: number, y: number): [number, number] {
    const h = this.view.home, dx = x - h.x, dy = y - h.y, d = dhypot(dx, dy);
    return d <= HOME_R ? [x, y] : [h.x + (dx / d) * HOME_R, h.y + (dy / d) * HOME_R];
  }

  private fromHome(x: number, y: number): number {
    return dhypot(x - this.view.home.x, y - this.view.home.y);
  }

  /** A unit way to go, bent back in if `reach` along it would take it off its ground */
  private homeward(vx: number, vy: number, reach: number): [number, number] {
    const me = pose(this.view.eid);
    if (this.fromHome(me.x + vx * reach, me.y + vy * reach) <= HOME_R) return [vx, vy];
    const hx = this.view.home.x - me.x, hy = this.view.home.y - me.y, hl = dhypot(hx, hy) || 1;
    const bx = vx * 0.3 + (hx / hl) * 0.9, by = vy * 0.3 + (hy / hl) * 0.9, bl = dhypot(bx, by) || 1;
    return [bx / bl, by / bl];
  }

  // ---- Choosing ----

  /** Its next move: the next in its stage's loop it can still do (or stage two's charge, if its target keeps away) */
  private pick(now: number): Move | null {
    if (this.stage === 2 && this.away >= 0 && now - this.away > CHARGE_WAIT && now >= this.nextCharge
      && this.fromHome(Position.x[this.target], Position.y[this.target]) < HOME_R + 2500) {
      this.nextCharge = now + CHARGE_COOL;
      this.away = -1;
      return this.charge();
    }
    const loop = LOOP[this.stage - 1];
    for (let k = 0; k < loop.length; k++) {
      const m = this.make(loop[this.step++ % loop.length]);
      if (m) return this.stage === 3 ? this.darting(m) : m;
    }
    return null;
  }

  private make(id: string): Move | null {
    switch (id) {
      case 'barrage': return this.guns().length ? this.barrage() : null;
      case 'brood': return this.view.phase >= 1 && this.bays().length && this.host.mobs ? this.brood() : null;
      case 'broadside': return this.guns().length ? this.broadside() : null;
      case 'mortar': return partsWith(this.host, this.ship, 'mortar').length ? this.mortarWall() : null;
      case 'dash': return this.working('dash_coil').length ? this.dashChain() : null;
      case 'lance': return partsWith(this.host, this.ship, 'lance').length ? this.lanceSweep() : null;
      case 'synapse': return this.synapse();
      case 'crystal': return this.crystal() >= 0 ? this.crystalBeams() : null;
      case 'ring': return this.core() >= 0 ? this.ringPulse() : null;
      case 'spiral': return this.core() >= 0 ? this.spiral() : null;
      case 'swarm': return this.core() >= 0 ? this.swarm() : null;
      case 'vent': return partsWith(this.host, this.ship, 'vent').length ? this.ventWindow() : null;
    }
    return null;
  }

  private rage(): number {
    return this.view.phase >= 4 ? RAGE : 1;
  }

  private haste(ticks: number): number {
    return Math.round(ticks * HASTE[this.stage - 1] * this.rage());
  }

  // ---- Its parts ----

  /** Parts of this function still on and working (a wreck does nothing) */
  private working(fn: string): number[] {
    const ship = this.ship;
    return ship.blueprint.parts.flatMap((p, i) => (p.fn === fn && ship.derived.alive[i] && !isRuined(this.host.ships.catalog, ship, i) ? [i] : []));
  }

  /** Its magma turrets still working */
  private guns(): number[] {
    const ship = this.ship;
    return ship.derived.weapons.filter((w) => w.kind === 'magma' && ship.derived.alive[w.part] && !isRuined(this.host.ships.catalog, ship, w.part)).map((w) => w.part);
  }

  private bays(): ShipState['derived']['launchers'] {
    return this.ship.derived.launchers.filter((l) => this.ship.derived.alive[l.part] && !isRuined(this.host.ships.catalog, this.ship, l.part));
  }

  /** Its heart's crystal, if it's still on (-1: shot off) */
  private crystal(): number {
    const i = this.ship.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_s3_mineral');
    return i >= 0 && this.ship.derived.alive[i] ? i : -1;
  }

  /** Its heart's core (it's always there: wrecked at worst) */
  private core(): number {
    const i = this.ship.blueprint.parts.findIndex((p) => p.piece === 'pyreclast_s3_core');
    return i >= 0 && this.ship.derived.alive[i] ? i : -1;
  }

  /** Parts in clockwise order round its middle (as seen: y down), from its nose */
  private clockwise(parts: number[]): number[] {
    const geo = this.host.ships.geometry(this.ship), c = this.ship.derived.com;
    const turn = (i: number) => { const [x, y] = geo[i].centroid; return (datan2(y - c[1], x - c[0]) + Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI); };
    return [...parts].sort((a, b) => turn(a) - turn(b));
  }

  /** How far its hull reaches from its middle now (world units) */
  private reach(): number {
    if (this.reachOf.stage !== this.stage) {
      const geo = this.host.ships.geometry(this.ship), c = this.ship.derived.com;
      let r = 0;
      geo.forEach((g, i) => { if (this.ship.derived.alive[i]) for (const [x, y] of g.polygon) r = Math.max(r, dhypot(x - c[0], y - c[1])); });
      this.reachOf = { stage: this.stage, r: r * this.host.ships.tuning.cellSize };
    }
    return this.reachOf.r;
  }

  // ---- Stage one: the fortress ----

  /** Its turrets one after another clockwise round its wings, each a fan of three; twice round */
  private *barrage(): Move {
    const order = this.clockwise(this.guns()), grow = this.haste(34), gap = this.haste(12);
    for (let round = 0; round < 2; round++) {
      for (const part of order) {
        if (this.ship.derived.alive[part]) this.swell(part, grow, 3, BARRAGE_BITE);
        for (let i = 0; i < gap; i++) { this.want = {}; yield; }
      }
    }
    while (this.swelling.length) { this.want = {}; yield; }
  }

  /** A wave of ember drones out of its bays */
  private *brood(): Move {
    const mobs = this.host.mobs!, eid = this.view.eid;
    for (const d of [...this.drones]) if (!mobs.has(d)) this.drones.delete(d);
    const cap = 10 + 4 * this.view.fighters;
    for (const bay of this.bays()) {
      const m = partMount(this.host, eid, this.ship, bay.part);
      this.host.launchFx(this.view.systemNum, m.x, m.y);
      const n = bay.count + (this.rage() < 1 ? 1 : 0) + Math.floor((this.view.fighters - 1) / 2);
      for (let i = 0; i < n && this.drones.size < cap; i++) {
        const a = m.dir + (i / Math.max(1, n - 1) - 0.5) * 0.9;
        const d = mobs.spawn(bay.mob, this.view.systemNum, m.x + dcos(a) * 30, m.y + dsin(a) * 30, a, 13, eid, this.view.damage);
        if (d >= 0) this.drones.add(d);
      }
    }
    for (let i = 0; i < 50; i++) { this.want = {}; yield; }
  }

  /** Side-on to its target: the turrets on that wing draw lines at it, then fire down them together */
  private *broadside(): Move {
    const t = this.target, eid = this.view.eid;
    const turn = this.host.rng() < 0.5 ? 1 : -1;
    for (let i = 0; i < 45; i++) {
      const me = pose(eid);
      this.want = { move: 'hold', face: datan2(Position.y[t] - me.y, Position.x[t] - me.x) + turn * Math.PI / 2 };
      yield;
    }
    const me = pose(eid), heading = me.angle;
    // (the target in its own frame: which side it's on)
    const c = dcos(-heading), s = dsin(-heading), dx = Position.x[t] - me.x, dy = Position.y[t] - me.y;
    const tx = dx * c - dy * s, ty = dx * s + dy * c;
    const all = this.guns().map((part) => ({ part, at: bodyFrame(this.host, eid, this.ship, part) }));
    const near = all.filter((g) => Math.sign(g.at.y) === Math.sign(ty));
    const guns = (near.length ? near : all).map((g) => ({ ...g, angle: datan2(ty - g.at.y, tx - g.at.x) }));
    const warn = this.haste(55);
    for (const g of guns) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'lance', bodyId: eid, x: Math.round(g.at.x), y: Math.round(g.at.y), angle: g.angle, length: 3200, width: 150, ticks: warn });
    for (let i = 0; i < warn; i++) { this.want = { move: 'hold', face: heading }; yield; }
    for (let shot = 0; shot < 2; shot++) {
      const now = pose(eid);
      for (const g of guns) {
        if (!this.ship.derived.alive[g.part]) continue;
        const m = partMount(this.host, eid, this.ship, g.part), a = now.angle + g.angle;
        this.host.fire(eid, 'magma', m.x + dcos(a) * 50, m.y + dsin(a) * 50, a, this.view.damage * BROADSIDE_BITE);
      }
      for (let i = 0; i < 8; i++) { this.want = { move: 'hold', face: heading }; yield; }
    }
    // (still side-on a moment: its plates are open to you)
    for (let i = 0; i < 40; i++) { this.want = { move: 'hold', face: heading }; yield; }
  }

  // ---- Stage two: the hunter ----

  /**
   * A lane of shells round its target, the way they're flying (straight out from it, if they're still): a wall down
   * either side, and a cap across the far end where they'd be when the shells land. Straight on, you meet the cap;
   * turn, a wall: brake, or slip out the way you came.
   */
  private *mortarWall(): Move {
    const mortars = partsWith(this.host, this.ship, 'mortar');
    const t = this.target, me = pose(this.view.eid);
    const tx = Position.x[t], ty = Position.y[t], d = dhypot(tx - me.x, ty - me.y) || 1;
    const tv = dhypot(Velocity.x[t], Velocity.y[t]);
    const [ux, uy] = tv > 4 ? [Velocity.x[t] / tv, Velocity.y[t] / tv] : [(tx - me.x) / d, (ty - me.y) / d];
    const nx = -uy, ny = ux;
    const lane = 400, radius = 200, warn = this.haste(80);
    // (from a little behind them to the cap: where they'd be when it lands, or a way on if they're still)
    const reach = Math.max(1100, tv * warn), step = 340 + 160 * (1 - mortars.length / this.mortars0);
    const spots: [number, number][] = [];
    for (const side of [-1, 1]) for (let along = -600; along <= reach; along += step) spots.push([tx + ux * along + nx * side * lane, ty + uy * along + ny * side * lane]);
    for (let across = -lane + 200; across <= lane - 200; across += 200) spots.push([tx + ux * (reach + 150) + nx * across, ty + uy * (reach + 150) + ny * across]);
    // Every other pilot gets one
    const pilots = this.host.players(this.view.systemNum).filter((q) => q !== t && dhypot(Position.x[q] - me.x, Position.y[q] - me.y) < 5000);
    for (const q of pilots) { const l = lead(q, warn * 0.6); spots.push([l.x, l.y]); }
    // (nearest it first: the walls run out away from it)
    spots.sort((a, b) => dhypot(a[0] - me.x, a[1] - me.y) - dhypot(b[0] - me.x, b[1] - me.y));
    const now = this.host.tick();
    const due = spots.map(([x, y], i) => {
      const ticks = warn + Math.floor(i / 2) * 3;
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'impact', x: Math.round(x), y: Math.round(y), radius, ticks });
      return { x, y, at: now + ticks };
    });
    for (const m of mortars) { const mw = partMount(this.host, this.view.eid, this.ship, m); this.host.launchFx(this.view.systemNum, mw.x, mw.y); }
    while (due.length) {
      this.land(due, radius, 100);
      this.want = {};
      yield;
    }
  }

  /** Shells (or strikes) due now come down */
  private land(due: { x: number; y: number; at: number }[], radius: number, damage: number, kind = 'eruption'): void {
    const n = this.host.tick();
    for (let i = due.length - 1; i >= 0; i--) {
      if (n < due[i].at) continue;
      const { x, y } = due[i];
      due.splice(i, 1);
      strike(this.host, this.view.systemNum, x, y, radius, damage * this.view.damage, this.view.eid);
      const me = pose(this.view.eid);
      this.host.send(this.view.systemNum, { type: 'detonation', kind, x: Math.round(x), y: Math.round(y), radius, ...(kind === 'synapse' ? { from: [Math.round(me.x), Math.round(me.y)] as [number, number] } : {}) });
    }
  }

  /** Sideways bursts round the target, a fan of slag after each; the last overshoots, and it's slow to come about */
  private *dashChain(): Move {
    const dashes = this.rage() < 1 ? 5 : 4;
    for (let k = 0; k < dashes; k++) {
      const t = this.target, coils = this.working('dash_coil').length;
      if (t < 0 || !coils) return;
      const last = k === dashes - 1;
      const me = pose(this.view.eid);
      const dx = Position.x[t] - me.x, dy = Position.y[t] - me.y, d = dhypot(dx, dy) || 1;
      // Across the line to the target, alternating, and pulling back towards its range; the last one through
      this.side = this.host.rng() < 0.75 ? -this.side : this.side;
      const ux = dx / d, uy = dy / d;
      const radial = last ? 0.6 : Math.max(-0.9, Math.min(0.9, (d - RANGE[1]) / RANGE[1]));
      const vl0 = dhypot(-uy * this.side + ux * radial, ux * this.side + uy * radial) || 1;
      const [vx, vy] = this.homeward((-uy * this.side + ux * radial) / vl0, (ux * this.side + uy * radial) / vl0, last ? 2200 : 1500);
      const dir = datan2(vy, vx);
      const wind = this.haste(45);
      // The streak: where it's about to go
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'dash', bodyId: this.view.eid, x: 0, y: 0, angle: wrap(dir - me.angle), length: last ? 2400 : 1700, width: 160, ticks: wind });
      for (let i = 0; i < wind; i++) { this.want = { move: 'hold' }; yield; }
      // Go: the coils' share of the kick (fewer coils, a shorter dash)
      const share = 0.45 + 0.55 * Math.min(1, coils / this.coils0);
      const speed = this.ship.derived.dash.speed * share * 1.1 * (last ? 1.5 : 1);
      this.want = { impulse: [vx * speed, vy * speed], move: [vx, vy] };
      yield;
      for (let i = 0; i < (last ? 16 : 9); i++) { this.want = { move: [vx, vy] }; yield; }
      this.slag(this.rage() < 1 ? 9 : 8);
      // (the last: it's carried on, and slow to come about)
      for (let i = 0; i < (last ? 70 : this.haste(16)); i++) { this.want = last ? { move: 'hold' } : {}; yield; }
    }
  }

  /** A fan of slag at the target, from the prow */
  private slag(count: number): void {
    const t = this.target;
    if (t < 0) return;
    const me = pose(this.view.eid);
    const r = this.ship.derived.radius * 0.7;
    const ox = me.x + dcos(me.angle) * r, oy = me.y + dsin(me.angle) * r;
    const at = lead(t, dhypot(Position.x[t] - ox, Position.y[t] - oy) / 36);
    const a0 = datan2(at.y - oy, at.x - ox);
    for (let i = 0; i < count; i++) {
      const a = a0 + (i / Math.max(1, count - 1) - 0.5) * 0.55;
      this.host.fire(this.view.eid, 'cinder_bloom', ox + dcos(a) * 30, oy + dsin(a) * 30, a, this.view.damage);
    }
  }

  /** The prow lance: a red line, then a burning sweep across its front */
  private *lanceSweep(): Move {
    const lance = partsWith(this.host, this.ship, 'lance')[0];
    if (lance === undefined) return;
    const t = this.target;
    const wind = this.haste(110);
    const swing = this.host.rng() < 0.5 ? 1 : -1;
    const a0 = -0.75 * swing, a1 = 0.75 * swing;
    const at = bodyFrame(this.host, this.view.eid, this.ship, lance);
    const length = 14000, width = 90;
    // Turn on the target first, then warn along where the sweep starts
    for (let i = 0; i < 20; i++) {
      const me = pose(this.view.eid);
      this.want = { move: 'hold', face: datan2(Position.y[t] - me.y, Position.x[t] - me.x) };
      yield;
    }
    const me0 = pose(this.view.eid);
    const heading = datan2(Position.y[t] - me0.y, Position.x[t] - me0.x);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'lance', bodyId: this.view.eid, x: at.x, y: at.y, angle: a0, length, width, ticks: wind });
    for (let i = 0; i < wind; i++) { this.want = { move: 'hold', face: heading }; yield; }
    const ticks = this.haste(100);
    this.host.send(this.view.systemNum, { type: 'bossBeam', bodyId: this.view.eid, x: at.x, y: at.y, a0, a1, ticks, length, width });
    for (let i = 0; i < ticks; i++) {
      if (!partsWith(this.host, this.ship, 'lance').length) return;
      this.beam(at, a0 + (a1 - a0) * (i / ticks), length, width, 9);
      this.want = { move: 'hold', face: heading };
      yield;
    }
  }

  /** A beam's burn this tick, from a point on the body (its own frame) at an angle off its heading; it stops at rock */
  private beam(at: { x: number; y: number }, rel: number, length: number, width: number, damage: number): void {
    const me = pose(this.view.eid), a = me.angle + rel;
    const c = dcos(me.angle), s = dsin(me.angle);
    const x0 = me.x + at.x * c - at.y * s, y0 = me.y + at.x * s + at.y * c;
    const reach = length * rayTerrain(this.host.terrain?.(this.view.systemNum), x0, y0, x0 + dcos(a) * length, y0 + dsin(a) * length);
    this.burn(x0, y0, x0 + dcos(a) * reach, y0 + dsin(a) * reach, width, damage * this.view.damage);
  }

  /** Its wires mark where its target will be if it flies straight on, again and again: lightning strikes each mark a moment later (keep turning) */
  private *synapse(): Move {
    const marks = this.rage() < 1 ? 6 : 5, every = this.haste(22), fuse = this.haste(50), radius = 170;
    const due: { x: number; y: number; at: number }[] = [];
    for (let k = 0; k < marks; k++) {
      const t = this.target;
      if (t < 0) break;
      // Where they'll be, straight on (brake or turn, and it misses), and every other pilot, every other mark
      const who = [t, ...(k % 2 ? [] : this.host.players(this.view.systemNum).filter((q) => q !== t && dhypot(Position.x[q] - Position.x[this.view.eid], Position.y[q] - Position.y[this.view.eid]) < 5000))];
      for (const q of who) {
        const { x, y } = lead(q, fuse);
        this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'synapse', x: Math.round(x), y: Math.round(y), radius, ticks: fuse });
        due.push({ x, y, at: this.host.tick() + fuse });
      }
      for (let i = 0; i < every; i++) { this.land(due, radius, 90, 'synapse'); this.want = {}; yield; }
    }
    while (due.length) { this.land(due, radius, 90, 'synapse'); this.want = {}; yield; }
  }

  /** Turn, warn down its whole width, and ram; spent, it drifts (longer if it hit rock) */
  private *charge(): Move {
    const t = this.target;
    const wind = this.haste(90);
    const r = this.ship.derived.radius;
    let me = pose(this.view.eid);
    // Aim where they'll be when it lands, roughly
    for (let i = 0; i < wind; i++) {
      me = pose(this.view.eid);
      const at = lead(t, 25);
      const face = datan2(at.y - me.y, at.x - me.x);
      if (i === 18) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'charge', bodyId: this.view.eid, x: 0, y: 0, angle: 0, length: 3600, width: r * 1.2, ticks: wind - 18 });
      this.want = { move: 'hold', face };
      yield;
    }
    me = pose(this.view.eid);
    const vx = dcos(me.angle), vy = dsin(me.angle);
    // (a ram carries it ~66× its kick: no further than the far side of its ground)
    let room = 0;
    for (let s = 0; s < 4 * HOME_R; s += 200) { if (this.fromHome(me.x + vx * s, me.y + vy * s) > HOME_R + 1500) break; room = s; }
    const speed = Math.max(12, Math.min(28, room / 66));
    this.want = { impulse: [vx * speed, vy * speed], move: [vx, vy], face: me.angle };
    yield;
    let hit = false;
    for (let i = 0; i < 40; i++) {
      // (stopped dead, early: it ran into something)
      if (i > 6 && dhypot(Velocity.x[this.view.eid], Velocity.y[this.view.eid]) < speed * 0.35) hit = true;
      this.want = hit ? { move: 'hold' } : { move: [vx, vy], face: me.angle };
      yield;
    }
    for (let i = 0; i < (hit ? 180 : 60); i++) { this.want = { move: 'hold' }; yield; }
  }

  // ---- Stage three: the heart ----

  /** Before each of its heart's moves: a short, quick burst to a new angle on its target */
  private *darting(then: Move): Move {
    const t = this.target, me = pose(this.view.eid);
    const dx = Position.x[t] - me.x, dy = Position.y[t] - me.y, d = dhypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, side = this.host.rng() < 0.5 ? 1 : -1;
    const radial = Math.max(-0.7, Math.min(0.7, (d - RANGE[2]) / RANGE[2]));
    const l0 = dhypot(-uy * side + ux * radial, ux * side + uy * radial) || 1;
    const [vx, vy] = this.homeward((-uy * side + ux * radial) / l0, (ux * side + uy * radial) / l0, 1000);
    const wind = this.haste(24);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'dash', bodyId: this.view.eid, x: 0, y: 0, angle: wrap(datan2(vy, vx) - me.angle), length: 1000, width: 110, ticks: wind });
    for (let i = 0; i < wind; i++) { this.want = { move: 'hold' }; yield; }
    this.want = { impulse: [vx * 20, vy * 20], move: [vx, vy] };
    yield;
    for (let i = 0; i < 14; i++) { this.want = { move: [vx, vy] }; yield; }
    yield* then;
  }

  /** Beams from its crystal, one after another in a set order across its front, each a white-hot line first */
  private *crystalBeams(): Move {
    const t = this.target, eid = this.view.eid;
    for (let i = 0; i < 18; i++) {
      const me = pose(eid);
      this.want = { move: 'hold', face: datan2(Position.y[t] - me.y, Position.x[t] - me.x) };
      yield;
    }
    const me = pose(eid), heading = datan2(Position.y[t] - me.y, Position.x[t] - me.x);
    const order = this.rage() < 1 ? RAGE_BEAMS : BEAMS;
    const warn = this.haste(45), gap = this.haste(16), burn = 22, length = 9000, width = 60;
    const end = (order.length - 1) * gap + warn + burn;
    let at = bodyFrame(this.host, eid, this.ship, this.crystal());
    for (let i = 0; i < end; i++) {
      // (shot off: no more beams)
      if (this.crystal() < 0) return;
      at = bodyFrame(this.host, eid, this.ship, this.crystal());
      order.forEach((k, n) => {
        const rel = k * BEAM_STEP, start = n * gap;
        if (i === start) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'crystal', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: rel, length, width, ticks: warn });
        if (i === start + warn) this.host.send(this.view.systemNum, { type: 'bossBeam', kind: 'crystal', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), a0: rel, a1: rel, ticks: burn, length, width });
        if (i >= start + warn && i < start + warn + burn) this.beam(at, rel, length, width, 14);
      });
      this.want = { move: 'hold', face: heading };
      yield;
    }
  }

  /** Where its core is, in the world */
  private coreAt(): { x: number; y: number } {
    const m = partMount(this.host, this.view.eid, this.ship, this.core());
    return { x: m.x, y: m.y };
  }

  /** A warning on its core: something's coming out of it */
  private *gather(ticks: number): Move {
    const at = bodyFrame(this.host, this.view.eid, this.ship, this.core());
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'ring', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 260, ticks });
    for (let i = 0; i < ticks; i++) { this.want = { move: 'hold' }; yield; }
  }

  /** One spark out of its core this way (`speed`: × a spark's) */
  private spark(c: { x: number; y: number }, a: number, speed = 1): void {
    this.host.fire(this.view.eid, 'heart_spark', c.x + dcos(a) * 140, c.y + dsin(a) * 140, a, this.view.damage, { speed });
  }

  /** A quick fan of sparks out of its core at where its target's going (what makes you move, when the rest could be sat out) */
  private fan(count: number, spread: number): void {
    const t = this.target;
    if (t < 0) return;
    const c = this.coreAt(), speed = 1.35 * (this.host.ships.tuning.weapons?.heart_spark?.speed ?? 12);
    const at = lead(t, dhypot(Position.x[t] - c.x, Position.y[t] - c.y) / speed), a0 = datan2(at.y - c.y, at.x - c.x);
    for (let k = 0; k < count; k++) this.spark(c, a0 + (k / Math.max(1, count - 1) - 0.5) * spread, 1.35);
  }

  /** Rings of great slow sparks from its core (room to slip between them, just), each with two wide gaps (the first ring solid where its target is), the gaps turning a little each ring */
  private *ringPulse(): Move {
    const rings = this.rage() < 1 ? 5 : 4, n = 28, gapW = 3, every = this.haste(40);
    yield* this.gather(this.haste(30));
    const c0 = this.coreAt(), t = this.target;
    // (a gap's middle at off + half a gap; the solid's middle a quarter turn on: there, its target)
    let off = datan2(Position.y[t] - c0.y, Position.x[t] - c0.x) - Math.PI / 2 - (gapW / 2 / n) * Math.PI * 2;
    for (let r = 0; r < rings; r++) {
      const c = this.coreAt();
      for (let j = 0; j < n; j++) {
        if (j < gapW || (j >= n / 2 && j < n / 2 + gapW)) continue;
        this.spark(c, off + (j / n) * Math.PI * 2);
      }
      off += 0.5;
      for (let i = 0; i < every; i++) { this.want = { move: 'hold' }; yield; }
    }
  }

  /** Arms of sparks spun out of its core, every other one slower (two spirals, one inside the other), turning back halfway; a fan at its target now and then */
  private *spiral(): Move {
    const arms = this.rage() < 1 ? 5 : 4, ticks = this.rage() < 1 ? 200 : 160, every = 12, aimed = this.haste(40);
    let base = this.host.rng() * Math.PI * 2, spin = 0.24;
    yield* this.gather(this.haste(30));
    for (let i = 0; i < ticks; i++) {
      if (i === ticks / 2) spin = -spin;
      if (i % every === 0) {
        const c = this.coreAt(), slow = (i / every) % 2 === 1;
        for (let k = 0; k < arms; k++) this.spark(c, base + (k / arms) * Math.PI * 2, slow ? 0.6 : 1);
        base += spin;
      }
      if (i % aimed === Math.floor(aimed / 2)) this.fan(3, 0.45);
      this.want = { move: 'hold' };
      yield;
    }
  }

  /** Seekers out of its core all round it, then hunting: its target, and the others too */
  private *swarm(): Move {
    const t = this.target, eid = this.view.eid;
    const others = this.host.players(this.view.systemNum).filter((q) => q !== t && dhypot(Position.x[q] - Position.x[eid], Position.y[q] - Position.y[eid]) < 6000);
    const who = [t, ...others];
    const count = Math.min(18, (this.rage() < 1 ? 12 : 10) + 2 * others.length);
    yield* this.gather(this.haste(36));
    const c = this.coreAt(), a0 = this.host.rng() * Math.PI * 2;
    for (let j = 0; j < count; j++) {
      const a = a0 + (j / count) * Math.PI * 2;
      this.host.fire(eid, 'heart_seeker', c.x + dcos(a) * 90, c.y + dsin(a) * 90, a, this.view.damage, { target: who[j % who.length] });
    }
    for (let i = 0; i < 50; i++) { this.want = {}; yield; }
  }

  /** Spent: it opens its vents and holds still, taking full damage; close to it, you burn */
  private *ventWindow(): Move {
    const eid = this.view.eid, open = this.rage() < 1 ? 120 : 170, reach = this.reach();
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'vent', bodyId: eid, x: 0, y: 0, radius: Math.round(reach + 380), ticks: open });
    for (const v of partsWith(this.host, this.ship, 'vent')) { const m = partMount(this.host, eid, this.ship, v); this.host.launchFx(this.view.systemNum, m.x, m.y); }
    this.ventUntil = this.host.tick() + open;
    for (let i = 0; i < open; i++) {
      if (i % 20 === 0) this.scorch(reach + 380, 12);
      this.want = { move: 'hold' };
      yield;
    }
    this.ventUntil = -1;
  }

  /** What it takes of a hit: in its heart, braced unless its vents are open (none left, it can't brace) */
  taken(): number {
    if (this.stage !== 3 || this.dying || !this.ship) return 1;
    if (this.host.tick() < this.ventUntil) return OPEN;
    return partsWith(this.host, this.ship, 'vent').length ? BRACED : 1;
  }

  // ---- Always on ----

  /** Between moves, its turrets' magma one after another: a ball swells on the turret, then it's hurled */
  private volleys(now: number): void {
    const si = Math.min(1, this.stage - 1);
    const guns = this.stage < 3 ? this.guns() : [];
    if (guns.length && !this.move && now >= this.nextVolley && this.target >= 0) {
      this.swell(guns[this.turn++ % guns.length], MAGMA_GROW[si], 1, VOLLEY_BITE);
      this.nextVolley = now + Math.round(VOLLEY_GAP[si] / (1 + 0.15 * (this.view.fighters - 1)));
    }
    const eid = this.view.eid, ship = this.ship;
    const speed = this.host.ships.tuning.weapons?.magma?.speed ?? 30;
    for (let i = this.swelling.length - 1; i >= 0; i--) {
      const s = this.swelling[i];
      if (now < s.at) continue;
      this.swelling.splice(i, 1);
      const t = this.target;
      if (t < 0 || !ship.derived.alive[s.part]) continue;
      const m = partMount(this.host, eid, ship, s.part);
      const aim = lead(t, dhypot(Position.x[t] - m.x, Position.y[t] - m.y) / speed);
      const a = datan2(aim.y - m.y, aim.x - m.x);
      for (let k = 0; k < s.fan; k++) {
        const ak = a + (s.fan > 1 ? (k / (s.fan - 1) - 0.5) * 0.36 : 0);
        this.host.fire(eid, 'magma', m.x + dcos(ak) * 50, m.y + dsin(ak) * 50, ak, this.view.damage * s.bite);
      }
    }
  }

  /** A ball of magma swelling on a turret (clients draw it from the warning), hurled `grow` ticks on */
  private swell(part: number, grow: number, fan: number, bite: number): void {
    const at = bodyFrame(this.host, this.view.eid, this.ship, part);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'magma', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 70, ticks: grow });
    this.swelling.push({ part, at: this.host.tick() + grow, fan, bite });
  }

  private passives(now: number): void {
    this.volleys(now);
    // Vents: close to its hull, you burn
    if (this.stage >= 2 && now >= this.nextVent && partsWith(this.host, this.ship, 'vent').length) {
      this.nextVent = now + 30;
      this.scorch(this.reach() + 320, 9);
    }
  }

  /** Every pilot within `reach` of it catches fire */
  private scorch(reach: number, dps: number): void {
    const eid = this.view.eid;
    for (const q of this.host.players(this.view.systemNum)) {
      if (dhypot(Position.x[q] - Position.x[eid], Position.y[q] - Position.y[eid]) > reach) continue;
      const part = this.host.ships.ignite(q, Position.x[eid], Position.y[eid], dps * this.view.damage, 150, 1.2, eid);
      if (part >= 0) this.host.send(this.view.systemNum, { type: 'ignite', bodyId: q, part, ticks: 150 });
    }
  }

  /** Burn every pilot's ship the beam touches this tick */
  private burn(x0: number, y0: number, x1: number, y1: number, width: number, damage: number): void {
    const ships = this.host.ships;
    for (const p of this.host.players(this.view.systemNum)) {
      const s = ships.get(p);
      if (!s) continue;
      const h = ships.segmentHit(p, s, x0, y0, x1, y1, width / 2);
      if (h) ships.damagePartBy(p, h.part, damage, this.view.eid, { type: 'thermal', pen: 1.5 });
    }
  }

  // ---- Its stages ----

  /** The parts of a stage (PieceDef `stage`) */
  private ofStage(st: number): number[] {
    return this.ship.blueprint.parts.flatMap((_, i) => (stageOf(this.host.ships.catalog, this.ship, i) === st ? [i] : []));
  }

  private skeleton(i: number): boolean {
    return !!this.host.ships.catalog.pieces.get(this.ship.blueprint.parts[i].piece)?.skeleton;
  }

  /** Each side's pair together, outermost (from its own core) first, its core and the ring round it last */
  private outermostFirst(parts: number[]): number[][] {
    const ship = this.ship, ids = ship.blueprint.parts.map((p) => p.piece.replace('pyreclast_', ''));
    const geo = this.host.ships.geometry(ship);
    const core = ids.indexOf('core'), c = geo[core]?.centroid ?? ship.derived.com;
    const groups = new Map<string, number[]>();
    for (const i of parts) { const k = ids[i].replace(/_[lr]$/, ''); groups.set(k, [...(groups.get(k) ?? []), i]); }
    const rank = (k: string) => (k === 'core' || k === 's3_core' ? 2 : /^heart_\d$/.test(k) ? 1 : 0);
    const far = (g: number[]) => Math.max(...g.flatMap((i) => geo[i].polygon.map(([x, y]) => dhypot(x - c[0], y - c[1]))));
    return [...groups.entries()].sort(([ka, a], [kb, b]) => rank(ka) - rank(kb) || far(b) - far(a)).map(([, g]) => g);
  }

  /** How whole it is: each stage an equal share (stages.ts stagedIntegrity) */
  integrity(): number {
    return this.ship ? stagedIntegrity(this.host.ships.catalog, this.ship) ?? 1 : 1;
  }

  invulnerable(): boolean {
    return this.blows.length > 0;
  }

  /** Between its stages: when the one it's fighting with has nothing left standing, it blows it away (the last: it dies) */
  private shedding(now: number): void {
    if (this.blows.length) {
      while (this.blows.length && this.blows[0].at <= now) this.blows.shift()!.run();
      return;
    }
    const st = currentStage(this.host.ships.catalog, this.ship);
    if (this.stage === 1 && st !== 1) this.blowWings(now);
    else if (this.stage === 2 && st !== 2) this.blowBody(now);
    else if (this.stage === 3 && st !== 3 && !this.dying) this.die(now);
  }

  /** A stage beaten: whatever it was doing stops (what it had swelling, its drones, its vents) */
  private stop(): void {
    this.move = null;
    this.step = 0;
    this.swelling = [];
    this.ventUntil = -1;
    this.host.mobs?.clear(this.view.systemNum, this.view.eid);
    this.drones.clear();
  }

  /** Where a part is in the world */
  private at(i: number): { x: number; y: number } {
    const g = this.host.ships.geometry(this.ship)[i].centroid, me = pose(this.view.eid), cs = this.host.ships.tuning.cellSize;
    const lx = (g[0] - this.ship.derived.com[0]) * cs, ly = (g[1] - this.ship.derived.com[1]) * cs, c = dcos(me.angle), s = dsin(me.angle);
    return { x: me.x + lx * c - ly * s, y: me.y + lx * s + ly * c };
  }

  private boom(i: number, radius: number): void {
    const p = this.at(i);
    this.host.send(this.view.systemNum, { type: 'detonation', kind: 'eruption', x: Math.round(p.x), y: Math.round(p.y), radius });
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

  /** Shed what's left of these (as built: it isn't damage); flung, thrown out from its middle (`whole`: together, else each on its own), crumbling within `crumble` ticks */
  private drop(parts: number[], fling = 0, whole = false, crumble = 0, clusters = false): void {
    const live = parts.filter((i) => this.ship.derived.alive[i]);
    if (!live.length) return;
    // (all of it only to be seen: a boss's debris is scenery, not more bodies in the fight; `clusters`: a few great chunks by where they lie)
    const groups = clusters ? this.sectors(live) : fling && !whole ? live.map((i) => [i]) : [live];
    this.host.ships.shed(this.view.eid, groups, fling, crumble, true);
    const s = this.host.ships.get(this.view.eid);
    if (s) this.ship = s;
  }

  /**
   * Its carapace gone: it stops (nothing hurts it), and each wing's skeleton is blown apart where its plates were
   * (bossBlow: what was under each plate, one after another, outermost first, side about), then the wings go
   */
  private blowWings(now: number): void {
    this.stage = 2;
    this.stop();
    const geo = this.host.ships.geometry(this.ship);
    const skel = this.ofStage(1).filter((i) => this.skeleton(i));
    const plates = this.ofStage(1).filter((i) => !this.skeleton(i) && skel.some((k) => geo[k].convex.some((c) => pointInConvex(c, geo[i].centroid[0], geo[i].centroid[1]))));
    const order = this.outermostFirst(plates).flat();
    let t = now + BLOW_PAUSE;
    for (const i of order) {
      this.blows.push({ at: t, run: () => { this.host.send(this.view.systemNum, { type: 'bossBlow', bodyId: this.view.eid, part: i }); this.boom(i, 220); } });
      t += WING_GAP;
    }
    this.blows.push({ at: t, run: () => { for (const k of skel) this.boom(k, 520); this.drop(this.ofStage(1), BLOW_FLING, true, BLOW_CRUMBLE); } });
    this.blows.push({ at: t + BLOW_PAUSE, run: () => {} });
  }

  /** Its body wrecked: it stops (nothing hurts it), and its body blows apart, piece by piece, outermost first, its core last: its heart bared */
  private blowBody(now: number): void {
    this.stage = 3;
    this.stop();
    let t = now + BLOW_PAUSE;
    for (const g of this.outermostFirst(this.ofStage(2))) {
      this.blows.push({ at: t, run: () => { this.boom(g[0], g.length > 1 ? 300 : 220); this.drop(g, BLOW_FLING, true, BLOW_CRUMBLE); } });
      t += BODY_GAP;
    }
    this.blows.push({ at: t + BLOW_PAUSE, run: () => {} });
  }

  /** Its heart's round all wrecked: it shudders (nothing hurts it), bursts flickering across it, then every piece blows apart at once */
  private die(now: number): void {
    this.dying = true;
    this.stop();
    const round = this.ofStage(3).filter((i) => deciding(this.host.ships.catalog, this.ship, i));
    for (let t = 6; t < DEATH_SHUDDER; t += 6) {
      const i = round[Math.floor(this.host.rng() * round.length)];
      this.blows.push({ at: now + t, run: () => { if (this.ship.derived.alive[i]) this.boom(i, 120 + t * 2); } });
    }
    this.blows.push({ at: now + DEATH_SHUDDER, run: () => this.burst() });
  }

  /** Every piece of it blows apart at once (the core with them: it's destroyed) */
  private burst(): void {
    const all = this.ship.blueprint.parts.flatMap((_, i) => (this.ship.derived.alive[i] ? [i] : []));
    const core = this.core();
    if (core >= 0) this.boom(core, 1100);
    for (const i of all) if (deciding(this.host.ships.catalog, this.ship, i) && this.host.rng() < 0.5) this.boom(i, 260);
    this.drop(all, DEATH_FLING, false, DEATH_CRUMBLE, true);
  }

  /**
   * (dev) Its fight moved on `n` steps at once: its first stage's parts shot off one at a time (its carapace's plates
   * in SHED order, left then right, then what else is out on its wings, outermost first), then its wings blown away,
   * then its body's pieces (outermost first) wrecked one at a time, then blown away, then its heart's round wrecked a
   * piece at a time (its core last), then it blows apart. (Stop just short of a stage's end and the next tick it blows
   * that stage away itself, as in a fight)
   */
  forceShed(n: number): void {
    const named = SHED.flatMap((name) => (['l', 'r'] as const).map((side) => this.ship.blueprint.parts.findIndex((p) => p.piece === `pyreclast_${name}_${side}`))).filter((i) => i >= 0);
    const plates = [...named, ...this.outermostFirst(this.ofStage(1).filter((i) => !this.skeleton(i) && !named.includes(i))).flat()];
    const body = this.outermostFirst(this.ofStage(2));
    const round = this.outermostFirst(this.ofStage(3).filter((i) => deciding(this.host.ships.catalog, this.ship, i)));
    const wreck = (g: number[]) => () => { for (const i of g) if (this.ship.hp[i] > RUIN_HP) { this.ship.hp[i] = RUIN_HP; this.ship.dirty = true; } };
    const steps: (() => void)[] = [
      // (shot off over the minutes a fight takes, they'd be gone by its next stage: here, they crumble quickly too)
      ...plates.map((i) => () => this.drop([i], 0, false, BLOW_CRUMBLE)),
      () => { this.stage = 2; this.stop(); this.drop(this.ofStage(1), BLOW_FLING, true, BLOW_CRUMBLE); },
      ...body.map(wreck),
      () => { this.stage = 3; this.stop(); this.drop(this.ofStage(2), BLOW_FLING, true, BLOW_CRUMBLE); },
      ...round.map(wreck),
      () => { this.dying = true; this.stop(); this.burst(); },
    ];
    this.blows = [];
    for (; this.forced < Math.min(n, steps.length); this.forced++) steps[this.forced]();
  }
}
