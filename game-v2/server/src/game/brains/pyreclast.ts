/**
 * The Pyreclast (its cavern under Ashfall): a hulk the size of a station, the meta boss (docs/bosses/rework-2026-11.md
 * sections 5, 6 and 15). Three stages (staged.ts), each an attack phase: its signature moves chained back to back (a
 * short beat between them), then one short window (fightRules.ts: x2 up to a cap, a crack if the cap fills early; its
 * first 1 s a rest), then the phase again; nothing scaled by how many pilots there are. Every move has a light tell
 * (always the same one) and one dodge rule that always works. Between moves and in its window it keeps up a light
 * threat (`harassShot`: a glint and one fast spark at where you were), and pilots draw personal attacks of their own.
 *
 * Its limbs (PieceDef `limb`: armour 5 against its body's 3, never what a stage is beaten by) each work an attack:
 * break one and that attack weakens or goes (a turret one fewer fan, both scythes no sweep...).
 *
 * Stage one, the fortress (carapace and wings): slow, holding off. Phase: barrage, broadside, scythe.
 *   barrage      its wing turrets glow two at a time from opposite sides, clockwise: each throws a fan of three slow
 *                magma balls at where you ARE, the fans crossing on you. Rule: keep moving sideways
 *   broadside    it rolls side-on, that wing's turrets swing together and red lanes are drawn; fast shells only down
 *                the lanes; then it follows you round a little and fires a second salvo. Rule: get off that side, over
 *                its nose or tail
 *   scythe       a scythe's root glows and the blade draws back: it sweeps that side from 900 to 3,400 off its hull,
 *                nose to tail and back. Rule: get in close
 * Stage two, the hunter (its body): lighter, closer, its vents burning anything near them (always). Phase: mortar,
 * dash, lance, mortar.
 *   mortar       its mortar beds thump twice: a lane of shells along your line of flight, walls either side and a cap
 *                ahead. Rule: reverse out the way you came
 *   dash         its coils crackle; five dashes round you, each streaked 0.9 s before; the last overshoots. Rule: never
 *                sit on a streak
 *   lance        the prow lance hums and draws a line, burns down it, sweeps across its front towards the side it
 *                first glowed on, and straight back. Rule: get behind it
 * Stage three, the heart: small and quick. Phase: crystal, ring, swarm, then its vent (its window).
 *   crystal      (it darts once first) seven beams in a set order, each a white line 0.9 s before. Rule: never sit on a
 *                white line
 *   ring         side-on to you, its core flares twice: five rings of fast sparks out to the vault's walls, the two
 *                gaps always at its nose and tail as it turns. Rule: stay on its nose-to-tail line
 *   swarm        a hiss, its seams glow: eight seekers in two waves, shared among pilots. Rule: turn hard across them
 *   vent         it goes still and its vents blaze: its window, and anything within 700 of a vent burns. Rule: stay
 *                out of the heat, or wear heat plating. Its vents can't be broken while open
 *
 * Its window is drawn by clients from the window alone (BossFx: bosses.json `exposed`). Personal attacks (one pilot
 * each, pure luck a beat; held only in a window's rest beat and a stagger): magma lob, ember drone, flak burst (stage
 * one), lob and synapse mark (two), spark fan and lob (three); each from a limb, so a broken limb takes it out of the pool.
 */

import {
  Position, Velocity, datan2, dcos, dhypot, dsin, windowOpen, wantAim, wantDrive, wantFace, wantFly, wantHold,
  type PersonalRules, type WindowSpec,
} from '@space-game/common';
import { bodyFrame, lead, pose, wrap } from './kit.js';
import type { BrainHost } from './kit.js';
import { StagedBrain, type Move } from './staged.js';

const P = (name: string) => `pyreclast_${name}`;

/**
 * Its attack phases' windows (docs section 15), by stage: one a phase, 5 s for its fortress and its hunter, and 6 s
 * for its heart, whose window is its vents blazing (VENT_W)
 */
export const PYRECLAST_EXPOSURE: WindowSpec[] = [{ ticks: 300, cap: 4200 }, { ticks: 300, cap: 4200 }, { ticks: 360, cap: 5400 }];
const VENT_W = PYRECLAST_EXPOSURE[2];
/** Its signature moves (what counts as one: fightRules.ts), each with its stage's window */
export const PYRECLAST_SIGNATURE: Record<string, WindowSpec> = {
  barrage: PYRECLAST_EXPOSURE[0], broadside: PYRECLAST_EXPOSURE[0], scythe: PYRECLAST_EXPOSURE[0],
  mortar: PYRECLAST_EXPOSURE[1], dash: PYRECLAST_EXPOSURE[1], lance: PYRECLAST_EXPOSURE[1],
  crystal: VENT_W, ring: VENT_W, swarm: VENT_W, vent: VENT_W,
};
/** Its phases: the moves chained in order (the heart's ends in its vent: its window), by stage */
export const PYRECLAST_LOOP = [['barrage', 'broadside', 'scythe'], ['mortar', 'dash', 'lance', 'mortar'], ['crystal', 'ring', 'swarm', 'vent']];
/** Personal attacks by stage (docs 5.4): a quarter chance a beat each */
export const PYRECLAST_PERSONAL: PersonalRules = { beat: 120, chance: 0.25, ticks: 240, pool: [['lob', 'ember', 'flak'], ['lob', 'synapse'], ['spark', 'lob']] };
/** The beat between two chained moves, and its rest after a window (ticks), by stage: shorter each stage */
const CHAIN = [30, 24, 18], REST = [30, 24, 18];
/** Its light threat between moves and in its windows: a harassing shot every this many ticks, by stage */
const HARASS = [90, 80, 70];

/** Shots you dodge by moving across them fly at most this fast (world units a tick: level 30 ships make 25-30) */
const SLOW = 16;
/** What each attack bites (x the boss's damage scale): a shot's (x its kind's damage), a strike's or a beam's a tick */
const BITE = {
  barrage: 3, broadside: 4, scythe: 450, mortar: 300, lance: 24, crystal: 18, ring: 2.5, swarm: 2.6,
  lob: 430, lobPool: 18, ember: 4, flak: 160, synapse: 260, spark: 3,
};
/** Heat (dps, x the boss's damage scale): its body's vents always (stage two), its heart's open (the vent window) */
const HEAT_S2 = 28, HEAT_OPEN = 57, HEAT_REACH = 700;
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

export class PyreclastBrain extends StagedBrain {
  /** Turrets' magma swelling, then hurled (at where the target is then: never ahead) */
  private swelling: { part: number; at: number; fan: number; bite: number; aim: number }[] = [];
  /** Its harassing sparks due (from the part that glinted, at where its pilot was then) */
  private glints: { part: number; x: number; y: number; at: number }[] = [];
  /** Ground left burning by magma lobs */
  private pools: { x: number; y: number; next: number; until: number }[] = [];
  /** Its heart's vents, held whole while they're open (they can't be broken venting), and when the next heat pulse is */
  private ventHp = new Map<number, number>();
  private nextHeat = 0;
  private nextVentLook = 0;
  /** The last signature move done (whose window is running), and the heading it holds in that window */
  private lastMove = '';
  private windowAt = -1;
  private windowFace = 0;

  constructor(host: BrainHost) {
    super(host, {
      loop: PYRECLAST_LOOP, rest: REST, haste: [1, 1, 1], chain: CHAIN, harass: HARASS,
      signature: PYRECLAST_SIGNATURE, exposure: PYRECLAST_EXPOSURE, personal: PYRECLAST_PERSONAL,
    }, 'pyreclast');
  }

  protected make(id: string): Move | null {
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

  protected personalMove(name: string, target: number, seed: number): Move | null {
    switch (name) {
      case 'lob': { const from = this.lobFrom(target); return from >= 0 ? this.lob(target, from) : null; }
      case 'ember': { const bay = this.sideOf(this.working('brood_bay'), target); return bay >= 0 && this.host.mobs ? this.ember(target, bay) : null; }
      case 'flak': { const f = this.sideOf([this.named(P('wing_flak_l')), this.named(P('wing_flak_r'))].filter((i) => i >= 0), target); return f >= 0 ? this.flak(target, f, seed) : null; }
      case 'synapse': return this.named(P('spine')) >= 0 ? this.synapse(target) : null;
      case 'spark': return this.core() >= 0 ? this.sparkFan(target) : null;
    }
    return super.personalMove(name, target, seed);
  }

  /** (stage three) it darts to a new angle once, before its crystal */
  protected around(m: Move): Move {
    return this.stage === 3 && this.moveName === 'crystal' ? this.darting(m) : m;
  }

  private *darting(m: Move): Move {
    yield* this.dart(1000, 20, 30);
    yield* m;
  }

  protected onStop(): void {
    this.swelling = [];
    this.glints = [];
    this.pools = [];
    this.ventHp.clear();
    this.lastMove = '';
  }

  // ---- Its limbs ----

  /** Its wing turrets (stage one's magma cannons) still working */
  private wingGuns(): number[] {
    return this.working('magma_cannon').filter((i) => this.ofStageOf(i) === 1);
  }

  /** Its scythes' roots still working */
  private roots(): number[] {
    return [this.named(P('scythe_root_l')), this.named(P('scythe_root_r'))].filter((i) => i >= 0);
  }

  /** The vents of the stage it's fighting (its body's two, or its heart's three) still working */
  private vents(): number[] {
    return this.working('heat_vent').filter((i) => this.ofStageOf(i) === this.stage);
  }

  private ofStageOf(i: number): number {
    return this.host.ships.catalog.pieces.get(this.ship.blueprint.parts[i].piece)?.stage ?? 0;
  }

  /** Its heart's core while it's on */
  private core(): number {
    const i = this.ship.blueprint.parts.findIndex((p) => p.piece === P('s3_core'));
    return i >= 0 && this.ship.derived.alive[i] ? i : -1;
  }

  /** Of these parts, the one on a pilot's side of it (the nearest: -1 none) */
  private sideOf(parts: number[], target: number): number {
    let best = -1, bd = Infinity;
    for (const i of parts) {
      const m = this.mount(i), d = dhypot(Position.x[target] - m.x, Position.y[target] - m.y);
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

  /**
   * It turns side-on to its target, `side` (+1: its target off its left as it counts, -1 its right) towards it, following
   * the target as it turns (at most ROLL ticks); returns the heading it settled on, held from there
   */
  private *roll(side: number, most = ROLL): Generator<void, number, void> {
    const eid = this.view.eid, t = this.target;
    let heading = pose(eid).angle;
    for (let i = 0; i < most && t >= 0; i++) {
      const me = pose(eid);
      // (re-aimed every ROLL_EVERY ticks, not every tick: each new heading is a want, a decision on the wire)
      if (i % ROLL_EVERY === 0) heading = datan2(Position.y[t] - me.y, Position.x[t] - me.x) - side * Math.PI / 2;
      if (i >= 12 && Math.abs(wrap(me.angle - heading)) < 0.08) break;
      this.want = wantFace(heading);
      yield;
    }
    return heading;
  }

  // ---- Stage one: the fortress ----

  /** A ball of magma swelling on a turret (the turret glowing: clients draw it), hurled `grow` ticks on at where its target is then */
  private swell(part: number, grow: number, fan: number, bite: number, aim: number): void {
    const at = bodyFrame(this.host, this.view.eid, this.ship, part);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'magma', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 70, ticks: grow });
    this.swelling.push({ part, at: this.host.tick() + grow, fan, bite, aim });
  }

  /** Magma due now is hurled (slow: tuning.json magma, SLOW): a fan at where its target is (never where it's going) */
  private hurl(now: number): void {
    for (let i = this.swelling.length - 1; i >= 0; i--) {
      const s = this.swelling[i];
      if (now < s.at) continue;
      this.swelling.splice(i, 1);
      const t = s.aim;
      if (t < 0 || !this.ship.derived.alive[s.part] || !this.host.ships.get(t)) continue;
      const m = this.mount(s.part), a = datan2(Position.y[t] - m.y, Position.x[t] - m.x);
      for (let k = 0; k < s.fan; k++) {
        const ak = a + (s.fan > 1 ? (k / (s.fan - 1) - 0.5) * 0.36 : 0);
        this.host.fire(this.view.eid, 'magma', m.x + dcos(ak) * 50, m.y + dsin(ak) * 50, ak, this.view.damage * s.bite);
      }
    }
  }

  /**
   * Its wing turrets clockwise, two at once from opposite sides (their fans cross on you), each a fan of three slow
   * balls at where you are; then the other two, a beat later
   */
  private *barrage(): Move {
    const order = this.clockwise(this.wingGuns()), grow = 66, gap = 24, t = this.target, half = Math.ceil(order.length / 2);
    for (let k = 0; k < half; k++) {
      for (const part of [order[k], order[k + half]]) if (part !== undefined && this.ship.derived.alive[part]) this.swell(part, grow, 3, BITE.barrage, t);
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
    const t = this.target, eid = this.view.eid;
    if (t < 0) return;
    // (the side with turrets on it, the target's if it has them)
    const guns = this.wingGuns(), local = (i: number) => bodyFrame(this.host, eid, this.ship, i);
    const me0 = pose(eid), toT = datan2(Position.y[t] - me0.y, Position.x[t] - me0.x);
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
      for (const l of lanes) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'lane', bodyId: eid, x: l.x, y: l.y, angle: rel, length: 3600, width: 200, ticks: warn });
      for (let i = 0; i < warn; i++) { this.want = wantFace(heading); yield; }
      const me = pose(eid), c = dcos(me.angle), s = dsin(me.angle), a = me.angle + rel;
      for (let shot = 0; shot < (salvo ? 2 : 3); shot++) {
        for (const l of lanes) {
          if (!this.ship.derived.alive[l.part]) continue;
          const x = me.x + l.x * c - l.y * s, y = me.y + l.x * s + l.y * c;
          this.host.fire(eid, 'magma', x + dcos(a) * 60, y + dsin(a) * 60, a, this.view.damage * BITE.broadside);
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
    const t = this.target, eid = this.view.eid;
    if (t < 0) return;
    const roots = this.roots(), local = (i: number) => bodyFrame(this.host, eid, this.ship, i);
    const me0 = pose(eid), toT = datan2(Position.y[t] - me0.y, Position.x[t] - me0.x);
    let side = Math.sign(wrap(toT - me0.angle)) || 1;
    if (!roots.some((r) => Math.sign(local(r).y) === side)) side = -side;
    const root = roots.find((r) => Math.sign(local(r).y) === side)!;
    // Side-on, the scythe's side to its target; then it draws back
    const heading = yield* this.roll(side), warn = 72, at = local(root), r = this.ship.derived.radius;
    this.host.launchFx(this.view.systemNum, this.mount(root).x, this.mount(root).y);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'scythe', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), radius: 160, ticks: warn });
    // (Where it starts: off its nose on that side; faint, its reach can't be read off the hull)
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'scythe', bodyId: eid, x: 0, y: 0, angle: side * 0.25, length: Math.round(r + SCYTHE_FAR), width: 120, ticks: warn });
    for (let i = 0; i < warn; i++) { this.want = wantFace(heading); yield; }
    // Nose to tail, a beat, and back tail to nose (each pass cuts a pilot once)
    for (let pass = 0; pass < 2; pass++) {
      if (this.named(this.ship.blueprint.parts[root].piece) < 0) return;
      if (pass) for (let i = 0; i < SCYTHE_BEAT; i++) { this.want = wantFace(heading); yield; }
      const sweep = 44, hit = new Set<number>(), from = pass ? Math.PI - 0.25 : 0.25, to = pass ? 0.25 : Math.PI - 0.25;
      // (the blade, drawn over its reach only: client BossFx 'scythe')
      this.host.send(this.view.systemNum, { type: 'bossBeam', kind: 'scythe', bodyId: eid, x: 0, y: 0, a0: side * from, a1: side * to, ticks: sweep, length: Math.round(r + SCYTHE_FAR), width: 220 });
      for (let i = 0; i <= sweep; i++) {
        // (from just off its nose round that side to just off its tail, and back)
        const me = pose(eid), a = me.angle + side * (from + (to - from) * (i / sweep));
        const ux = dcos(a), uy = dsin(a);

        for (const q of this.host.players(this.view.systemNum)) {
          if (hit.has(q)) continue;
          const dx = Position.x[q] - me.x, dy = Position.y[q] - me.y, along = dx * ux + dy * uy, across = Math.abs(dx * uy - dy * ux);
          if (along < r + SCYTHE_NEAR || along > r + SCYTHE_FAR || across > 180) continue;
          const ship = this.host.ships.get(q);
          if (!ship || this.walled(me.x, me.y, q)) continue;
          const h = this.host.ships.segmentHit(q, ship, me.x + ux * (r + SCYTHE_NEAR), me.y + uy * (r + SCYTHE_NEAR), me.x + ux * (r + SCYTHE_FAR), me.y + uy * (r + SCYTHE_FAR), 180);
          if (!h) continue;
          hit.add(q);
          this.host.ships.damagePartBy(q, h.part, BITE.scythe * this.view.damage, eid, { type: 'kinetic', pen: 3 });
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
    const mortars = this.working('magma_mortar'), t = this.target, me = pose(this.view.eid);
    if (t < 0) return;
    // Its beds thump twice and puff ash
    for (let k = 0; k < 2; k++) {
      for (const m of this.working('magma_mortar')) { const w = this.mount(m); this.host.launchFx(this.view.systemNum, w.x, w.y); }
      for (let i = 0; i < 24; i++) { this.want = wantAim(); yield; }
    }
    const tx = Position.x[t], ty = Position.y[t], d = dhypot(tx - me.x, ty - me.y) || 1;
    const tv = dhypot(Velocity.x[t], Velocity.y[t]);
    const [ux, uy] = tv > 4 ? [Velocity.x[t] / tv, Velocity.y[t] / tv] : [(tx - me.x) / d, (ty - me.y) / d];
    const nx = -uy, ny = ux, lane = 420, radius = 200, warn = 72;
    const reach = Math.max(1100, tv * warn);
    const spots: [number, number][] = [];
    for (const side of [-1, 1]) for (let along = -600; along <= reach; along += 360) spots.push([tx + ux * along + nx * side * lane, ty + uy * along + ny * side * lane]);
    if (mortars.length > 1) for (let across = -lane + 210; across <= lane - 210; across += 210) spots.push([tx + ux * (reach + 160) + nx * across, ty + uy * (reach + 160) + ny * across]);
    spots.sort((a, b) => dhypot(a[0] - me.x, a[1] - me.y) - dhypot(b[0] - me.x, b[1] - me.y));
    const now = this.host.tick();
    const due: Due[] = spots.map(([x, y], i) => {
      const ticks = warn + Math.floor(i / 2) * 3;
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'impact', x: Math.round(x), y: Math.round(y), radius, ticks });
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
      const last = k === dashes - 1, me = pose(this.view.eid);
      const dx = Position.x[t] - me.x, dy = Position.y[t] - me.y, d = dhypot(dx, dy) || 1;
      // Across the line to the target, alternating, pulling back to its range; the last one through
      this.side = this.host.rng() < 0.75 ? -this.side : this.side;
      const ux = dx / d, uy = dy / d, range = this.flight.range[1];
      const radial = last ? 0.6 : Math.max(-0.9, Math.min(0.9, (d - range) / range));
      const l0 = dhypot(-uy * this.side + ux * radial, ux * this.side + uy * radial) || 1;
      const [vx, vy] = this.homeward((-uy * this.side + ux * radial) / l0, (ux * this.side + uy * radial) / l0, last ? 2200 : 1500);
      const dir = datan2(vy, vx), wind = 54;
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'dash', bodyId: this.view.eid, x: 0, y: 0, angle: wrap(dir - me.angle), length: last ? 2400 : 1700, width: 160, ticks: wind });
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
    const lance = this.named(P('lance')), eid = this.view.eid;
    if (lance < 0) return;
    yield* this.hold(12);
    const swing = this.host.rng() < 0.5 ? 1 : -1, a0 = -0.75 * swing, a1 = 0.75 * swing;
    const at = bodyFrame(this.host, eid, this.ship, lance), length = 14000, width = 90, warn = 72;
    const heading = pose(eid).angle;
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'lance', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: a0, length, width, ticks: warn });
    for (let i = 0; i < warn; i++) { this.want = wantFace(heading); yield; }
    const ticks = 80;
    for (let i = 0; i < ticks * 2; i++) {
      if (this.named(P('lance')) < 0) return;
      if (i === 0 || i === ticks) this.host.send(this.view.systemNum, { type: 'bossBeam', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), a0: i ? a1 : a0, a1: i ? a0 : a1, ticks, length, width });
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
    const at = bodyFrame(this.host, this.view.eid, this.ship, this.core());
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind, bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: kind === 'seams' ? 420 : 260, ticks });
    for (let i = 0; i < ticks; i++) { this.want = want; yield; }
  }

  /** One spark out of its core (tuning.json heart_spark: 20 a tick, out to the vault's walls) */
  private spark(c: { x: number; y: number }, a: number, bite: number, off = 140): void {
    this.host.fire(this.view.eid, 'heart_spark', c.x + dcos(a) * off, c.y + dsin(a) * off, a, this.view.damage * bite);
  }

  /** Seven beams from its crystal in a set order across its front, each a white line 0.9 s first */
  private *crystalBeams(): Move {
    const eid = this.view.eid;
    yield* this.hold(12);
    const heading = pose(eid).angle, warn = 54, gap = 15, burn = 22, length = 9000, width = 60;
    const end = (BEAMS.length - 1) * gap + warn + burn;
    for (let i = 0; i < end; i++) {
      const crystal = this.named(P('s3_mineral'));
      if (crystal < 0) return;
      const at = bodyFrame(this.host, eid, this.ship, crystal);
      BEAMS.forEach((k, n) => {
        const rel = k * BEAM_STEP, start = n * gap;
        if (i === start) this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'line', kind: 'crystal', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), angle: rel, length, width, ticks: warn });
        if (i === start + warn) this.host.send(this.view.systemNum, { type: 'bossBeam', kind: 'crystal', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), a0: rel, a1: rel, ticks: burn, length, width });
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
    const t = this.target, eid = this.view.eid;
    if (t < 0) return;
    let heading = yield* this.roll(this.host.rng() < 0.5 ? 1 : -1);
    const turn = this.host.rng() < 0.5 ? RING_TURN : -RING_TURN;
    yield* this.flare(36, wantFace(heading));
    yield* this.flare(36, wantFace(heading));
    const n = 28, gapW = 3;
    for (let r = 0; r < RINGS; r++) {
      if (this.core() < 0) return;
      const c = this.coreAt(), a0 = pose(eid).angle;
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
    const eid = this.view.eid, who = this.view.present?.length ? this.view.present : this.pilots(6000);
    if (!who.length) return;
    yield* this.flare(72, wantHold(), 'seams');
    const a0 = this.host.rng() * Math.PI * 2;
    for (let wave = 0; wave < 2; wave++) {
      if (this.core() < 0) return;
      const c = this.coreAt();
      for (let k = 0; k < 4; k++) {
        const j = wave * 4 + k, a = a0 + (k / 4) * Math.PI * 2 + wave * Math.PI / 4;
        this.host.fire(eid, 'heart_seeker', c.x + dcos(a) * 90, c.y + dsin(a) * 90, a, this.view.damage * BITE.swarm, { target: who[j % who.length] });
      }
      for (let i = 0; i < 36; i++) { this.want = wantFly(); yield; }
    }
  }

  /** Spent: it goes still and its vents blaze (the heat reaches HEAT_REACH round each); its window is the big one */
  private *ventOpen(): Move {
    const eid = this.view.eid, warn = 72;
    for (const v of this.vents()) {
      const at = bodyFrame(this.host, eid, this.ship, v), m = this.mount(v);
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'vent', bodyId: eid, x: Math.round(at.x), y: Math.round(at.y), radius: HEAT_REACH, ticks: warn + VENT_W.ticks });
      this.host.launchFx(this.view.systemNum, m.x, m.y);
    }
    for (let i = 0; i < warn; i++) { this.want = wantHold(); yield; }
  }

  // ---- Personal attacks (each aimed at one pilot; never sets the boss's want) ----

  /** A turret (or mortar, or vent) on your side thumps; a faint circle where you are: a ball of magma lands 1.3 s on, and the ground burns 3 s */
  private *lob(target: number, from: number): Move {
    const m = this.mount(from), x = Position.x[target], y = Position.y[target], radius = 240, fall = 78;
    this.host.launchFx(this.view.systemNum, m.x, m.y);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'lob', x: Math.round(x), y: Math.round(y), radius, ticks: fall });
    for (let i = 0; i < fall; i++) yield;
    this.land([{ x, y, at: 0 }], radius, BITE.lob);
    const now = this.host.tick();
    this.pools.push({ x, y, next: now + 20, until: now + 180 });
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'embers', x: Math.round(x), y: Math.round(y), radius: 200, ticks: 180 });
  }

  /** A bay on your side glows: one ember drone hunts you (keep moving, or shoot it) */
  private *ember(target: number, bay: number): Move {
    const m = this.mount(bay);
    this.host.launchFx(this.view.systemNum, m.x, m.y);
    for (let i = 0; i < 40; i++) yield;
    const mb = this.mount(bay), a = datan2(Position.y[target] - mb.y, Position.x[target] - mb.x);
    const d = this.host.mobs!.spawn('ember_drone', this.view.systemNum, mb.x + dcos(a) * 40, mb.y + dsin(a) * 40, a, 13, this.view.eid, this.view.damage * BITE.ember);
    if (d >= 0) this.drones.add(d);
  }

  /** Its wing flak swings to you with a click: five bursts round where you are (move off the spot) */
  private *flak(target: number, gun: number, seed: number): Move {
    const m = this.mount(gun), x = Position.x[target], y = Position.y[target], radius = 170, fuse = 60;
    this.host.launchFx(this.view.systemNum, m.x, m.y);
    const now = this.host.tick(), due: Due[] = [];
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + (seed % 628) / 100, r = k === 0 ? 0 : 260;
      const bx = x + (k === 0 ? 0 : dcos(a) * r), by = y + (k === 0 ? 0 : dsin(a) * r);
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'flak', x: Math.round(bx), y: Math.round(by), radius, ticks: fuse + k * 4 });
      due.push({ x: bx, y: by, at: now + fuse + k * 4 });
    }
    while (due.length) { this.land(due, radius, BITE.flak / 3); yield; }
  }

  /** A crackle along its wires: three marks on your line ahead, struck 0.8 s later (change direction) */
  private *synapse(target: number): Move {
    const fuse = 48, radius = 190, now = this.host.tick(), due: Due[] = [];
    for (const ahead of [20, 40, 60]) {
      const { x, y } = lead(target, ahead + fuse);
      this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'synapse', x: Math.round(x), y: Math.round(y), radius, ticks: fuse });
      due.push({ x, y, at: now + fuse });
    }
    for (let i = 0; i < fuse; i++) yield;
    const me = pose(this.view.eid);
    for (const d of due) this.host.send(this.view.systemNum, { type: 'detonation', kind: 'synapse', x: Math.round(d.x), y: Math.round(d.y), radius, from: [Math.round(me.x), Math.round(me.y)] });
    this.land(due.map((d) => ({ ...d, at: 0 })), radius, BITE.synapse, '');
  }

  /** A spark of light at its core facing you: a fan of three sparks at where you are (sidestep) */
  private *sparkFan(target: number): Move {
    const at = bodyFrame(this.host, this.view.eid, this.ship, this.core());
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'spark', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 120, ticks: 54 });
    for (let i = 0; i < 54; i++) yield;
    if (this.core() < 0) return;
    const c = this.coreAt(), aim = datan2(Position.y[target] - c.y, Position.x[target] - c.x);
    for (let k = 0; k < 3; k++) this.spark(c, aim + (k - 1) * 0.14, BITE.spark);
  }

  // ---- Always on ----

  // ---- Its light threat (staged.ts harass): between moves and in its window ----

  /**
   * One harassing shot at a pilot: the turret (stage one), horn gun (two) or core (three) on their side glints (the
   * glint: an aimed shot, as the Mother's), and spits one fast spark at where they were (no splash, no shove). Sidestep
   */
  protected harassShot(t: number): boolean {
    const from = this.stage === 3 ? this.core() : this.sideOf(this.stage === 1 ? this.wingGuns() : this.working('magma_cannon').filter((i) => this.ofStageOf(i) === 2), t);
    if (from < 0) return false;
    const at = bodyFrame(this.host, this.view.eid, this.ship, from);
    this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'glint', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: 90, ticks: GLINT });
    this.glints.push({ part: from, x: Position.x[t], y: Position.y[t], at: this.host.tick() + GLINT });
    return true;
  }

  /** Its harassing sparks due: one from the part that glinted, at where the pilot was then */
  private throwGlints(now: number): void {
    for (let k = this.glints.length - 1; k >= 0; k--) {
      const g = this.glints[k];
      if (now < g.at) continue;
      this.glints.splice(k, 1);
      if (!this.ship.derived.alive[g.part]) continue;
      const c = this.mount(g.part);
      this.spark(c, datan2(g.y - c.y, g.x - c.x), BITE.spark, 60);
    }
  }

  protected passives(now: number): void {
    this.hurl(now);
    this.throwGlints(now);
    this.burnPools(now);
    this.lockVents(now);
    const w = this.fight.window;
    // In its window it shows its recovery: it holds where it is, as it faced when it opened (a crack's stagger: staged.ts holds it too)
    if (!this.move && w && now >= w.at && now < w.at + w.ticks) {
      if (this.windowAt !== w.at) { this.windowAt = w.at; this.windowFace = pose(this.view.eid).angle; }
      this.want = wantFace(this.windowFace);
    }
    if (now < this.nextHeat) return;
    this.nextHeat = now + 30;
    if (this.stage === 2) {
      // Its body's vents burn anything near them, always
      const vents = this.vents();
      for (const v of vents) this.heat(v, HEAT_S2);
      if (vents.length && now >= this.nextVentLook) {
        this.nextVentLook = now + 600;
        for (const v of vents) { const at = bodyFrame(this.host, this.view.eid, this.ship, v); this.host.send(this.view.systemNum, { type: 'bossTelegraph', shape: 'circle', kind: 'vent', bodyId: this.view.eid, x: Math.round(at.x), y: Math.round(at.y), radius: HEAT_REACH, ticks: 600 }); }
      }
    } else if (this.stage === 3 && this.venting(now)) {
      for (const v of this.vents()) this.heat(v, HEAT_OPEN);
    }
  }

  /** Its vent window open (the heart's vents blazing) */
  private venting(now: number): boolean {
    return this.lastMove === 'vent' && windowOpen(this.fight.window, now);
  }

  /** Every pilot within HEAT_REACH of a vent catches fire (thermal: heat plating shrugs most of it off) */
  private heat(vent: number, dps: number): void {
    const m = this.mount(vent);
    for (const q of this.host.players(this.view.systemNum)) {
      if (dhypot(Position.x[q] - m.x, Position.y[q] - m.y) > HEAT_REACH || this.walled(m.x, m.y, q)) continue;
      const part = this.host.ships.ignite(q, m.x, m.y, dps * this.view.damage, 45, 1.2, this.view.eid, { type: 'thermal', pen: 3 });
      if (part >= 0) { this.host.send(this.view.systemNum, { type: 'ignite', bodyId: q, part, ticks: 45 }); this.host.hint?.(q, 'burning'); }
    }
  }

  /** Ground left burning by lobs hurts what's in it */
  private burnPools(now: number): void {
    for (let k = this.pools.length - 1; k >= 0; k--) {
      const p = this.pools[k];
      if (now >= p.until) { this.pools.splice(k, 1); continue; }
      if (now < p.next) continue;
      p.next = now + 20;
      this.land([{ x: p.x, y: p.y, at: 0 }], 200, BITE.lobPool, '');
    }
  }

  /** Its heart's vents can't be broken while they're open (shielded by their own heat): held whole until they close */
  private lockVents(now: number): void {
    if (!this.venting(now)) { if (this.ventHp.size) this.ventHp.clear(); return; }
    for (const v of this.vents()) {
      const was = this.ventHp.get(v);
      if (was === undefined) this.ventHp.set(v, this.ship.hp[v]);
      else if (this.ship.hp[v] < was) { this.ship.hp[v] = was; this.ship.rebuildHp[v] = was; }
    }
  }

  /** A signature move done: remember which (its window's look: the vent's heat) */
  orders(...args: Parameters<StagedBrain['orders']>): ReturnType<StagedBrain['orders']> {
    const before = this.moveName;
    const out = super.orders(...args);
    if (before && !this.moveName && this.fight.isSignature(before)) this.lastMove = before;
    return out;
  }

  idle(): boolean {
    return super.idle() && !this.swelling.length && !this.pools.length && !this.glints.length;
  }
}
