/**
 * Defenders: pilotless ships that keep to their course but shoot back (Ceres Haulers on their routes, an escorted
 * freighter). Each flies as its autopilot has it (GameServer trafficSystem, Operations' steer) and never turns to
 * fight; once something hurts it, its guns lock onto that attacker and fire only at it, only while it's inside a gun's
 * window and reach, led as an AI's are. A new attacker takes the lock over; the guns go quiet DEFEND_QUIET_TICKS after
 * the locked attacker's last hit, or at once when it's gone (dead, removed, docked, another system).
 *
 * While shooting back it is flown by the enemy AI's pilot body with a HAUL order (common bodies/aiPilot.ts: the
 * autopilot's course and the AI's trigger, aiFires), through the same AiPilots as hostile packs: at a pilot, its body is
 * on, so the clients that run it step its course and its guns from the shared step (GunNet.pilotless lanes) with no fire
 * records; at anything else the rows fly it and its shots go as fire records, as a pack's do. Quiet, it has no orders
 * at all (the controller answers null): the autopilot flies it exactly as before.
 */

import { hasComponent, type IWorld } from 'bitecs';
import { Position, Velocity, Rotation, InSystem, Player, Dead, Radius, partWeaponDef, endsAtAim, orderHaul, simAimQ, dhypot, type ShipState, type WantRec } from '@space-game/common';
import type { ShipBridge, PilotOrders } from '../../ships/ShipBridge.js';
import type { AiPilots } from '../brains/aiPilot.js';

/** Quiet this long (ticks) after its attacker's last hit: 30 s */
export const DEFEND_QUIET_TICKS = 60 * 30;
/** Its crew's aim: off by up to this either way (a pirate's at accuracy 0.85: Enemies.fly) */
const AIM_ERR = (1 - 0.85) * 0.45;
/** Its course's point is sent again only once its autopilot's has moved this far (a station orbits: not a decision a tick) */
const COURSE_SLACK = 150;
/** Beams open up from no further than this (Enemies' NPC_BEAM_REACH) */
const BEAM_REACH = 1600;

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
  /** The last damage tick it has looked at */
  seen: number;
  /** Its guns' real reach and whether one lobs (learnt once) */
  reach?: number;
  lobs?: boolean;
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
    this.list.set(eid, { ship: this.ships.get(eid), attacker: -1, lastHit: -Infinity, seen: this.ships.lastDamagedTick(eid), course: null, seed: (eid * 97 + 31) & 255, bodyAt: -Infinity, auto: false });
    this.ships.setController(eid, (id, ship) => this.fly(id, ship));
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
    this.list.delete(eid);
    this.pilots.forget(eid);
  }

  /** May it shoot back at `h`: a ship still here, in its system, alive, not docked, not another defender */
  private valid(eid: number, h: number): boolean {
    if (h < 0 || h === eid || this.list.has(h) || !this.ships.has(h)) return false;
    if (InSystem.systemId[h] !== InSystem.systemId[eid] || hasComponent(this.host.world, Dead, h)) return false;
    return !this.host.docked?.(h);
  }

  private fly(eid: number, ship: ShipState): PilotOrders | null {
    const d = this.list.get(eid);
    if (!d || d.ship !== ship) return null;
    const now = this.host.tick();
    // Hurt since it last looked: whoever did it has its guns now
    const at = this.ships.lastDamagedTick(eid);
    if (at > d.seen) {
      d.seen = at;
      const h = this.ships.lastHitter(eid);
      if (this.valid(eid, h)) { d.attacker = h; d.lastHit = at; }
    }
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
    const want: WantRec = orderHaul(d.course, d.reach ?? 0, AIM_ERR, d.seed, d.lobs);
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

  /** Its guns' real reach (the longest) and whether any lob, as Enemies' learnLoadout has a hostile's */
  private learn(d: Defender, ship: ShipState): void {
    let reach = 0, lobs = false;
    for (const w of ship.derived.weapons) {
      const def = partWeaponDef(this.ships.tuning, w.kind, ship.blueprint.parts[w.part], { model: w.model });
      const r = def.type === 'beam' ? Math.min(def.range ?? 800, BEAM_REACH) : (def.maxSpeed ?? def.speed ?? 30) * (def.life ?? 60);
      if (endsAtAim(def)) lobs = true;
      reach = Math.max(reach, r);
    }
    d.reach = reach;
    d.lobs = lobs;
  }
}
