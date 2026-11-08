/**
 * Defenders: pilotless ships that keep to their course but shoot back (Ceres Haulers on their routes, an escorted
 * freighter). Each flies as its autopilot has it (GameServer trafficSystem, Operations' steer) and never turns to
 * fight; once something has really attacked it, its guns lock onto that attacker and fire only at it, only while it's
 * inside a gun's window and reach, led as an AI's are. Its crew tolerates strays: a ship's hits count as an attack only
 * once their damage, fading with a half-life of DEFEND_GRUDGE_HALF_TICKS, reaches DEFEND_GRUDGE_SHARE of the freighter's
 * whole HP (each attacker counted apart; bumps never count). A new attacker past that takes the lock over; the guns go
 * quiet DEFEND_QUIET_TICKS after the locked attacker's last hit, or at once when it's gone (dead, removed, docked,
 * another system).
 *
 * While shooting back it is flown by the enemy AI's pilot body with a HAUL order (common bodies/aiPilot.ts: the
 * autopilot's course and the AI's trigger, aiFires), through the same AiPilots as hostile packs: at a pilot, its body is
 * on, so the clients that run it step its course and its guns from the shared step (GunNet.pilotless lanes) with no fire
 * records; at anything else the rows fly it and its shots go as fire records, as a pack's do. Quiet, it has no orders
 * at all (the controller answers null): the autopilot flies it exactly as before.
 */

import { hasComponent, type IWorld } from 'bitecs';
import { Position, Velocity, Rotation, InSystem, Player, Dead, Radius, aiLoadout, AI_BEAM_REACH, orderHaul, simAimQ, dhypot, dpow, type ShipState, type WantRec, type AiLead } from '@space-game/common';
import type { ShipBridge, PilotOrders } from '../../ships/ShipBridge.js';
import type { AiPilots } from '../brains/aiPilot.js';

/** Quiet this long (ticks) after its attacker's last hit: 30 s */
export const DEFEND_QUIET_TICKS = 60 * 30;
/** A ship's damage to it counts as an attack once it reaches this share of the freighter's whole HP (a Ceres Hauler:
 *  about 100: three Pip shells fade away; six of them at once, two Hammer shells or one Spear don't) */
export const DEFEND_GRUDGE_SHARE = 0.0065;
/** ...that damage fading by half every this many ticks (4 s: hits more than about 8 s apart barely add up) */
export const DEFEND_GRUDGE_HALF_TICKS = 60 * 4;
/** Its crew's aim: off by up to this either way (a pirate's at accuracy 0.85: Enemies.fly) */
const AIM_ERR = (1 - 0.85) * 0.45;
/** Its course's point is sent again only once its autopilot's has moved this far (a station orbits: not a decision a tick) */
const COURSE_SLACK = 150;

/** What's left of a grudge after `ticks` (deterministic maths: detTrig.ts) */
const fade = (ticks: number) => dpow(0.5, ticks / DEFEND_GRUDGE_HALF_TICKS);

export interface DefenderHost {
  readonly world: IWorld;
  tick(): number;
  /** Docked (out of the fight; a ship in a station's ring still is in it: shoot a freighter there and it shoots back) */
  docked?(eid: number): boolean;
}

interface Defender {
  /** The ship record it was made a defender with (an id reused is another ship) */
  ship: ShipState | undefined;
  /** Who it's shooting back at (-1: nobody), and when they last hit it */
  attacker: number;
  lastHit: number;
  /** Each other ship's fading damage to it (not yet an attack), and when it was last topped up */
  grudges: Map<number, { dmg: number; at: number }>;
  /** Damage that makes an attack (DEFEND_GRUDGE_SHARE of its whole HP) */
  tolerance: number;
  /** Its guns' real reach, whether one lobs and its main gun's round (learnt once: common bodies/aiLead.ts aiLoadout) */
  reach?: number;
  lobs?: boolean;
  lead?: AiLead;
  /** Its course's point as its order carries it */
  course: { x: number; y: number; arrive: number } | null;
  seed: number;
  /** The last tick its body flew it, and whether its autopilot did on the last it didn't (else it held: CTL.hold, aim 0) */
  bodyAt: number;
  auto: boolean;
}

export class Defenders {
  private readonly list = new Map<number, Defender>();

  constructor(private readonly host: DefenderHost, private readonly ships: ShipBridge, private readonly pilots: AiPilots) {}

  /** Make a pilotless ship a defender (it keeps whatever autopilot it has) */
  add(eid: number): void {
    if (!this.ships.has(eid)) return;
    const ship = this.ships.get(eid)!;
    const d: Defender = {
      ship, attacker: -1, lastHit: -Infinity, grudges: new Map(), tolerance: DEFEND_GRUDGE_SHARE * ship.maxHp.reduce((a, h) => a + h, 0),
      course: null, seed: (eid * 97 + 31) & 255, bodyAt: -Infinity, auto: false,
    };
    this.list.set(eid, d);
    this.ships.setController(eid, (id, s) => this.fly(id, s));
    this.ships.watchHurt(eid, (source, dealt, tick) => this.hurt(eid, d, source, dealt, tick));
  }

  has(eid: number): boolean {
    return this.list.has(eid);
  }

  /** Who it's shooting back at (-1: nobody) */
  attackerOf(eid: number): number {
    return this.list.get(eid)?.attacker ?? -1;
  }

  /** Forget the ones gone (their bodies stop on every client running them) */
  tick(): void {
    for (const [eid, d] of this.list) if (!this.ships.has(eid) || this.ships.get(eid) !== d.ship) this.drop(eid);
  }

  private drop(eid: number): void {
    if (this.list.get(eid)?.ship === this.ships.get(eid)) this.ships.watchHurt(eid, null);
    this.list.delete(eid);
    this.pilots.forget(eid);
  }

  /** May it shoot back at `h`: a ship still here, in its system, alive, not docked, not another defender */
  private valid(eid: number, h: number): boolean {
    if (h < 0 || h === eid || this.list.has(h) || !this.ships.has(h)) return false;
    if (InSystem.systemId[h] !== InSystem.systemId[eid] || hasComponent(this.host.world, Dead, h)) return false;
    return !this.host.docked?.(h);
  }

  /** A hit with a source that isn't a bump (ShipBridge.watchHurt; a hazard's has none and never refreshes a lock) */
  private hurt(eid: number, d: Defender, source: number, dealt: number, tick: number): void {
    if (this.ships.get(eid) !== d.ship) return;
    if (source === d.attacker) { d.lastHit = tick; return; }
    const g = d.grudges.get(source);
    const dmg = (g ? g.dmg * fade(tick - g.at) : 0) + dealt;
    if (dmg < d.tolerance) {
      // (forgotten once faded to nothing much: the map stays as small as the ships hitting it)
      if (d.grudges.size > 8) for (const [k, v] of d.grudges) if (v.dmg * fade(tick - v.at) < 1) d.grudges.delete(k);
      d.grudges.set(source, { dmg, at: tick });
      return;
    }
    d.grudges.delete(source);
    if (this.valid(eid, source)) { d.attacker = source; d.lastHit = tick; }
  }

  private fly(eid: number, ship: ShipState): PilotOrders | null {
    const d = this.list.get(eid);
    if (!d || d.ship !== ship) return null;
    const now = this.host.tick();
    if (d.attacker >= 0 && (now - d.lastHit > DEFEND_QUIET_TICKS || !this.valid(eid, d.attacker))) {
      d.attacker = -1;
      this.pilots.forget(eid);
    }
    if (d.attacker < 0) { d.auto = !!this.ships.autopilotOf(eid); return null; }
    const t = d.attacker;
    if (d.reach === undefined) this.learn(d, ship);
    const ap = this.ships.autopilotOf(eid);
    if (!ap) d.course = null;
    else if (!d.course || d.course.arrive !== ap.arriveRadius || dhypot(ap.x - d.course.x, ap.y - d.course.y) > COURSE_SLACK) d.course = { x: ap.x, y: ap.y, arrive: ap.arriveRadius };
    const want: WantRec = orderHaul(d.course, d.reach ?? 0, AIM_ERR, d.seed, d.lobs, d.lead);
    const pose = (id: number) => ({ x: Position.x[id], y: Position.y[id], angle: Rotation.angle[id], vx: Velocity.x[id], vy: Velocity.y[id] });
    const tpose = { ...pose(t), r: this.ships.get(t)?.derived.radius ?? Radius.value[t] ?? 60 };
    // (Its body on while it shoots at a pilot, as a pack's is: brains/aiPilot.ts)
    const bodied = !this.ships.isPinned(eid) && hasComponent(this.host.world, Player, t);
    // (Its held heading is the aim it flew with last tick, as its replicas have it: its body's own, else its autopilot's
    // course on the aim grid (bridge/inputs.ts controllerInput), else none (held: aim 0))
    const held = this.ships.autopilotHeading(eid);
    const prev = d.bodyAt === now - 1 ? undefined : { q: d.auto && held !== undefined ? simAimQ(held) : 0, bits: 0 };
    d.bodyAt = now;
    const out = this.pilots.fly(eid, t, 1, want, pose(eid), tpose, null, bodied, prev);
    return this.pilots.orders(eid, out, out.fire, t);
  }

  /** Its guns' real reach (the longest), whether any lob and its lead, as Enemies' learnLoadout has a hostile's */
  private learn(d: Defender, ship: ShipState): void {
    const l = aiLoadout(this.ships.tuning, ship, AI_BEAM_REACH);
    d.reach = l.reach;
    d.lobs = l.lobs;
    d.lead = l.lead;
  }
}
